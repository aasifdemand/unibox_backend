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
   PROVIDER → SENDER TYPE MAP
========================= */
function mapProviderToSenderType(provider) {
  switch (provider) {
    case EmailProvider.GOOGLE:
      return "gmail";
    case EmailProvider.MICROSOFT:
      return "outlook";
    default:
      return "smtp";
  }
}

/* =========================
   GET SENDER BY TYPE AND ID
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
   FIND AVAILABLE SENDER BY TYPE - FIXED COLUMN NAMES
========================= */
async function findAvailableSender(senderType) {
  switch (senderType) {
    case "gmail":
      return await GmailSender.findOne({
        where: {
          isVerified: true,
          // 🔴 REMOVED isActive - doesn't exist in GmailSender model
          // 🔴 REMOVED expiresAt check - handle in token refresh
        },
        order: [
          ["lastUsedAt", "ASC"],
          ["dailySentCount", "ASC"],
        ],
      });

    case "outlook":
      return await OutlookSender.findOne({
        where: {
          isVerified: true,
          // 🔴 REMOVED isActive - doesn't exist in OutlookSender model
          // 🔴 REMOVED expiresAt check - handle in token refresh
        },
        order: [
          ["lastUsedAt", "ASC"],
          ["dailySentCount", "ASC"],
        ],
      });

    case "smtp":
      return await SmtpSender.findOne({
        where: {
          isVerified: true,
          isActive: true, // ✅ This exists in SmtpSender model
        },
        order: [
          ["lastUsedAt", "ASC"], // ✅ This exists in SmtpSender model
          ["dailySentCount", "ASC"],
        ],
      });

    default:
      return null;
  }
}

/* =========================
   GET ALL AVAILABLE SENDERS - FIXED COLUMN NAMES
========================= */
async function getAllAvailableSenders() {
  const [gmailSenders, outlookSenders, smtpSenders] = await Promise.all([
    GmailSender.findAll({
      where: {
        isVerified: true,
        // 🔴 REMOVED isActive and expiresAt
      },
      order: [
        ["lastUsedAt", "ASC"],
        ["dailySentCount", "ASC"],
      ],
    }),
    OutlookSender.findAll({
      where: {
        isVerified: true,
        // 🔴 REMOVED isActive and expiresAt
      },
      order: [
        ["lastUsedAt", "ASC"],
        ["dailySentCount", "ASC"],
      ],
    }),
    SmtpSender.findAll({
      where: {
        isVerified: true,
        isActive: true, // ✅ This exists in SmtpSender
      },
      order: [
        ["lastUsedAt", "ASC"],
        ["dailySentCount", "ASC"],
      ],
    }),
  ]);

  return [
    ...gmailSenders.map((s) => ({ ...s.toJSON(), senderType: "gmail" })),
    ...outlookSenders.map((s) => ({ ...s.toJSON(), senderType: "outlook" })),
    ...smtpSenders.map((s) => ({ ...s.toJSON(), senderType: "smtp" })),
  ];
}

