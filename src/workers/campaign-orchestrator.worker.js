import "../models/index.js";

import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignStep from "../models/campaign-step.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import Email from "../models/email.model.js";

import { getChannel } from "../queues/rabbitmq.js";
import { QUEUES } from "../queues/queues.js";
import { renderTemplate } from "../utils/template-renderer.js";

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
    log("INFO", "🚀 Starting Campaign Orchestrator...");

    const channel = await getChannel();
    log("INFO", "✅ RabbitMQ channel connected");

    await channel.assertQueue(QUEUES.CAMPAIGN_SEND, { durable: true });
    log("INFO", `✅ Queue ${QUEUES.CAMPAIGN_SEND} asserted`);

    channel.prefetch(1);
    log("INFO", "🔄 Prefetch set to 1");

    log("INFO", "📭 Campaign Orchestrator ready to consume messages");

    channel.consume(QUEUES.CAMPAIGN_SEND, async (msg) => {
      if (!msg) {
        log("WARN", "Received null message from queue");
        return;
      }

      let payload;
      try {
        payload = JSON.parse(msg.content.toString());
        log("DEBUG", "📥 Message received from campaign-scheduler", {
          queue: QUEUES.CAMPAIGN_SEND,
          messageId: msg.properties.messageId,
          payload,
        });
      } catch (parseErr) {
        log("ERROR", "❌ Failed to parse message payload", {
          error: parseErr.message,
          rawContent: msg.content.toString().substring(0, 200),
        });
        channel.ack(msg);
        return;
      }

      const { campaignId, recipientId, step } = payload;
      const processingId = `${campaignId}-${recipientId}-${step}`;

      log("INFO", "🔍 Processing campaign orchestration", {
        processingId,
        campaignId,
        recipientId,
        step,
      });

      try {
        // Fetch campaign and recipient in parallel
        log("DEBUG", "📋 Fetching campaign and recipient data", {
          processingId,
          campaignId,
          recipientId,
        });

        const [campaign, recipient] = await Promise.all([
          Campaign.findByPk(campaignId),
          CampaignRecipient.findByPk(recipientId),
        ]);

        if (!campaign) {
          log("WARN", "❌ Campaign not found", {
            processingId,
            campaignId,
          });
          channel.ack(msg);
          return;
        }

        if (!recipient) {
          log("WARN", "❌ Recipient not found", {
            processingId,
            recipientId,
          });
          channel.ack(msg);
          return;
        }

        log("DEBUG", "✅ Campaign and recipient found", {
          processingId,
          campaignName: campaign.name,
          campaignStatus: campaign.status,
          recipientEmail: recipient.email,
          recipientStatus: recipient.status,
          recipientCurrentStep: recipient.currentStep,
        });

        // Validate campaign status
        if (campaign.status !== "running") {
          log("WARN", "⏸️ Campaign is not running", {
            processingId,
            campaignId,
            campaignStatus: campaign.status,
          });
          channel.ack(msg);
          return;
        }

        // Validate recipient status
        const blockedStatuses = ["replied", "bounced", "completed", "stopped"];
        if (blockedStatuses.includes(recipient.status)) {
          log("INFO", "⏹️ Recipient has blocked status", {
            processingId,
            recipientId,
            recipientEmail: recipient.email,
            recipientStatus: recipient.status,
            requestedStep: step,
            currentStep: recipient.currentStep,
          });
          channel.ack(msg);
          return;
        }

        log("DEBUG", "✅ Recipient is eligible for processing", {
          processingId,
          recipientStatus: recipient.status,
          requestedStep: step,
        });

        // Get step configuration
        log("DEBUG", "📝 Looking for step configuration", {
          processingId,
          step,
        });

        let stepConfig;
        if (step === 0) {
          stepConfig = campaign;
          log("DEBUG", "📌 Using campaign as step 0 configuration", {
            processingId,
            hasSubject: !!campaign.subject,
            subjectPreview: campaign.subject?.substring(0, 50),
          });
        } else {
          stepConfig = await CampaignStep.findOne({
            where: { campaignId, stepOrder: step },
          });

          if (stepConfig) {
            log("DEBUG", "✅ Found step configuration", {
              processingId,
              stepOrder: stepConfig.stepOrder,
              delayMinutes: stepConfig.delayMinutes,
              condition: stepConfig.condition,
            });
          } else {
            log("WARN", "❌ Step configuration not found", {
              processingId,
              campaignId,
              step,
            });
          }
        }

        // Handle missing step configuration
        if (!stepConfig) {
          log(
            "INFO",
            "🏁 No step config found, marking recipient as completed",
            {
              processingId,
              recipientId,
              email: recipient.email,
            }
          );

          await recipient.update({
            status: "completed",
            completedAt: new Date(),
          });

          channel.ack(msg);
          return;
        }

        // Check for existing send record (idempotency)
        log("DEBUG", "🔒 Checking for existing send record", {
          processingId,
          campaignId,
          recipientId,
          step,
        });

        const [send, created] = await CampaignSend.findOrCreate({
          where: { campaignId, recipientId, step },
          defaults: {
            senderId: campaign.senderId,
            status: "queued",
          },
        });

        log("DEBUG", "🆔 Send record check result", {
          processingId,
          sendId: send.id,
          created,
          existingStatus: send.status,
        });

        if (!created && send.status !== "queued") {
          log("INFO", "⏭️ Send already processed with different status", {
            processingId,
            sendId: send.id,
            status: send.status,
          });
          channel.ack(msg);
          return;
        }

        // Render email templates
        log("DEBUG", "🎨 Rendering email templates", {
          processingId,
          recipientName: recipient.name || "there",
          recipientEmail: recipient.email,
          metadataFields: Object.keys(recipient.metadata || {}).length,
        });

        const variables = {
          name: recipient.name || "there",
          email: recipient.email,
          ...(recipient.metadata || {}),
        };

        const renderedSubject = renderTemplate(stepConfig.subject, variables);
        const renderedHtmlBody = renderTemplate(stepConfig.htmlBody, variables);

        log("DEBUG", "✅ Templates rendered successfully", {
          processingId,
          subjectLength: renderedSubject.length,
          htmlBodyLength: renderedHtmlBody.length,
          subjectPreview: renderedSubject.substring(0, 100) + "...",
        });

        // Create email record
        log("INFO", "💾 Creating email record", {
          processingId,
          campaignId,
          senderId: campaign.senderId,
          recipientEmail: recipient.email,
        });

        const email = await Email.create({
          userId: campaign.userId,
          campaignId,
          senderId: campaign.senderId,
          recipientEmail: recipient.email,
          metadata: {
            subject: renderedSubject,
            htmlBody: renderedHtmlBody,
            step: step,
            variables: variables,
          },
        });

        log("INFO", "✅ Email record created", {
          processingId,
          emailId: email.id,
          recipientEmail: email.recipientEmail,
        });

        // Update recipient and send records
        log("DEBUG", "📝 Updating recipient and send records", {
          processingId,
          recipientId,
          newStep: step + 1,
          sendId: send.id,
        });

        await Promise.all([
          recipient.update({
            currentStep: step + 1,
            lastSentAt: new Date(),
            status: "pending",
          }),
          send.update({
            emailId: email.id,
            status: "queued",
            updatedAt: new Date(),
          }),
        ]);

        // Enqueue for email sending
        log("INFO", "📤 Enqueuing email for sending", {
          processingId,
          emailId: email.id,
          recipientEmail: recipient.email,
          queue: QUEUES.EMAIL_SEND,
        });

        channel.sendToQueue(
          QUEUES.EMAIL_SEND,
          Buffer.from(JSON.stringify({ emailId: email.id })),
          {
            persistent: true,
            headers: {
              "processing-id": processingId,
              "campaign-id": campaignId,
              "recipient-id": recipientId,
            },
          }
        );

        log("INFO", "✅ Successfully orchestrated campaign step", {
          processingId,
          campaignId,
          campaignName: campaign.name,
          recipientId,
          recipientEmail: recipient.email,
          step,
          nextStep: step + 1,
          emailId: email.id,
          sendId: send.id,
        });

        channel.ack(msg);
      } catch (err) {
        log("ERROR", "❌ Orchestrator processing failed", {
          processingId: processingId || "unknown",
          campaignId,
          recipientId,
          step,
          error: err.message,
          stack: err.stack,
          payload: JSON.stringify(payload),
        });

        // Don't requeue - ack to avoid infinite loops
        channel.ack(msg);
      }
    });

    // Channel event handlers
    channel.on("close", () => {
      log("ERROR", "🔌 RabbitMQ channel closed unexpectedly");
    });

    channel.on("error", (err) => {
      log("ERROR", "⚡ RabbitMQ channel error", { error: err.message });
    });
  } catch (startupErr) {
    log("ERROR", "💥 Failed to start Campaign Orchestrator", {
      error: startupErr.message,
      stack: startupErr.stack,
    });
    process.exit(1);
  }
})();
