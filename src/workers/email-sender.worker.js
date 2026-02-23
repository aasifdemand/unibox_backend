import "../models/index.js";
import Redis from "ioredis";
import nodemailer from "nodemailer";
import { randomUUID } from "crypto";
import axios from "axios";

import Email from "../models/email.model.js";
import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import Campaign from "../models/campaign.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import EmailEvent from "../models/email-event.model.js";
import BounceEvent from "../models/bounce-event.model.js";
import SenderHealth from "../models/sender-health.model.js";

import { smtpWarmupService } from "../services/smtp-warmup.service.js";
import { getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { refreshGoogleToken } from "../utils/refresh-google-token.js";
import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";

const redis = new Redis(process.env.REDIS_URL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================
   SMTP TRANSPORTER CACHE
   Reuse transporters per sender — avoids creating a new one per email.
   TTL: 30 minutes. Evicted on auth/connection errors.
========================= */
const transporterCache = new Map(); // senderId → { transporter, expiresAt }
const TRANSPORTER_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getOrCreateTransporter(sender) {
  const cached = transporterCache.get(sender.id);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.transporter;
  }

  const transporter = nodemailer.createTransport({
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpSecure,
    auth: {
      user: sender.smtpUsername,
      pass: sender.smtpPassword,
    },
  });

  transporterCache.set(sender.id, {
    transporter,
    expiresAt: Date.now() + TRANSPORTER_TTL_MS,
  });

  return transporter;
}

function evictTransporter(senderId) {
  transporterCache.delete(senderId);
}

const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "email-sender",
      level,
      message,
      ...meta,
    }),
  );

/* =========================
   BOUNCE CLASSIFIER
========================= */

function classifyBounce(error) {
  const msg = error.message.toLowerCase();

  if (
    msg.includes("550") ||
    msg.includes("user unknown") ||
    msg.includes("does not exist") ||
    msg.includes("mailbox unavailable")
  ) {
    return "hard";
  }

  if (msg.includes("spam") || msg.includes("blacklisted")) {
    return "complaint";
  }

  return "soft";
}

/* =========================
   MESSAGE ID
========================= */

function generateMessageId(emailId, domain) {
  return `<${emailId}.${randomUUID().slice(0, 8)}.${Date.now()}@${domain}>`;
}

/* =========================
   WORKER START
========================= */

