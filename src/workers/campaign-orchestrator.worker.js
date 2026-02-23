import "../models/index.js";

import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignStep from "../models/campaign-step.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import Email from "../models/email.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";

import { getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { renderTemplate } from "../utils/template-renderer.js";
import { injectTracking } from "../utils/tracking-injector.js";
import { tryCompleteCampaign } from "../utils/campaign-completion.checker.js";
import crypto from "crypto";

import dayjs from "dayjs";

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "campaign-orchestrator",
      level,
      message,
      ...meta,
    }),
  );

async function ensureStepZero(campaign) {
  // Use findOrCreate to prevent unique constraint race conditions when multiple workers process same campaign
  const [step] = await CampaignStep.findOrCreate({
    where: { campaignId: campaign.id, stepOrder: 0 },
    defaults: {
      subject: campaign.subject || "No Subject",
      htmlBody: campaign.htmlBody || "<p></p>",
      textBody: campaign.textBody || "",
      delayMinutes: 0,
      condition: "always",
    },
  });

  return step;
}

(async () => {
  try {
    console.log("\n" + "=".repeat(80));
    console.log(
      "🚀 CAMPAIGN-ORCHESTRATOR WORKER STARTING AT:",
      new Date().toISOString(),
    );
    console.log("=".repeat(80));

    const channel = await getChannel();

    await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });
    await channel.assertQueue(QUEUES.EMAIL_ROUTE, { durable: true });

    channel.prefetch(1);

    log("INFO", "🚀 Campaign Orchestrator ready");
    console.log(
      "✅ Campaign Orchestrator worker is now LISTENING for messages",
    );
    console.log("=".repeat(80) + "\n");

    channel.consume(QUEUES.CAMPAIGN_SEND, async (msg) => {
      if (!msg) return;

      const { campaignId, recipientId } = JSON.parse(msg.content.toString());

      try {
        const campaign = await Campaign.findByPk(campaignId);
        const recipient = await CampaignRecipient.findByPk(recipientId);

        /* =========================
           HARD GUARDS
        ========================= */
        if (!campaign || campaign.status !== "running") {
          return channel.ack(msg);
        }

        if (!recipient || recipient.status !== "pending") {
          return channel.ack(msg);
        }

        const step = Number.isInteger(recipient.currentStep)
          ? recipient.currentStep
          : 0;

        log("DEBUG", "🧩 Processing step", {
          campaignId,
          recipientId,
          step,
        });

        if (step === 0) {
          await ensureStepZero(campaign);
        }

        const stepConfig = await CampaignStep.findOne({
          where: { campaignId, stepOrder: step },
        });

        /* =========================
           NO MORE STEPS → COMPLETE
        ========================= */
        if (!stepConfig) {
          await recipient.update({
            status: "completed",
            nextRunAt: null,
          });

          log("INFO", "🏁 Recipient completed campaign", {
            campaignId,
            recipientId,
          });

          await tryCompleteCampaign(campaignId);
          return channel.ack(msg);
        }

        /* =========================
           EMAIL VERIFICATION
        ========================= */
        const verified = await GlobalEmailRegistry.findOne({
          where: {
            normalizedEmail: recipient.email.toLowerCase(),
            verificationStatus: "valid",
          },
        });

        if (!verified) {
          await recipient.update({
            status: "stopped",
            nextRunAt: null,
          });

          log("WARN", "⛔ Email not verified — recipient stopped", {
            recipientId,
          });

          await tryCompleteCampaign(campaignId);
          return channel.ack(msg);
        }

        /* =========================
           IDEMPOTENT SEND
        ========================= */
        const [send, created] = await CampaignSend.findOrCreate({
          where: { campaignId, recipientId, step },
          defaults: {
            senderId: campaign.senderId,
            status: "queued",
          },
        });

        if (!created && send.status !== "queued") {
          return channel.ack(msg);
        }

        /* =========================
        RENDER TEMPLATE
        ========================= */
        const nameParts = (recipient.name || "").trim().split(/\s+/);
        const firstName = nameParts[0] || "";
        const lastName = nameParts.slice(1).join(" ") || "";

        const variables = {
          email: recipient.email,
          name: recipient.name || "",
          first_name: firstName,
          last_name: lastName,
          firstName: firstName, // Common alternative
          lastName: lastName,   // Common alternative
          ...recipient.metadata,
        };

        const renderedSubject = renderTemplate(stepConfig.subject, variables);
        const renderedHtmlRaw = renderTemplate(stepConfig.htmlBody, variables);
        const renderedText = renderTemplate(stepConfig.textBody, variables);

        // 🎯 PRE-GENERATE EMAIL ID FOR TRACKING
        const emailId = crypto.randomUUID();

        // 🎯 INJECT TRACKING
        const trackedHtml = injectTracking(renderedHtmlRaw, emailId, {
          trackOpens: campaign.trackOpens,
          trackClicks: campaign.trackClicks,
        });

        const email = await Email.create({
          id: emailId,
          userId: campaign.userId,
          campaignId,
          senderId: campaign.senderId,
          senderType: campaign.senderType,
          recipientEmail: recipient.email,
          recipientId: recipient.id,
          subject: renderedSubject,
          htmlBody: trackedHtml,
          textBody: renderedText,
          status: "pending",
          metadata: {
            step,
            rawSubject: stepConfig.subject,
          },
        });

        /* =========================
           NEXT STEP SCHEDULING
        ========================= */
        const nextStep = step + 1;
        const nextStepConfig = await CampaignStep.findOne({
          where: { campaignId, stepOrder: nextStep },
        });

        if (nextStepConfig) {
          await recipient.update({
            status: "pending",
            currentStep: nextStep,
            lastSentAt: new Date(),
            nextRunAt: dayjs()
              .add(nextStepConfig.delayMinutes || 0, "minute")
              .toDate(),
          });
        } else {
          // Final step sent - mark recipient as completed but keep campaign running
          await recipient.update({
            status: "completed",
            currentStep: nextStep,
            lastSentAt: new Date(),
            nextRunAt: null,
          });
          
          log("INFO", "🏁 Recipient finished sequence", {
            campaignId,
            recipientId,
          });
          // Removed: await tryCompleteCampaign(campaignId); 
        }

        await send.update({ emailId: email.id });

        /* =========================
           ROUTE EMAIL
        ========================= */
        const sent = channel.sendToQueue(
          QUEUES.EMAIL_ROUTE,
          Buffer.from(JSON.stringify({ emailId: email.id })),
          { persistent: true },
        );

        log("INFO", "📨 Email sent to route queue", {
          emailId: email.id,
          campaignId,
          recipientId,
          status: "pending",
          queueSent: sent,
        });

        channel.ack(msg);
      } catch (err) {
        log("ERROR", "❌ Orchestrator failed", {
          campaignId,
          recipientId,
          error: err.message,
          stack: err.stack,
        });
        channel.ack(msg);
      }
    });
  } catch (err) {
    console.error("💥 FATAL: Campaign Orchestrator failed to start:", err);
    process.exit(1);
  }
})();
