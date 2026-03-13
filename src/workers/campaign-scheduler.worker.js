import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import { getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);
import { Op } from "sequelize";
import { getSenderWithType } from "../models/index.js";
import { DeliveryGuard } from "../utils/delivery-guard.js";

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "campaign-scheduler",
      level,
      message,
      ...meta,
    }),
  );

(async () => {
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });

  log("INFO", "🚀 Campaign Scheduler started");

  setInterval(async () => {
    try {
      log("DEBUG", "⏰ Scheduler tick");

      const campaigns = await Campaign.findAll({
        where: { status: { [Op.in]: ["scheduled", "running"] } },
      });

      for (const campaign of campaigns) {
        // ... (campaign status update logic remains same)
        if (campaign.status === "scheduled" && (!campaign.scheduledAt || dayjs.utc().isAfter(campaign.scheduledAt))) {
          await campaign.update({ status: "running", scheduledAt: campaign.scheduledAt || new Date() });
          log("INFO", "▶️ Campaign started", { campaignId: campaign.id });
        }
        if (campaign.status !== "running") continue;

        /* =========================
           WORM-UP & DAILY LIMITS
        ========================= */
        const sender = await getSenderWithType(campaign.senderId, campaign.senderType);
        if (!sender) {
          log("ERROR", "❌ Sender not found for campaign", { campaignId: campaign.id });
          continue;
        }

        const health = await DeliveryGuard.canSendToday(sender);
        if (!health.allowed) {
          log("WARN", "⏳ Sender reached daily warm-up limit", {
            sender: sender.email,
            limit: health.limit,
            current: health.currentCount,
          });
          continue;
        }

        // Adjust batch size based on remaining daily quota and throttle
        const batchSize = Math.min(campaign.throttlePerMinute, health.remaining);

        const recipients = await CampaignRecipient.findAll({
          where: {
            campaignId: campaign.id,
            status: "pending",
            nextRunAt: { [Op.or]: [{ [Op.lte]: new Date() }, { [Op.is]: null }] },
          },
          include: [{ model: GlobalEmailRegistry, required: false, attributes: ["unsubscribed"] }],
          order: [["nextRunAt", "ASC"]],
          limit: batchSize,
        });

        if (recipients.length === 0) continue;

        log("DEBUG", "📤 Batching recipients", {
          campaignId: campaign.id,
          count: recipients.length,
          dailyRemaining: health.remaining,
        });

        for (const r of recipients) {
          // ... (existing suppression and queue logic)
          if (r.GlobalEmailRegistry?.unsubscribed) {
            await r.update({ status: "unsubscribed", nextRunAt: null });
            continue;
          }

          channel.sendToQueue(QUEUES.CAMPAIGN_SEND, Buffer.from(JSON.stringify({ campaignId: campaign.id, recipientId: r.id })), { persistent: true });
          await r.update({ nextRunAt: dayjs.utc().add(10, "minute").toDate() });
        }
      }
    } catch (err) {
      log("ERROR", "❌ Scheduler error", { error: err.message });
    }
  }, 60_000);
})();
