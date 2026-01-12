import "../models/index.js";
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import { getChannel } from "../queues/rabbitmq.js";
import { QUEUES } from "../queues/queues.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { Op } from "sequelize";

dayjs.extend(utc);
dayjs.extend(timezone);

/* =========================
   LOGGER
========================= */
const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "campaign-scheduler",
      level,
      message,
      ...meta,
    })
  );

(async () => {
  try {
    log("INFO", "🚀 Campaign Scheduler starting");

    const channel = await getChannel();
    await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });

    log("INFO", "✅ Scheduler connected");

    setInterval(async () => {
      const tickId = Date.now();
      log("INFO", "⏰ Scheduler tick", { tickId });

      try {
        const campaigns = await Campaign.findAll({
          where: { status: ["scheduled", "running"] },
        });

        for (const campaign of campaigns) {
          const now = dayjs().tz(campaign.timezone || "UTC");

          // ⏳ Not due yet
          if (
            campaign.status === "scheduled" &&
            campaign.scheduledAt &&
            now.isBefore(campaign.scheduledAt)
          ) {
            continue;
          }

          // ▶️ Activate campaign
          if (campaign.status === "scheduled") {
            await campaign.update({ status: "running" });
            log("INFO", "▶️ Campaign started", {
              campaignId: campaign.id,
            });
          }

          // 📥 Fetch ONLY recipients that are due
          const recipients = await CampaignRecipient.findAll({
            where: {
              campaignId: campaign.id,
              status: "pending",
              nextRunAt: { [Op.lte]: new Date() },
            },
            order: [["nextRunAt", "ASC"]],
            limit: campaign.throttlePerMinute,
          });

          if (recipients.length === 0) continue;

          log("INFO", "📥 Recipients due", {
            campaignId: campaign.id,
            count: recipients.length,
          });

          for (const recipient of recipients) {
            const payload = {
              campaignId: campaign.id,
              recipientId: recipient.id,
              step: recipient.currentStep,
            };

            channel.sendToQueue(
              QUEUES.CAMPAIGN_SEND,
              Buffer.from(JSON.stringify(payload)),
              { persistent: true }
            );

            // ⛔ Temporary lock to prevent re-enqueue
            await recipient.update({
              nextRunAt: dayjs().add(10, "minute").toDate(),
            });

            log("DEBUG", "📤 Recipient enqueued", {
              campaignId: campaign.id,
              recipientId: recipient.id,
              step: recipient.currentStep,
            });
          }
        }
      } catch (err) {
        log("ERROR", "❌ Scheduler tick failed", {
          tickId,
          error: err.message,
        });
      }
    }, 60 * 1000);
  } catch (err) {
    log("ERROR", "💥 Scheduler startup failed", {
      error: err.message,
    });
    process.exit(1);
  }
})();
