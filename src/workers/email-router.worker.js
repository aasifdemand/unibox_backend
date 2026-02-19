import "../models/index.js";
import Redis from "ioredis";
import Email from "../models/email.model.js";
import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";

import { getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { mtaDetectorCache } from "../services/mta-detector-cache.service.js";
import { EmailProvider } from "../enums/email-provider.enum.js";

const redis = new Redis(process.env.REDIS_URL);

/* =========================
   PROVIDER RATE LIMITS
========================= */
const PROVIDER_LIMITS = {
  [EmailProvider.GOOGLE]: 20,
  [EmailProvider.MICROSOFT]: 15,
  [EmailProvider.YAHOO]: 10,
  default: 5,
};

/* =========================
   LOGGER
========================= */
const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "email-router",
      level,
      message,
      ...meta,
    }),
  );

/* =========================
   GET SENDER BY TYPE
========================= */
async function getSender(senderType, senderId) {
  switch (senderType) {
    case "gmail":
      return await GmailSender.findByPk(senderId);
    case "outlook":
      return await OutlookSender.findByPk(senderId);
    case "smtp":
      return await SmtpSender.findByPk(senderId);
    default:
      return null;
  }
}

/* =========================
   MAIN WORKER
========================= */
(async () => {
  try {
    console.log("\n" + "=".repeat(80));
    console.log("🚀 EMAIL ROUTER (Campaign-Bound Sender) STARTED");
    console.log("=".repeat(80));

    const channel = await getChannel();

    await channel.assertQueue(QUEUES.EMAIL_ROUTE, { durable: true });
    await channel.assertQueue(QUEUES.EMAIL_SEND, { durable: true });

    channel.prefetch(5);

    log("INFO", "Email Router ready");

    channel.consume(QUEUES.EMAIL_ROUTE, async (msg) => {
      if (!msg) return;

      let emailId;

      try {
        emailId = JSON.parse(msg.content.toString()).emailId;

        /* =========================
           LOAD EMAIL
        ========================= */
        const email = await Email.findByPk(emailId);

        if (!email) {
          log("WARN", "Email not found", { emailId });
          return channel.ack(msg);
        }

        if (["sent", "routed", "failed"].includes(email.status)) {
          log("DEBUG", "Skipping email", {
            emailId,
            status: email.status,
          });
          return channel.ack(msg);
        }

        if (email.status !== "pending") {
          return channel.ack(msg);
        }

        /* =========================
           MTA DETECTION (for analytics only)
        ========================= */
        const mta = await mtaDetectorCache.detect(email.recipientEmail);
        const provider = mta.provider || EmailProvider.UNKNOWN;

        log("DEBUG", "Provider detected", {
          emailId,
          recipient: email.recipientEmail,
          provider,
          confidence: mta.confidence,
        });

        /* =========================
           PROVIDER RATE LIMIT
        ========================= */
        const windowKey = `rate:${provider}:${Math.floor(Date.now() / 60000)}`;
        const count = await redis.incr(windowKey);
        await redis.expire(windowKey, 60);

        const limit = PROVIDER_LIMITS[provider] || PROVIDER_LIMITS.default;

        if (count > limit) {
          await redis.decr(windowKey);

          log("WARN", "Provider rate limit hit, requeueing", {
            emailId,
            provider,
            limit,
          });

          setTimeout(() => {
            channel.sendToQueue(QUEUES.EMAIL_ROUTE, msg.content, {
              persistent: true,
            });
          }, 5000);

          return channel.ack(msg);
        }

        /* =========================
           USE CAMPAIGN ASSIGNED SENDER
        ========================= */
        const sender = await getSender(email.senderType, email.senderId);

        if (!sender || !sender.isVerified) {
          throw new Error("Assigned sender not available or not verified");
        }

        log("INFO", "Using campaign-assigned sender", {
          emailId,
          senderId: sender.id,
          senderType: email.senderType,
          senderEmail: sender.email,
        });

        /* =========================
           UPDATE EMAIL ROUTING INFO
        ========================= */
        await email.update({
          deliveryProvider: provider,
          deliveryConfidence: mta.confidence,
          routedAt: new Date(),
          status: "routed",
        });

        /* =========================
           FORWARD TO EMAIL_SEND
        ========================= */
        const sendPayload = {
          emailId,
          senderType: email.senderType, // pass through
        };

        channel.sendToQueue(
          QUEUES.EMAIL_SEND,
          Buffer.from(JSON.stringify(sendPayload)),
          { persistent: true },
        );

        log("INFO", "Email forwarded to send queue", {
          emailId,
          provider,
          senderType: email.senderType,
        });

        channel.ack(msg);
      } catch (err) {
        log("ERROR", "Routing failed", {
          emailId,
          error: err.message,
        });

        try {
          const email = await Email.findByPk(emailId);
          if (email) {
            await email.update({
              status: "failed",
              lastError: err.message.slice(0, 500),
              failedAt: new Date(),
            });
          }
        } catch (updateErr) {
          console.error("Failed to update email:", updateErr.message);
        }

        channel.ack(msg);
      }
    });
  } catch (err) {
    console.error("FATAL: Email Router failed to start:", err);
    process.exit(1);
  }
})();
