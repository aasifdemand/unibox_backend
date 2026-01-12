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

import { mtaDetectorCache } from "../services/mta-detector-cache.service.js";
import { EmailProvider } from "../enums/email-provider.enum.js";

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
  return `<${emailId}.${uid}.${ts}@${domain}>`;
}

/* =========================
   PROVIDER RULES
========================= */
function applyProviderRules(provider) {
  switch (provider) {
    case EmailProvider.GOOGLE:
      return { tlsRequired: true };

    case EmailProvider.MICROSOFT:
      return { tlsRequired: true };

    case EmailProvider.PROTON:
      return { tlsRequired: true };

    case EmailProvider.SELF_HOSTED:
      return { tlsRequired: false };

    default:
      return { tlsRequired: false };
  }
}

/* =========================
   WORKER
========================= */
(async () => {
  try {
    log("INFO", "🚀 Email Sender starting...");

    const channel = await getChannel();
    await channel.assertQueue(QUEUES.EMAIL_SEND, { durable: true });
    channel.prefetch(5);

    log("INFO", "📧 Email Sender ready");

    channel.consume(QUEUES.EMAIL_SEND, async (msg) => {
      if (!msg) return;

      let emailId;
      let headers = {};

      try {
        const parsed = JSON.parse(msg.content.toString());
        emailId = parsed.emailId;
        headers = msg.properties.headers || {};
      } catch {
        channel.ack(msg);
        return;
      }

      let email;
      let sender;

      try {
        email = await Email.findByPk(emailId);
        if (!email || email.status === "sent") {
          channel.ack(msg);
          return;
        }

        sender = await Sender.findByPk(email.senderId);
        if (!sender) throw new Error("Sender not found");

        /* =========================
           MTA DETECTION (SAFE)
        ========================= */
        const recipientDomain = email.recipientEmail.split("@")[1];

        let mtaInfo = {
          provider: EmailProvider.UNKNOWN,
          confidence: "weak",
        };

        try {
          mtaInfo = await mtaDetectorCache.detect(email.recipientEmail);
        } catch (e) {
          log("WARN", "MTA detection failed, using fallback", {
            emailId,
            domain: recipientDomain,
            error: e.message,
          });
        }

        const providerRules = applyProviderRules(mtaInfo.provider);

        log("INFO", "📡 Delivery provider resolved", {
          emailId,
          recipientDomain,
          provider: mtaInfo.provider,
          confidence: mtaInfo.confidence,
          score: mtaInfo.score,
        });

        await EmailEvent.create({
          emailId,
          eventType: "queued",
          eventTimestamp: new Date(),
        });

        const messageId = generateMessageId(
          emailId,
          sender.email.split("@")[1]
        );
        let providerMessageId;

        /* =========================
           MICROSOFT GRAPH
        ========================= */
        if (sender.provider === "outlook") {
          const token = await getValidMicrosoftToken(sender);

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
            throw new Error(`Graph API failed (${res.status})`);
          }

          providerMessageId = messageId;
        } else {
          /* =========================
             SMTP
          ========================= */
          const transporter = nodemailer.createTransport({
            host: sender.smtpHost,
            port: sender.smtpPort,
            secure: sender.smtpSecure,
            auth: {
              user: sender.smtpUser,
              pass: sender.smtpPass,
            },
            tls: {
              rejectUnauthorized: providerRules.tlsRequired,
            },
          });

          await transporter.sendMail({
            from: `"${sender.displayName}" <${sender.email}>`,
            to: email.recipientEmail,
            subject: email.metadata.subject,
            html: email.metadata.htmlBody,
            messageId,
          });

          providerMessageId = messageId;
        }

        /* =========================
           FINAL UPDATES
        ========================= */
        await email.update({
          status: "sent",
          providerMessageId,
          sentAt: new Date(),
          deliveryProvider: mtaInfo.provider,
          deliveryConfidence: mtaInfo.confidence,
        });

        await CampaignSend.update(
          { status: "sent", sentAt: new Date() },
          { where: { emailId } }
        );

        await EmailEvent.create({
          emailId,
          eventType: "sent",
          eventTimestamp: new Date(),
          metadata: {
            provider: mtaInfo.provider,
            confidence: mtaInfo.confidence,
          },
        });

        log("INFO", "✅ Email sent", {
          emailId,
          recipient: email.recipientEmail,
          provider: mtaInfo.provider,
        });

        channel.ack(msg);
      } catch (err) {
        log("ERROR", "❌ Email send failed", {
          emailId,
          error: err.message,
        });

        if (email) {
          await email.update({
            status: "failed",
            lastError: err.message.substring(0, 500),
          });
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
        });

        await CampaignRecipient.update(
          { status: "bounced", bounceReason: err.message.substring(0, 200) },
          {
            where: {
              email: email?.recipientEmail,
              campaignId: email?.campaignId,
            },
          }
        );

        channel.ack(msg);
      }
    });

    channel.on("close", () => {
      log("ERROR", "RabbitMQ channel closed");
      process.exit(1);
    });
  } catch (err) {
    log("ERROR", "Email Sender failed to start", {
      error: err.message,
    });
    process.exit(1);
  }
})();
