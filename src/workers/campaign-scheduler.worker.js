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
        // ▶️ scheduled → running
        if (
          campaign.status === "scheduled" &&
          (!campaign.scheduledAt || dayjs.utc().isAfter(campaign.scheduledAt))
        ) {
          await campaign.update({
            status: "running",
            scheduledAt: campaign.scheduledAt || new Date(),
          });

          log("INFO", "▶️ Campaign started", { campaignId: campaign.id });
        }

        if (campaign.status !== "running") continue;

        const recipients = await CampaignRecipient.findAll({
          where: {
            campaignId: campaign.id,
            status: "pending",
            nextRunAt: {
              [Op.or]: [{ [Op.lte]: new Date() }, { [Op.is]: null }],
            },
          },
          include: [
            {
              model: GlobalEmailRegistry,
              required: false, // Left Join
              attributes: ["unsubscribed"],
            },
          ],
          order: [["nextRunAt", "ASC"]],
          limit: campaign.throttlePerMinute,
        });

        log("DEBUG", "📤 Recipients ready", {
          campaignId: campaign.id,
          count: recipients.length,
        });

        for (const r of recipients) {
          // 🛡️ Global Unsubscribe Check (Joined status)
          if (r.GlobalEmailRegistry?.unsubscribed) {
            await r.update({ status: "stopped", nextRunAt: null });
            log("INFO", "🚫 Recipient globally unsubscribed, skipping", {
              campaignId: campaign.id,
              recipientId: r.id,
              email: r.email,
            });
            continue;
          }

          channel.sendToQueue(
            QUEUES.CAMPAIGN_SEND,
            Buffer.from(
              JSON.stringify({
                campaignId: campaign.id,
                recipientId: r.id,
              }),
            ),
            { persistent: true },
          );

          await r.update({
            nextRunAt: dayjs.utc().add(10, "minute").toDate(),
          });

          log("DEBUG", "➡️ Recipient enqueued", {
            campaignId: campaign.id,
            recipientId: r.id,
          });
        }
      }
    } catch (err) {
      log("ERROR", "❌ Scheduler error", { error: err.message });
    }
  }, 60_000);
})();
