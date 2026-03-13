import "../models/index.js";
import { initGlobalErrorHandlers } from "../utils/error-handler.js";
initGlobalErrorHandlers();
import Redis from "ioredis";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { randomUUID } from "crypto";
import axios from "axios";
import dns from "dns/promises";
import fs from "fs";
import path from "path";

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
import {
  createImapConnection,
  resolveFolder,
  appendToFolder,
} from "../utils/imap-helper.js";

import { HttpsProxyAgent } from "https-proxy-agent";

import { getNextProxy } from "../utils/proxy-fetcher.js";

const redis = new Redis(process.env.REDIS_URL);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* =========================
   DNS PRE-SEND VERIFICATION
   Warns if SPF / DKIM / DMARC are missing for the sender's domain.
   Does NOT block delivery — only logs issues.
========================= */

const DKIM_SELECTORS_TO_PROBE = [
  "default",
  "mail",
  "dkim",
  "smtp",
  "k1",
  "selector1",
  "selector2",
];
const _dnsCache = new Map(); // domain → { spf, dkim, dmarc, ts }
const DNS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function checkSenderDns(domain) {
  const cached = _dnsCache.get(domain);
  if (cached && Date.now() - cached.ts < DNS_CACHE_TTL_MS) return cached;

  const result = { spf: false, dkim: false, dkimSelector: null, dmarc: false };

  // SPF
  try {
    const txtRecords = await dns.resolveTxt(domain);
    result.spf = txtRecords
      .flat()
      .some((r) => r.toLowerCase().startsWith("v=spf1"));
  } catch {
    /* no SPF found */
  }

  // DKIM — probe common selectors
  for (const sel of DKIM_SELECTORS_TO_PROBE) {
    try {
      const records = await dns.resolveTxt(`${sel}._domainkey.${domain}`);
      if (records.flat().join("").includes("v=DKIM1")) {
        result.dkim = true;
        result.dkimSelector = sel;
        break;
      }
    } catch {
      /* selector not found */
    }
  }

  // DMARC
  try {
    const dmarcRecords = await dns.resolveTxt(`_dmarc.${domain}`);
    result.dmarc = dmarcRecords
      .flat()
      .join("")
      .toLowerCase()
      .startsWith("v=dmarc1");
  } catch {
    /* no DMARC found */
  }

  result.ts = Date.now();
  _dnsCache.set(domain, result);
  return result;
}

/* =========================
   SMTP TRANSPORTER CACHE
   Reuse transporters per sender — avoids creating a new one per email.
   TTL: 30 minutes. Evicted on auth/connection errors.
========================= */
const transporterCache = new Map(); // senderId → { transporter, expiresAt }
const TRANSPORTER_TTL_MS = 30 * 60 * 1000; // 30 minutes

