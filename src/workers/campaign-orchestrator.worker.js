import "../models/index.js";

import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignStep from "../models/campaign-step.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import Email from "../models/email.model.js";

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

(async () => {
  try {
    const channel = await getChannel();
    await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });
    channel.prefetch(1);

    log("INFO", "🚀 Campaign Orchestrator ready");

    channel.consume(QUEUES.CAMPAIGN_SEND, async (msg) => {
      if (!msg) return;

      const payload = JSON.parse(msg.content.toString());
      const { campaignId, recipientId, step } = payload;
      const processingId = `${campaignId}-${recipientId}-${step}`;

      try {
        const [campaign, recipient] = await Promise.all([
          Campaign.findByPk(campaignId),
          CampaignRecipient.findByPk(recipientId),
        ]);

        if (
          !campaign ||
          campaign.status !== "running" ||
          !recipient ||
          recipient.status !== "pending"
        ) {
          channel.ack(msg);
          return;
        }

        log("DEBUG", "🧩 Processing step", {
          processingId,
          step,
          email: recipient.email,
        });

        const stepConfig = await CampaignStep.findOne({
          where: { campaignId, stepOrder: step },
        });

        // 🏁 No more steps → recipient completed
        if (!stepConfig) {
          await recipient.update({
            status: "completed",
            nextRunAt: null,
          });

          await tryCompleteCampaign(campaignId);

          log("INFO", "🏁 Recipient completed sequence", {
            processingId,
            recipientId,
          });

          channel.ack(msg);
          return;
        }

        // ⛔ Conditional skip
        if (stepConfig.condition === "no_reply" && recipient.repliedAt) {
          await recipient.update({
            currentStep: step + 1,
            nextRunAt: new Date(),
          });

          channel.ack(msg);
          return;
        }

        // 🔒 Idempotency
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

        // 🎨 Render templates
        const variables = {
          name: recipient.name || "there",
          email: recipient.email,
          ...(recipient.metadata || {}),
        };

        const subject = renderTemplate(stepConfig.subject, variables);
        const htmlBody = renderTemplate(stepConfig.htmlBody, variables);

        // 💾 Create email
        const email = await Email.create({
          userId: campaign.userId,
          campaignId,
          senderId: campaign.senderId,
          recipientEmail: recipient.email,
          metadata: {
            subject,
            htmlBody,
            step,
          },
        });

        // 🧠 Advance recipient timeline
        const nextRunAt = dayjs()
          .add(stepConfig.delayMinutes || 0, "minute")
          .toDate();

        await Promise.all([
          recipient.update({
            currentStep: step + 1,
            lastSentAt: new Date(),
            nextRunAt,
          }),
          send.update({ emailId: email.id }),
        ]);

        // 📤 Enqueue email send
        channel.sendToQueue(
          QUEUES.EMAIL_SEND,
          Buffer.from(JSON.stringify({ emailId: email.id })),
          { persistent: true }
        );

        log("INFO", "✅ Campaign step sent", {
          processingId,
          emailId: email.id,
          nextRunAt,
        });

        channel.ack(msg);
      } catch (err) {
        log("ERROR", "❌ Orchestrator failed", {
          processingId,
          error: err.message,
        });
        channel.ack(msg);
      }
    });
  } catch (err) {
    log("ERROR", "💥 Orchestrator startup failed", {
      error: err.message,
    });
    process.exit(1);
  }
})();