/* =========================
   MAIN WORKER
========================= */
(async () => {
  try {
    console.log("\n" + "=".repeat(80));
    console.log(
      "🚀 EMAIL-ROUTER WORKER STARTING AT:",
      new Date().toISOString(),
    );
    console.log("=".repeat(80));

    const channel = await getChannel();
    await channel.assertQueue(QUEUES.EMAIL_ROUTE, { durable: true });
    await channel.assertQueue(QUEUES.EMAIL_SEND, { durable: true });

    channel.prefetch(5);

    // Check queue status
    const routeQueueStatus = await channel.checkQueue(QUEUES.EMAIL_ROUTE);
    const sendQueueStatus = await channel.checkQueue(QUEUES.EMAIL_SEND);

    console.log("📊 Queue Status:", {
      [QUEUES.EMAIL_ROUTE]: {
        messages: routeQueueStatus.messageCount,
        consumers: routeQueueStatus.consumerCount,
      },
      [QUEUES.EMAIL_SEND]: {
        messages: sendQueueStatus.messageCount,
        consumers: sendQueueStatus.consumerCount,
      },
    });

    log("INFO", "🚦 Email Router ready (multi-sender version)");
    console.log("✅ Email Router worker is now LISTENING for messages");
    console.log("=".repeat(80) + "\n");

    channel.consume(QUEUES.EMAIL_ROUTE, async (msg) => {
      if (!msg) return;

      console.log("\n" + "-".repeat(60));
      console.log("📨 ROUTER: Received message from queue:", {
        queue: QUEUES.EMAIL_ROUTE,
        content: msg.content.toString(),
      });

      let emailId;

      try {
        emailId = JSON.parse(msg.content.toString()).emailId;

        /* =========================
           LOAD EMAIL
        ========================= */
        const email = await Email.findByPk(emailId);
        if (!email) {
          log("WARN", "Email not found", { emailId });
          console.log(`❌ Email not found: ${emailId}`);
          return channel.ack(msg);
        }

        console.log("📧 Email record loaded:", {
          id: email.id,
          status: email.status,
          currentSenderId: email.senderId,
          currentSenderType: email.senderType,
          recipientEmail: email.recipientEmail,
          campaignId: email.campaignId,
        });

        /* =========================
           STATUS-BASED ROUTING DECISIONS
        ========================= */

        // 🔴 CASE 1: Already sent - skip
        if (email.status === "sent") {
          log("DEBUG", "⏭️ Email already sent", { emailId });
          console.log(`⏭️ Email already sent: ${emailId}`);
          return channel.ack(msg);
        }

        // 🔴 CASE 2: Already routed - skip
        if (email.status === "routed") {
          log("DEBUG", "⏭️ Email already routed", { emailId });
          console.log(`⏭️ Email already routed: ${emailId}`);
          return channel.ack(msg);
        }

        // 🔴 CASE 3: Failed - skip for now
        if (email.status === "failed") {
          log("DEBUG", "⏭️ Email failed, skipping", { emailId });
          console.log(`⏭️ Email failed: ${emailId}`);
          return channel.ack(msg);
        }

        // ✅ CASE 4: Pending - needs routing (this is what we want!)
        if (email.status === "pending") {
          console.log("✅ Email is PENDING - proceeding with routing");
        }

        /* =========================
           MTA DETECTION
        ========================= */
        console.log("🔍 Detecting MTA for:", email.recipientEmail);
        const mta = await mtaDetectorCache.detect(email.recipientEmail);
        const provider = mta.provider || EmailProvider.UNKNOWN;

        log("DEBUG", "📡 Provider detected", {
          emailId,
          recipient: email.recipientEmail,
          provider,
          confidence: mta.confidence,
        });

        console.log("📡 Provider detected:", {
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

          log("WARN", "⏳ Provider rate limit hit, re-queueing", {
            emailId,
            provider,
            limit,
            currentCount: count,
          });

          console.log(`⏳ Rate limit hit for ${provider}, re-queueing in 5s`);

          setTimeout(() => {
            channel.sendToQueue(QUEUES.EMAIL_ROUTE, msg.content, {
              persistent: true,
            });
          }, 5000);

          return channel.ack(msg);
        }

        /* =========================
           SENDER SELECTION
        ========================= */
        const preferredSenderType = mapProviderToSenderType(provider);
        let sender = null;
        let selectedSenderType = null;

        // 1️⃣ Try provider-matched sender
        if (preferredSenderType) {
          sender = await findAvailableSender(preferredSenderType);
          selectedSenderType = preferredSenderType;
          log("DEBUG", "Trying provider-matched sender", {
            emailId,
            provider,
            preferredSenderType,
            found: !!sender,
          });
        }

        // 2️⃣ Fallback to SMTP
        if (!sender && preferredSenderType !== "smtp") {
          sender = await findAvailableSender("smtp");
          selectedSenderType = "smtp";
          log("DEBUG", "Falling back to SMTP sender", {
            emailId,
            found: !!sender,
          });
        }

        // 3️⃣ Any available sender
        if (!sender) {
          const allSenders = await getAllAvailableSenders();
          if (allSenders.length > 0) {
            sender = allSenders[0];
            selectedSenderType = sender.senderType;
            log("DEBUG", "Using any available sender", {
              emailId,
              senderType: selectedSenderType,
              senderId: sender.id,
            });
          }
        }

        if (!sender) {
          throw new Error("No verified sender available");
        }

        console.log("✅ Selected sender:", {
          id: sender.id,
          email: sender.email,
          type: selectedSenderType,
        });

        /* =========================
           UPDATE EMAIL WITH ROUTING INFO
        ========================= */
        await email.update({
          senderId: sender.id,
          senderType: selectedSenderType,
          deliveryProvider: provider,
          deliveryConfidence: mta.confidence,
          routedAt: new Date(),
          status: "routed", // 🔴 CRITICAL: Set to 'routed' after successful routing
        });

        console.log("✅ Email updated with routing info, status: routed");

        // Update sender metrics
        const senderUpdate = {
          lastUsedAt: new Date(),
        };

        if (sender.dailySentCount !== undefined) {
          senderUpdate.dailySentCount = (sender.dailySentCount || 0) + 1;
        }

        switch (selectedSenderType) {
          case "gmail":
            await GmailSender.update(senderUpdate, {
              where: { id: sender.id },
            });
            break;
          case "outlook":
            await OutlookSender.update(senderUpdate, {
              where: { id: sender.id },
            });
            break;
          case "smtp":
            await SmtpSender.update(senderUpdate, { where: { id: sender.id } });
            break;
        }

        /* =========================
           SEND TO EMAIL_SEND QUEUE - CRITICAL!
        ========================= */
        const sendPayload = {
          emailId,
          senderType: selectedSenderType,
        };

        const sent = channel.sendToQueue(
          QUEUES.EMAIL_SEND,
          Buffer.from(JSON.stringify(sendPayload)),
          { persistent: true },
        );

        if (sent) {
          log("INFO", "➡️ Email forwarded to send queue", {
            emailId,
            recipient: email.recipientEmail,
            provider,
            senderType: selectedSenderType,
            senderId: sender.id,
            senderEmail: sender.email,
          });

          console.log("✅ Email forwarded to EMAIL_SEND queue:", {
            queue: QUEUES.EMAIL_SEND,
            emailId,
            senderType: selectedSenderType,
          });
        } else {
          console.error("❌ Failed to send to EMAIL_SEND queue");
        }

        channel.ack(msg);
        console.log("-".repeat(60) + "\n");
      } catch (err) {
        log("ERROR", "❌ Routing failed", {
          emailId,
          error: err.message,
          stack: err.stack,
        });

        console.error("❌ Routing failed:", {
          emailId,
          error: err.message,
        });

        // Update email status to failed
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
          console.error("Failed to update email status:", updateErr.message);
        }

        channel.ack(msg);
      }
    });
  } catch (err) {
    console.error("💥 FATAL: Email router failed to start:", err);
    process.exit(1);
  }
})();
