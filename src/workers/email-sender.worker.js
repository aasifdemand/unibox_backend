import "../models/index.js";
import nodemailer from "nodemailer";
import { randomUUID } from "crypto";

import Email from "../models/email.model.js";
import Sender from "../models/sender.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import EmailEvent from "../models/email-event.model.js";
import BounceEvent from "../models/bounce-event.model.js";

import { getChannel } from "../queues/rabbitmq.js";
import { QUEUES } from "../queues/queues.js";
import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";

/* =========================
   LOGGER
========================= */
const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "email-sender",
      level,
      message,
      ...meta,
    })
  );

/* =========================
   MESSAGE-ID GENERATOR
========================= */
function generateMessageId(emailId, domain) {
  const ts = Date.now();
  const uid = randomUUID().split("-")[0];
  const messageId = `<${emailId}.${uid}.${ts}@${domain}>`;

  log("DEBUG", "Generated Message-ID", {
    emailId,
    domain,
    messageId,
    length: messageId.length,
  });

  return messageId;
}

/* =========================
   WORKER
========================= */
(async () => {
  try {
    log("INFO", "🚀 Email Sender starting...");

    const channel = await getChannel();
    log("INFO", "✅ RabbitMQ channel connected");

    await channel.assertQueue(QUEUES.EMAIL_SEND, { durable: true });
    log("INFO", `✅ Queue ${QUEUES.EMAIL_SEND} asserted`);

    channel.prefetch(5);
    log("INFO", "🔄 Prefetch set to 5");

    log("INFO", "📧 Email Sender ready to process messages");

    channel.consume(QUEUES.EMAIL_SEND, async (msg) => {
      if (!msg) {
        log("WARN", "Received null message from queue");
        return;
      }

      let emailId;
      let messageHeaders = {};

      try {
        const messageContent = msg.content.toString();
        log("DEBUG", "📥 Received message from queue", {
          queue: QUEUES.EMAIL_SEND,
          messageSize: messageContent.length,
          headers: msg.properties.headers,
        });

        const parsed = JSON.parse(messageContent);
        emailId = parsed.emailId;
        messageHeaders = msg.properties.headers || {};

        log("INFO", "🔍 Processing email send request", {
          emailId,
          processingId: messageHeaders["processing-id"] || "unknown",
          campaignId: messageHeaders["campaign-id"] || "unknown",
          recipientId: messageHeaders["recipient-id"] || "unknown",
        });
      } catch (parseErr) {
        log("ERROR", "❌ Failed to parse message", {
          error: parseErr.message,
          content: msg.content.toString().substring(0, 200),
        });
        channel.ack(msg);
        return;
      }

      let email;
      let sender;

      try {
        // Fetch email record
        log("DEBUG", "📋 Fetching email record", { emailId });

        email = await Email.findByPk(emailId);
        if (!email) {
          log("WARN", "❌ Email record not found", { emailId });
          channel.ack(msg);
          return;
        }

        log("DEBUG", "✅ Found email record", {
          emailId,
          status: email.status,
          recipientEmail: email.recipientEmail,
          senderId: email.senderId,
          campaignId: email.campaignId,
        });

        if (email.status === "sent") {
          log("INFO", "⏭️ Email already sent", {
            emailId,
            sentAt: email.sentAt,
            providerMessageId: email.providerMessageId?.substring(0, 50),
          });
          channel.ack(msg);
          return;
        }

        // Fetch sender configuration
        log("DEBUG", "📋 Fetching sender configuration", {
          senderId: email.senderId,
        });

        sender = await Sender.findByPk(email.senderId);
        if (!sender) {
          throw new Error(`Sender not found: ${email.senderId}`);
        }

        log("DEBUG", "✅ Found sender configuration", {
          senderId: sender.id,
          email: sender.email,
          provider: sender.provider,
          displayName: sender.displayName,
          hasSmtpConfig: !!(
            sender.smtpHost &&
            sender.smtpUser &&
            sender.smtpPass
          ),
        });

        // Create queued event
        await EmailEvent.create({
          emailId,
          eventType: "queued",
          eventTimestamp: new Date(),
          metadata: { queue: QUEUES.EMAIL_SEND },
        });

        const domain = sender.email.split("@")[1];
        const messageId = generateMessageId(emailId, domain);
        let providerMessageId;

        /* =========================
           OUTLOOK (GRAPH API)
        ========================= */
        if (sender.provider === "outlook") {
          log("INFO", "🔵 Sending via Microsoft Graph API", {
            emailId,
            provider: "outlook",
            senderEmail: sender.email,
          });

          const token = await getValidMicrosoftToken(sender);

          log("DEBUG", "✅ Microsoft token obtained", {
            emailId,
            tokenLength: token.length,
          });

          const res = await fetch(
            "https://graph.microsoft.com/v1.0/me/sendMail",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                message: {
                  subject: email.metadata.subject,
                  body: {
                    contentType: "HTML",
                    content: email.metadata.htmlBody,
                  },
                  toRecipients: [
                    { emailAddress: { address: email.recipientEmail } },
                  ],
                  internetMessageId: messageId,
                },
                saveToSentItems: true,
              }),
            }
          );

          if (!res.ok) {
            const errorText = await res.text();
            throw new Error(
              `Microsoft Graph API error: ${res.status} - ${errorText}`
            );
          }

          providerMessageId = messageId;

          log("INFO", "✅ Email sent via Microsoft Graph API", {
            emailId,
            recipientEmail: email.recipientEmail,
            messageId: messageId.substring(0, 50) + "...",
          });
        } else {
          /* =========================
             SMTP (GMAIL / CUSTOM)
          ========================= */
          log("INFO", "🔵 Sending via SMTP", {
            emailId,
            provider: sender.provider,
            smtpHost: sender.smtpHost,
            smtpPort: sender.smtpPort,
            senderEmail: sender.email,
          });

          const transporter = nodemailer.createTransport({
            host: sender.smtpHost,
            port: sender.smtpPort,
            secure: sender.smtpSecure,
            auth: {
              user: sender.smtpUser,
              pass: sender.smtpPass,
            },
            tls: {
              rejectUnauthorized: false,
              ciphers: "SSLv3",
            },
            logger: false, // Disable nodemailer's internal logging
            debug: false,
          });

          const mailOptions = {
            from: `"${sender.displayName}" <${sender.email}>`,
            to: email.recipientEmail,
            subject: email.metadata.subject,
            html: email.metadata.htmlBody,
            messageId,
            headers: {
              "Message-ID": messageId,
              "X-Unibox-Email-ID": emailId,
              "X-Unibox-Campaign-ID": email.campaignId,
              "List-Unsubscribe": `<mailto:${sender.email}?subject=unsubscribe-${emailId}>`,
              References: messageId,
              "In-Reply-To": messageId,
              Precedence: "bulk",
            },
          };

          log("DEBUG", "📤 SMTP mail options prepared", {
            emailId,
            from: mailOptions.from,
            to: mailOptions.to,
            subjectLength: email.metadata.subject?.length || 0,
            htmlLength: email.metadata.htmlBody?.length || 0,
          });

          const result = await transporter.sendMail(mailOptions);

          providerMessageId = messageId;

          log("INFO", "✅ Email sent via SMTP", {
            emailId,
            recipientEmail: email.recipientEmail,
            messageId: messageId.substring(0, 50) + "...",
            response: result.response?.substring(0, 100),
          });
        }

        /* =========================
           DATABASE UPDATES
        ========================= */
        log("INFO", "💾 Updating database records", { emailId });

        await email.update({
          status: "sent",
          providerMessageId,
          sentAt: new Date(),
        });

        log("DEBUG", "✅ Email record updated", {
          emailId,
          newStatus: "sent",
          sentAt: new Date().toISOString(),
        });

        await CampaignSend.update(
          { status: "sent", sentAt: new Date() },
          { where: { emailId } }
        );

        log("DEBUG", "✅ CampaignSend record updated", { emailId });

        await EmailEvent.create({
          emailId,
          eventType: "sent",
          eventTimestamp: new Date(),
          metadata: {
            providerMessageId,
            provider: sender.provider,
            deliveryMethod:
              sender.provider === "outlook" ? "graph_api" : "smtp",
          },
        });

        log("INFO", "🎉 Email sent successfully", {
          emailId,
          recipientEmail: email.recipientEmail,
          senderId: sender.id,
          provider: sender.provider,
          providerMessageId: providerMessageId?.substring(0, 50) + "...",
          processingId: messageHeaders["processing-id"] || "unknown",
          durationMs: Date.now() - new Date(msg.properties.timestamp).getTime(),
        });

        channel.ack(msg);
      } catch (err) {
        log("ERROR", "❌ Email send failed", {
          emailId,
          recipientEmail: email?.recipientEmail,
          senderId: sender?.id,
          provider: sender?.provider,
          error: err.message,
          stack: err.stack,
          processingId: messageHeaders["processing-id"] || "unknown",
        });

        // Update failed status in database
        if (email) {
          await email.update({
            status: "failed",
            lastError: err.message.substring(0, 500),
          });

          log("DEBUG", "📝 Email marked as failed", { emailId });
        }

        await CampaignSend.update(
          { status: "failed", error: err.message.substring(0, 500) },
          { where: { emailId } }
        );

        await BounceEvent.create({
          emailId,
          bounceType: "hard",
          reason: err.message.substring(0, 500),
          occurredAt: new Date(),
          metadata: {
            provider: sender?.provider,
            senderId: sender?.id,
            errorDetails: err.stack?.split("\n")[0],
          },
        });

        log("DEBUG", "✅ Bounce event created", { emailId });

        if (email?.recipientEmail && email?.campaignId) {
          await CampaignRecipient.update(
            { status: "bounced", bounceReason: err.message.substring(0, 200) },
            {
              where: {
                email: email.recipientEmail,
                campaignId: email.campaignId,
              },
            }
          );

          log("INFO", "⏹️ Recipient marked as bounced", {
            emailId,
            recipientEmail: email.recipientEmail,
            campaignId: email.campaignId,
          });
        }

        channel.ack(msg); // Don't retry failed sends
      }
    });

    // Channel event handlers
    channel.on("close", () => {
      log("ERROR", "🔌 RabbitMQ channel closed unexpectedly");
      process.exit(1);
    });

    channel.on("error", (err) => {
      log("ERROR", "⚡ RabbitMQ channel error", {
        error: err.message,
        stack: err.stack,
      });
    });

    channel.on("blocked", (reason) => {
      log("WARN", "🚫 RabbitMQ channel blocked", { reason });
    });

    channel.on("unblocked", () => {
      log("INFO", "✅ RabbitMQ channel unblocked");
    });

    log("INFO", "✅ Email Sender started successfully");
  } catch (err) {
    log("ERROR", "💥 Failed to start Email Sender", {
      error: err.message,
      stack: err.stack,
    });
    process.exit(1);
  }
})();
