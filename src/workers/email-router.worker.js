import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();
import Redis from "ioredis";
import Email from "../models/email.model.js";
import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import SenderHealth from "../models/sender-health.model.js";

import { getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { mtaDetectorCache } from "../services/mta-detector-cache.service.js";
import { EmailProvider } from "../enums/email-provider.enum.js";

const redis = new Redis(process.env.REDIS_URL);

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
   SENDER LOADER
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
   POLICY ENGINE
========================= */

function buildBasePolicy(mta, senderType) {
  const isGateway = [
    EmailProvider.MIMECAST,
    EmailProvider.PROOFPOINT,
    EmailProvider.BARRACUDA,
  ].includes(mta.provider);

  if (senderType === "smtp") {
    if (isGateway) {
      return {
        limitPerMinute: 3,
        chunkSize: 2,
        delayMs: 5000,
        injectTracking: false,
      };
    }
    return {
      limitPerMinute: 6,
      chunkSize: 3,
      delayMs: 3000,
      injectTracking: false,
    };
  }

  if (senderType === "gmail")
    return {
      limitPerMinute: 18,
      chunkSize: 6,
      delayMs: 1000,
      injectTracking: true,
    };

  if (senderType === "outlook")
    return {
      limitPerMinute: 12,
      chunkSize: 4,
      delayMs: 1500,
      injectTracking: true,
    };

  return {
    limitPerMinute: 5,
    chunkSize: 2,
    delayMs: 3000,
    injectTracking: false,
  };
}

/* =========================
   AUTO-THROTTLE BY REPUTATION
========================= */

function applyReputationThrottle(policy, reputationScore) {
  if (reputationScore < 40) {
    throw new Error("Sender reputation critical — blocked");
  }

  if (reputationScore < 60) {
    policy.limitPerMinute *= 0.5;
  } else if (reputationScore < 80) {
    policy.limitPerMinute *= 0.75;
  }

  return policy;
}

/* =========================
   ROUTER WORKER
========================= */

async function startWorker() {
  let channel;
  try {
    channel = await getChannel();
    await channel.assertQueue(QUEUES.EMAIL_ROUTE, { durable: true });
    await channel.assertQueue(QUEUES.EMAIL_SEND, { durable: true });
    channel.prefetch(5);

    log("INFO", "Advanced Email Router Started");

    channel.consume(QUEUES.EMAIL_ROUTE, async (msg) => {
      if (!msg) return;

      log("DEBUG", "📥 Received routing request", { content: msg.content.toString() });

      try {
        const { emailId } = JSON.parse(msg.content.toString());
        const email = await Email.findByPk(emailId);

        if (!email || email.status !== "pending") {
          return channel.ack(msg);
        }

        const sender = await getSender(email.senderType, email.senderId);
        if (!sender || !sender.isVerified) {
          throw new Error("Sender not verified");
        }

        /* =========================
           REPUTATION CHECK
        ========================= */

        const health = await SenderHealth.findOne({
          where: { senderId: email.senderId },
        });

        const reputationScore = health?.reputationScore ?? 100;

        /* =========================
           MTA DETECTION
        ========================= */

        log("DEBUG", "🔍 Detecting MTA", { recipient: email.recipientEmail });
        const mta = await mtaDetectorCache.detect(email.recipientEmail);
        log("DEBUG", "✅ MTA Detected", { provider: mta.provider });

        let policy = buildBasePolicy(mta, email.senderType);
        policy = applyReputationThrottle(policy, reputationScore);

        /* =========================
           RATE LIMIT (PER SENDER)
        ========================= */

        const minuteWindow = Math.floor(Date.now() / 60000);
        const rateKey = `rate:${email.senderId}:${minuteWindow}`;

        const count = await redis.incr(rateKey);
        await redis.expire(rateKey, 60);

        if (count > policy.limitPerMinute) {
          await redis.decr(rateKey);
          log("DEBUG", "⏳ Rate limited, requeuing", { emailId });
          setTimeout(() => {
            channel.sendToQueue(QUEUES.EMAIL_ROUTE, msg.content, {
              persistent: true,
            });
          }, 4000);

          return channel.ack(msg);
        }

        /* =========================
           CHUNK CONTROL
        ========================= */

        const chunkKey = `chunk:${email.senderId}:${minuteWindow}`;
        const chunkCount = await redis.incr(chunkKey);
        await redis.expire(chunkKey, 60);

        if (chunkCount % policy.chunkSize === 0) {
          const delay = policy.delayMs + Math.floor(Math.random() * 2000);
          log("DEBUG", "⏸️ Applying chunk delay", { delay });
          await new Promise((r) => setTimeout(r, delay));
        }

        await email.update({
          deliveryProvider: mta.provider,
          deliveryConfidence: mta.confidence,
          routedAt: new Date(),
          status: "routed",
        });

        channel.sendToQueue(
          QUEUES.EMAIL_SEND,
          Buffer.from(
            JSON.stringify({ emailId, senderType: email.senderType, policy }),
          ),
          { persistent: true },
        );

        channel.ack(msg);
      } catch (err) {
        log("ERROR", "Routing failed", { error: err.message, stack: err.stack });
        channel.ack(msg);
      }
    });

    // Listen for channel closure to trigger restart
    channel.on("close", () => {
      log("WARN", "Channel closed, restarting in 5s...");
      setTimeout(startWorker, 5000);
    });

  } catch (err) {
    log("ERROR", "Worker failed to start", { error: err.message });
    setTimeout(startWorker, 5000);
  }
}

startWorker();
