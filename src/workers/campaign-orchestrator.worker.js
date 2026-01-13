import "../models/index.js";

import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignStep from "../models/campaign-step.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import Email from "../models/email.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";

import { getChannel } from "../queues/rabbitmq.js";
import { QUEUES } from "../queues/queues.js";
import { renderTemplate } from "../utils/template-renderer.js";
import { tryCompleteCampaign } from "../utils/campaign-completion.checker.js";
import dayjs from "dayjs";

/* =========================
   LOGGER
========================= */
const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "campaign-orchestrator",
      level,
      message,
      ...meta,
    })
  );

/* =========================
   STEP 0 AUTO-BOOTSTRAP
========================= */
async function ensureStepZero(campaign) {
  const step = await CampaignStep.findOne({
    where: { campaignId: campaign.id, stepOrder: 0 },
  });

  if (step) return step;

  log("INFO", "🧱 Auto-creating step 0", { campaignId: campaign.id });

  return CampaignStep.create({
    campaignId: campaign.id,
    stepOrder: 0,
    subject: campaign.subject,
    htmlBody: campaign.htmlBody,
    textBody: campaign.textBody,
    delayMinutes: 0,
    condition: "always",
  });
}

/* =========================
   WORKER
========================= */
(async () => {
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });
  channel.prefetch(1);

  log("INFO", "🚀 Campaign Orchestrator ready");

  channel.consume(QUEUES.CAMPAIGN_SEND, async (msg) => {
    if (!msg) return;

    const { campaignId, recipientId } = JSON.parse(msg.content.toString());

    try {
      const [campaign, recipient] = await Promise.all([
        Campaign.findByPk(campaignId),
        CampaignRecipient.findByPk(recipientId),
      ]);

      /* =========================
         HARD GUARDS
      ========================= */
      if (!campaign || campaign.status !== "running") {
        channel.ack(msg);
        return;
      }

      if (!recipient || !["pending", "sent"].includes(recipient.status)) {
        channel.ack(msg);
        return;
      }

      const step = Number.isInteger(recipient.currentStep)
        ? recipient.currentStep
        : 0;

      log("DEBUG", "🧩 Processing step", {
        campaignId,
        recipientId,
        step,
        email: recipient.email,
      });

      if (step === 0) {
        await ensureStepZero(campaign);
      }

      const maxStep = await CampaignStep.max("stepOrder", {
        where: { campaignId },
      });

      /* =========================
         ALL STEPS DONE → COMPLETE
      ========================= */
      if (step > maxStep) {
        await recipient.update({
          status: "completed",
          nextRunAt: null,
        });

        log("INFO", "🏁 Recipient completed all steps", {
          campaignId,
          recipientId,
        });

        await tryCompleteCampaign(campaignId);
        channel.ack(msg);
        return;
      }

      const stepConfig = await CampaignStep.findOne({
        where: { campaignId, stepOrder: step },
      });

      if (!stepConfig) {
        channel.ack(msg);
        return;
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

        await tryCompleteCampaign(campaignId);
        channel.ack(msg);
        return;
      }

      /* =========================
         REPLY CONDITION
      ========================= */
      if (stepConfig.condition === "no_reply" && recipient.repliedAt) {
        await recipient.update({
          currentStep: step + 1,
          nextRunAt: new Date(),
        });

        channel.ack(msg);
        return;
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
        channel.ack(msg);
        return;
      }

      /* =========================
         TEMPLATE
      ========================= */
      const vars = {
        name: recipient.name || "there",
        email: recipient.email,
        ...(recipient.metadata || {}),
      };

      const subject = renderTemplate(stepConfig.subject, vars);
      const htmlBody = renderTemplate(stepConfig.htmlBody, vars);

      const email = await Email.create({
        userId: campaign.userId,
        campaignId,
        senderId: campaign.senderId,
        recipientEmail: recipient.email,
        metadata: { subject, htmlBody, step },
      });

      const nextRunAt = dayjs()
        .add(stepConfig.delayMinutes || 0, "minute")
        .toDate();

      await Promise.all([
        recipient.update({
          status: "sent",
          currentStep: step + 1,
          lastSentAt: new Date(),
          nextRunAt,
        }),
        send.update({ emailId: email.id }),
      ]);

      channel.sendToQueue(
        QUEUES.EMAIL_SEND,
        Buffer.from(JSON.stringify({ emailId: email.id })),
        { persistent: true }
      );

      log("INFO", "✅ Campaign email queued", {
        campaignId,
        recipientId,
        step,
        nextRunAt,
      });

      channel.ack(msg);
    } catch (err) {
      log("ERROR", "❌ Orchestrator failed", {
        campaignId,
        recipientId,
        error: err.message,
      });
      channel.ack(msg);
    }
  });
})();
