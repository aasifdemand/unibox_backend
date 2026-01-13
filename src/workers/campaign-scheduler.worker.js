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
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });

  log("INFO", "🚀 Campaign Scheduler running");

  setInterval(async () => {
    try {
      const campaigns = await Campaign.findAll({
        where: {
          status: { [Op.in]: ["scheduled", "running"] },
        },
      });

      for (const campaign of campaigns) {
        const now = dayjs().tz(campaign.timezone || "UTC");

        // ▶️ Promote scheduled → running
        if (
          campaign.status === "scheduled" &&
          (!campaign.scheduledAt || now.isAfter(campaign.scheduledAt))
        ) {
          await campaign.update({ status: "running" });

          log("INFO", "▶️ Campaign started", {
            campaignId: campaign.id,
          });
        }

        const recipients = await CampaignRecipient.findAll({
          where: {
            campaignId: campaign.id,
            status: "pending",
            nextRunAt: {
              [Op.or]: [{ [Op.lte]: new Date() }, { [Op.is]: null }],
            },
          },
          order: [["nextRunAt", "ASC"]],
          limit: campaign.throttlePerMinute,
        });

        for (const recipient of recipients) {
          channel.sendToQueue(
            QUEUES.CAMPAIGN_SEND,
            Buffer.from(
              JSON.stringify({
                campaignId: campaign.id,
                recipientId: recipient.id,
                step: recipient.currentStep || 0,
              })
            ),
            { persistent: true }
          );

          await recipient.update({
            nextRunAt: dayjs().add(10, "minute").toDate(),
          });

          log("DEBUG", "📤 Recipient enqueued", {
            campaignId: campaign.id,
            recipientId: recipient.id,
            step: recipient.currentStep || 0,
          });
        }
      }
    } catch (err) {
      log("ERROR", "❌ Scheduler error", { error: err.message });
    }
  }, 60 * 1000);
})();
