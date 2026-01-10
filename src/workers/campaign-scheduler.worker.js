import "../models/index.js";
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import { getChannel } from "../queues/rabbitmq.js";
import { QUEUES } from "../queues/queues.js";
import { runCampaignCompletionCycle } from "../utils/campaign-completion.checker.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";
import { Op } from "sequelize";

dayjs.extend(utc);
dayjs.extend(timezone);

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      service: "campaign-scheduler",
      level,
      message,
      ...meta,
    })
  );

(async () => {
  try {
    log("INFO", "🚀 Campaign Scheduler starting...");

    const channel = await getChannel();
    log("INFO", "✅ RabbitMQ channel connected");

    await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });
    log("INFO", `✅ Queue ${QUEUES.CAMPAIGN_SEND} asserted`);

    log("INFO", "📆 Campaign Scheduler started successfully");

    // Initial campaign completion check
    log("INFO", "🔄 Running initial campaign completion check");
    await runCampaignCompletionCycle();

    log("INFO", "⏰ Starting scheduler interval (60 seconds)");

    setInterval(async () => {
      const tickId = Date.now();
      log("INFO", "⏰ Scheduler tick started", { tickId });

      try {
        // Get active campaigns
        const campaigns = await Campaign.findAll({
          where: { status: ["scheduled", "running"] },
          attributes: [
            "id",
            "name",
            "status",
            "scheduledAt",
            "timezone",
            "maxFollowUps",
            "throttlePerMinute",
          ],
        });

        log("INFO", "📊 Campaigns fetched for processing", {
          tickId,
          totalCampaigns: campaigns.length,
          campaignIds: campaigns.map((c) => c.id),
        });

        let totalRecipientsEnqueued = 0;
        let campaignsProcessed = 0;

        for (const campaign of campaigns) {
          const campaignStartTime = Date.now();
          let campaignRecipientsEnqueued = 0;

          try {
            log("DEBUG", "🔍 Evaluating campaign", {
              tickId,
              campaignId: campaign.id,
              campaignName: campaign.name,
              status: campaign.status,
              scheduledAt: campaign.scheduledAt,
              maxFollowUps: campaign.maxFollowUps,
              throttle: campaign.throttlePerMinute || 10,
            });

            const now = dayjs().tz(campaign.timezone || "UTC");
            const campaignNow = now.toISOString();

            // Check if campaign is scheduled for future
            if (campaign.scheduledAt && now.isBefore(campaign.scheduledAt)) {
              log("DEBUG", "⏳ Campaign not due yet", {
                tickId,
                campaignId: campaign.id,
                scheduledAt: campaign.scheduledAt,
                currentTime: campaignNow,
                timezone: campaign.timezone || "UTC",
              });
              continue;
            }

            // Update status from scheduled to running
            if (campaign.status === "scheduled") {
              log("INFO", "▶️ Campaign moving from scheduled to running", {
                tickId,
                campaignId: campaign.id,
                campaignName: campaign.name,
              });

              await campaign.update({
                status: "running",
                startedAt: new Date(),
              });
            }

            // Get recipients for this send window
            const recipients = await CampaignRecipient.findAll({
              where: {
                campaignId: campaign.id,
                status: {
                  [Op.notIn]: ["replied", "bounced", "completed", "stopped"],
                },
              },
              attributes: ["id", "email", "status", "currentStep"],
              limit: campaign.throttlePerMinute || 10,
            });

            log("DEBUG", "📥 Recipients fetched for campaign", {
              tickId,
              campaignId: campaign.id,
              totalRecipients: recipients.length,
              recipientIds: recipients.map((r) => r.id),
              recipientEmails: recipients.map((r) => r.email),
            });

            if (recipients.length === 0) {
              log("INFO", "🏁 No recipients to process for campaign", {
                tickId,
                campaignId: campaign.id,
                campaignName: campaign.name,
              });
              continue;
            }

            // Process each recipient
            for (const recipient of recipients) {
              log("DEBUG", "📝 Processing recipient", {
                tickId,
                campaignId: campaign.id,
                recipientId: recipient.id,
                recipientEmail: recipient.email,
                currentStep: recipient.currentStep,
                maxFollowUps: campaign.maxFollowUps,
              });

              // Check if recipient has exceeded max steps
              if (recipient.currentStep > campaign.maxFollowUps) {
                log("INFO", "✅ Recipient completed all steps", {
                  tickId,
                  campaignId: campaign.id,
                  recipientId: recipient.id,
                  recipientEmail: recipient.email,
                  currentStep: recipient.currentStep,
                  maxFollowUps: campaign.maxFollowUps,
                });

                await recipient.update({ status: "completed" });
                continue;
              }

              // Enqueue for orchestrator
              const messagePayload = {
                campaignId: campaign.id,
                recipientId: recipient.id,
                step: recipient.currentStep,
              };

              log("DEBUG", "📤 Enqueuing orchestrator job", {
                tickId,
                campaignId: campaign.id,
                recipientId: recipient.id,
                step: recipient.currentStep,
                queue: QUEUES.CAMPAIGN_SEND,
              });

              channel.sendToQueue(
                QUEUES.CAMPAIGN_SEND,
                Buffer.from(JSON.stringify(messagePayload)),
                { persistent: true }
              );

              campaignRecipientsEnqueued++;
              log("DEBUG", "✅ Recipient enqueued successfully", {
                tickId,
                campaignId: campaign.id,
                recipientId: recipient.id,
                step: recipient.currentStep,
              });
            }

            totalRecipientsEnqueued += campaignRecipientsEnqueued;
            campaignsProcessed++;

            log("INFO", "📊 Campaign processing completed", {
              tickId,
              campaignId: campaign.id,
              campaignName: campaign.name,
              recipientsEnqueued: campaignRecipientsEnqueued,
              durationMs: Date.now() - campaignStartTime,
            });
          } catch (campaignError) {
            log("ERROR", "❌ Campaign processing failed", {
              tickId,
              campaignId: campaign.id,
              campaignName: campaign.name,
              error: campaignError.message,
              stack: campaignError.stack,
              durationMs: Date.now() - campaignStartTime,
            });
          }
        }

        log("INFO", "✅ Scheduler tick completed", {
          tickId,
          totalCampaigns: campaigns.length,
          campaignsProcessed,
          totalRecipientsEnqueued,
          durationMs: Date.now() - tickId,
        });
      } catch (tickError) {
        log("ERROR", "❌ Scheduler tick failed", {
          tickId,
          error: tickError.message,
          stack: tickError.stack,
        });
      }
    }, 60 * 1000);

    // Add channel event handlers
    channel.on("close", () => {
      log("ERROR", "🔌 RabbitMQ channel closed unexpectedly");
    });

    channel.on("error", (err) => {
      log("ERROR", "⚡ RabbitMQ channel error", { error: err.message });
    });
  } catch (startupError) {
    log("ERROR", "💥 Failed to start Campaign Scheduler", {
      error: startupError.message,
      stack: startupError.stack,
    });
    process.exit(1);
  }
})();