function getOrCreateTransporter(sender, proxy = null) {
  const cacheKey = `${sender.id}:${proxy || 'direct'}`;
  const cached = transporterCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.transporter;
  }

  const transportConfig = {
    host: sender.smtpHost,
    port: sender.smtpPort,
    secure: sender.smtpSecure,
    auth: {
      user: sender.smtpUsername,
      pass: sender.smtpPassword,
    },
    tls: {
      rejectUnauthorized: false,
    },
  };

  if (proxy) {
    transportConfig.proxy = proxy;
  }

  const transporter = nodemailer.createTransport(transportConfig);

  transporterCache.set(cacheKey, {
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

async function startWorker() {
  let channel;
  try {
    channel = await getChannel();
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

        const proxy = await getNextProxy();
        if (proxy) log("DEBUG", "🌐 Using proxy for this send", { proxy });

        emailRecord = await Email.findByPk(emailId);

        if (!emailRecord || emailRecord.status !== "routed") {
          return channel.ack(msg);
        }

        log("DEBUG", "🚀 Processing email for delivery", {
          emailId,
          recipient: emailRecord.recipientEmail,
          senderType,
        });

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

        if (!sender || !sender.isVerified)
          throw new Error("Sender not verified");

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
          const transporter = getOrCreateTransporter(sender, proxy);

          // 🔍 DNS pre-send check — warn if SPF/DKIM/DMARC are missing
          checkSenderDns(domain)
            .then((dnsResult) => {
              const issues = [];
              if (!dnsResult.spf) issues.push("SPF record missing");
              if (!dnsResult.dkim)
                issues.push(
                  "DKIM record missing (check aaPanel DKIM settings)",
                );
              if (!dnsResult.dmarc) issues.push("DMARC record missing");
              if (issues.length) {
                log(
                  "WARN",
                  "⚠️ Deliverability issues detected — emails may land in spam",
                  {
                    domain,
                    senderId: sender.id,
                    issues,
                  },
                );
              }
            })
            .catch(() => { }); // non-blocking

          try {
            const mailOptions = {
              from: `"${sender.displayName}" <${sender.email}>`,
              to: emailRecord.recipientEmail,
              subject: emailRecord.subject,
              html: emailRecord.htmlBody,
              messageId,
            };

            if (
              emailRecord.htmlBody &&
              emailRecord.htmlBody.includes("/tracking/unsubscribe/")
            ) {
              const appUrl =
                process.env.APP_URL ||
                process.env.VITE_API_URL ||
                "http://localhost:8080";
              const unsubUrl = `${appUrl}/api/v1/tracking/unsubscribe/${emailId}`;
              mailOptions.headers = {
                "List-Unsubscribe": `<${unsubUrl}>`,
                "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
              };
            }

            await transporter.sendMail(mailOptions);

            // 📤 APPEND TO SENT FOLDER (SMTP Manual persistence)
            try {
              log("DEBUG", "📥 Appending automated SMTP email to Sent folder", {
                senderId: sender.id,
              });
              const composer = new MailComposer(mailOptions);
              const messageBuffer = await composer.compile().build();

              let imapForAppend;
              try {
                imapForAppend = await createImapConnection(sender);
                const resolvedSent = await resolveFolder(
                  imapForAppend,
                  sender,
                  "SENT",
                );
                await appendToFolder(
                  imapForAppend,
                  resolvedSent,
                  messageBuffer,
                );
                log("INFO", "✅ Automated SMTP email appended to Sent folder", {
                  senderId: sender.id,
                  folder: resolvedSent,
                });

                // 🧹 CLEAR CACHE so UI updates
                const cachePattern = `mailbox:smtp:${sender.id}:messages:*`;
                const keys = await redis.keys(cachePattern);
                if (keys.length > 0) await redis.del(keys);
              } catch (imapErr) {
                log(
                  "ERROR",
                  "❌ Failed to append automated SMTP email to Sent folder",
                  {
                    senderId: sender.id,
                    error: imapErr.message,
                  },
                );
              } finally {
                if (imapForAppend) {
                  try {
                    imapForAppend.end();
                  } catch (e) {
                    console.log(e);
                  }
                }
              }
            } catch (composerErr) {
              log("ERROR", "❌ Failed to compose MIME for IMAP append", {
                error: composerErr.message,
              });
            }
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

          let rawHeaders =
            `From: ${sender.email}\r\n` +
            `To: ${emailRecord.recipientEmail}\r\n` +
            `Subject: ${emailRecord.subject}\r\n`;

          if (
            emailRecord.htmlBody &&
            emailRecord.htmlBody.includes("/tracking/unsubscribe/")
          ) {
            const appUrl =
              process.env.APP_URL ||
              process.env.VITE_API_URL ||
              "http://localhost:8080";
            const unsubUrl = `${appUrl}/api/v1/tracking/unsubscribe/${emailId}`;
            rawHeaders +=
              `List-Unsubscribe: <${unsubUrl}>\r\n` +
              "List-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n";
          }

          const raw =
            rawHeaders +
            "Content-Type: text/html; charset=UTF-8\r\n\r\n" +
            emailRecord.htmlBody;

          const encoded = Buffer.from(raw)
            .toString("base64")
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");

          const axiosConfig = {
            headers: {
              Authorization: `Bearer ${token.accessToken}`,
            },
          };

          if (proxy) {
            axiosConfig.httpsAgent = new HttpsProxyAgent(proxy);
            axiosConfig.proxy = false;
          }

          const res = await axios.post(
            "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
            { raw: encoded },
            axiosConfig
          );

          providerMessageId = res.data.id;
          providerThreadId = res.data.threadId;
          providerConversationId = res.data.threadId; // Gmail uses threadId for threading
        }

        if (senderType === "outlook") {
          const token = await getValidMicrosoftToken(sender);

          // 1. Create the message (not sendMail) so we get IDs back
          const messagePayload = {
            subject: emailRecord.subject,
            body: { contentType: "HTML", content: emailRecord.htmlBody },
            toRecipients: [
              { emailAddress: { address: emailRecord.recipientEmail } },
            ],
          };

          // 🚀 Microsoft Graph API requires custom headers to start with 'x-' or 'X-'
          messagePayload.internetMessageHeaders = [
            { name: "X-Unibox-Email-Id", value: emailId },
          ];

          if (
            emailRecord.htmlBody &&
            emailRecord.htmlBody.includes("/tracking/unsubscribe/")
          ) {
            const appUrl =
              process.env.APP_URL ||
              process.env.VITE_API_URL ||
              "http://localhost:8080";
            const unsubUrl = `${appUrl}/api/v1/tracking/unsubscribe/${emailId}`;
            messagePayload.internetMessageHeaders.push(
              { name: "X-List-Unsubscribe", value: `<${unsubUrl}>` },
              {
                name: "X-List-Unsubscribe-Post",
                value: "List-Unsubscribe=One-Click",
              },
            );
          }

          const axiosConfig = { headers: { Authorization: `Bearer ${token}` } };
          if (proxy) {
            axiosConfig.httpsAgent = new HttpsProxyAgent(proxy);
            axiosConfig.proxy = false;
          }

          const res = await axios.post(
            "https://graph.microsoft.com/v1.0/me/messages",
            messagePayload,
            axiosConfig
          );

          providerMessageId = res.data.id;
          providerConversationId = res.data.conversationId;
          providerThreadId = res.data.conversationId; // Map to threadId for unified tracking

          // 2. Send the message
          await axios.post(
            `https://graph.microsoft.com/v1.0/me/messages/${res.data.id}/send`,
            {},
            axiosConfig
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
          const statsUpdates = [
            CampaignSend.update(
              {
                status: "sent",
                sentAt: new Date(),
              },
              { where: { emailId: emailRecord.id } },
            ),
          ];

          // Only increment totalSent for Step 0 (the initial outreach)
          // This ensures totalSent represents unique recipients reached.
          if (emailRecord.metadata?.step === 0) {
            statsUpdates.push(
              Campaign.increment("totalSent", {
                where: { id: emailRecord.campaignId },
              })
            );
          }

          await Promise.all(statsUpdates);
        }

        log("INFO", "✅ Email sent successfully", {
          emailId,
          recipient: emailRecord.recipientEmail,
          providerMessageId,
          domain,
        });

        channel.ack(msg);
      } catch (err) {
        log("ERROR", "Send failed", { error: err.message, stack: err.stack });

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