(async () => {
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.EMAIL_SEND, { durable: true });
  channel.prefetch(5);

  log("INFO", "Advanced Email Sender Started");

  channel.consume(QUEUES.EMAIL_SEND, async (msg) => {
    if (!msg) return;

    let emailRecord;

    try {
      const {
        emailId,
        senderType,
        policy = {},
      } = JSON.parse(msg.content.toString());

      emailRecord = await Email.findByPk(emailId);

      if (!emailRecord || emailRecord.status !== "routed") {
        return channel.ack(msg);
      }

      /* =========================
         LOAD SENDER
      ========================= */

      let sender;

      if (senderType === "smtp")
        sender = await SmtpSender.findByPk(emailRecord.senderId);
      if (senderType === "gmail")
        sender = await GmailSender.findByPk(emailRecord.senderId);
      if (senderType === "outlook")
        sender = await OutlookSender.findByPk(emailRecord.senderId);

      if (!sender || !sender.isVerified) throw new Error("Sender not verified");

      /* =========================
         REPUTATION BLOCK
      ========================= */

      const health = await SenderHealth.findOne({
        where: { senderId: sender.id },
      });

      if (health?.blacklisted) throw new Error("Sender IP blacklisted");

      if (health?.reputationScore < 40)
        throw new Error("Sender reputation critical");

      /* =========================
         SMTP WARMUP CONTROL
      ========================= */

      if (senderType === "smtp") {
        const maxDaily = await smtpWarmupService.getSenderDailyLimit(sender);

        const today = new Date().toISOString().split("T")[0];
        const warmupKey = `warmup:${sender.id}:${today}`;

        const sentToday = await redis.incr(warmupKey);
        await redis.expire(warmupKey, 86400);

        if (sentToday > maxDaily) {
          throw new Error("Warmup daily limit reached");
        }
      }

      /* =========================
         HUMAN-LIKE DELAY
      ========================= */

      const jitter = Math.floor(Math.random() * 2000);
      await sleep((policy.delayMs || 1000) + jitter);

      /* =========================
         SEND EMAIL
      ========================= */

      const domain = sender.email.split("@")[1];
      const messageId = generateMessageId(emailId, domain);

      let providerMessageId = messageId;
      let providerThreadId = null;
      let providerConversationId = null;

      if (senderType === "smtp") {
        const transporter = getOrCreateTransporter(sender);

        try {
          await transporter.sendMail({
            from: `"${sender.displayName}" <${sender.email}>`,
            to: emailRecord.recipientEmail,
            subject: emailRecord.subject,
            html: emailRecord.htmlBody,
            messageId,
          });
        } catch (smtpErr) {
          // Evict cached transporter on auth/connection errors so next send gets a fresh one
          if (
            smtpErr.code === "EAUTH" ||
            smtpErr.code === "ECONNECTION" ||
            smtpErr.responseCode >= 500
          ) {
            evictTransporter(sender.id);
          }
          throw smtpErr;
        }
      }

      if (senderType === "gmail") {
        const token = await refreshGoogleToken(sender);

        const raw =
          `From: ${sender.email}\r\n` +
          `To: ${emailRecord.recipientEmail}\r\n` +
          `Subject: ${emailRecord.subject}\r\n` +
          `Content-Type: text/html; charset=UTF-8\r\n\r\n` +
          emailRecord.htmlBody;

        const encoded = Buffer.from(raw)
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        const res = await axios.post(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
          { raw: encoded },
          {
            headers: {
              Authorization: `Bearer ${token.accessToken}`,
            },
          },
        );

        providerMessageId = res.data.id;
        providerThreadId = res.data.threadId;
        providerConversationId = res.data.threadId; // Gmail uses threadId for threading
      }

      if (senderType === "outlook") {
        const token = await getValidMicrosoftToken(sender);

        // 1. Create the message (not sendMail) so we get IDs back
        const res = await axios.post(
          `https://graph.microsoft.com/v1.0/me/messages`,
          {
            subject: emailRecord.subject,
            body: { contentType: "HTML", content: emailRecord.htmlBody },
            toRecipients: [
              { emailAddress: { address: emailRecord.recipientEmail } },
            ],
          },
          { headers: { Authorization: `Bearer ${token}` } },
        );

        providerMessageId = res.data.id;
        providerConversationId = res.data.conversationId;
        providerThreadId = res.data.conversationId; // Map to threadId for unified tracking

        // 2. Send the message
        await axios.post(
          `https://graph.microsoft.com/v1.0/me/messages/${res.data.id}/send`,
          {},
          { headers: { Authorization: `Bearer ${token}` } },
        );
      }

      /* =========================
         SUCCESS UPDATE
      ========================= */

      await emailRecord.update({
        status: "sent",
        sentAt: new Date(),
        providerMessageId,
        providerThreadId,
        providerConversationId,
      });

      await EmailEvent.create({
        emailId,
        eventType: "sent",
        eventTimestamp: new Date(),
      });

      // 📊 UPDATE CAMPAIGN STATS
      if (emailRecord.campaignId) {
        await Promise.all([
          Campaign.increment("totalSent", {
            where: { id: emailRecord.campaignId },
          }),
          CampaignSend.update(
            { 
              status: "sent",
              sentAt: new Date() 
            },
            { where: { emailId: emailRecord.id } },
          ),
        ]);
      }

      channel.ack(msg);
    } catch (err) {
      log("ERROR", "Send failed", { error: err.message });

      if (emailRecord) {
        await emailRecord.update({
          status: "failed",
          lastError: err.message,
        });

        // 📊 UPDATE CAMPAIGN SEND STATUS
        await CampaignSend.update(
          { status: "failed" },
          { where: { emailId: emailRecord.id } },
        );

        const bounceType = classifyBounce(err);
        await BounceEvent.create({
          emailId: emailRecord.id,
          bounceType,
          reason: err.message,
          occurredAt: new Date(),
        });

        // 🛑 STOP RECIPIENT ON HARD BOUNCE
        if (bounceType === "hard" && emailRecord.recipientId) {
          await CampaignRecipient.update(
            { status: "bounced", nextRunAt: null },
            { where: { id: emailRecord.recipientId } },
          );
        }
      }

      channel.ack(msg);
    }
  });
})();
