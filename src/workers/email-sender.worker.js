import "../models/index.js";
import nodemailer from "nodemailer";
import { randomUUID } from "crypto";
import { google } from "googleapis";

import Email from "../models/email.model.js";
import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import EmailEvent from "../models/email-event.model.js";
import BounceEvent from "../models/bounce-event.model.js";
import Campaign from "../models/campaign.model.js";

import { getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";
import { refreshGoogleToken } from "../utils/refresh-google-token.js";

/* =========================
   GLOBAL ERROR HANDLERS
========================= */
process.on("uncaughtException", (err) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "email-sender",
      level: "FATAL",
      message: "💥 UNCAUGHT EXCEPTION",
      error: err.message,
      stack: err.stack,
    }),
  );
  setTimeout(() => process.exit(1), 1000);
});

process.on("unhandledRejection", (err) => {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "email-sender",
      level: "FATAL",
      message: "💥 UNHANDLED REJECTION",
      error: err.message,
      stack: err.stack,
    }),
  );
});

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

function generateMessageId(emailId, domain) {
  return `<${emailId}.${randomUUID().slice(0, 8)}.${Date.now()}@${domain}>`;
}

/* =========================
   GET SENDER BY TYPE
========================= */
async function getSenderByType(senderId, senderType) {
  switch (senderType) {
    case "gmail":
      return await GmailSender.findByPk(senderId);
    case "outlook":
      return await OutlookSender.findByPk(senderId);
    case "smtp":
      return await SmtpSender.findByPk(senderId);
    default:
      throw new Error(`Unknown sender type: ${senderType}`);
  }
}

/* =========================
   SEND VIA GMAIL (GMAIL API)
========================= */
async function sendViaGmail(gmailSender, emailData, messageId) {
  try {
    const validToken = await refreshGoogleToken(gmailSender);
    if (!validToken) {
      throw new Error("Failed to get valid Google token");
    }

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
    );

    oauth2Client.setCredentials({
      access_token: validToken.accessToken,
      refresh_token: gmailSender.refreshToken,
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const rawMessage = [
      `From: "${gmailSender.displayName}" <${gmailSender.email}>`,
      `To: ${emailData.recipientEmail}`,
      `Subject: ${emailData.subject}`,
      `Message-ID: ${messageId}`,
      `Content-Type: text/html; charset="UTF-8"`,
      "",
      emailData.htmlBody,
    ].join("\n");

    const encodedMessage = Buffer.from(rawMessage)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.messages.send({
      userId: "me",
      requestBody: {
        raw: encodedMessage,
      },
    });

    log("DEBUG", "Gmail API send successful", {
      senderId: gmailSender.id,
      email: gmailSender.email,
    });
  } catch (error) {
    log("ERROR", "Gmail API send failed", {
      senderId: gmailSender.id,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/* =========================
   SEND VIA OUTLOOK (GRAPH API)
========================= */
async function sendViaOutlook(outlookSender, emailData, messageId) {
  try {
    const token = await getValidMicrosoftToken(outlookSender);
    if (!token) {
      throw new Error("Failed to get valid Microsoft token");
    }

    const res = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          subject: emailData.subject,
          body: {
            contentType: "HTML",
            content: emailData.htmlBody,
          },
          toRecipients: [
            { emailAddress: { address: emailData.recipientEmail } },
          ],
          internetMessageId: messageId,
          from: {
            emailAddress: {
              address: outlookSender.email,
              name: outlookSender.displayName,
            },
          },
        },
        saveToSentItems: true,
      }),
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Graph API ${res.status}: ${errorText}`);
    }

    log("DEBUG", "Outlook Graph API send successful", {
      senderId: outlookSender.id,
      email: outlookSender.email,
    });
  } catch (error) {
    log("ERROR", "Outlook API send failed", {
      senderId: outlookSender.id,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/* =========================
   SEND VIA SMTP
========================= */
async function sendViaSmtp(smtpSender, emailData, messageId) {
  try {
    if (
      !smtpSender.smtpHost ||
      !smtpSender.smtpPort ||
      !smtpSender.smtpUsername ||
      !smtpSender.smtpPassword
    ) {
      throw new Error("Incomplete SMTP configuration");
    }

    const transporter = nodemailer.createTransport({
      host: smtpSender.smtpHost,
      port: smtpSender.smtpPort,
      secure: smtpSender.smtpSecure !== false,
      auth: {
        user: smtpSender.smtpUsername,
        pass: smtpSender.smtpPassword,
      },
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });

    await transporter.sendMail({
      from: `"${smtpSender.displayName}" <${smtpSender.email}>`,
      to: emailData.recipientEmail,
      subject: emailData.subject,
      html: emailData.htmlBody,
      messageId,
      headers: {
        "X-Campaign-ID": emailData.campaignId,
        "X-Email-ID": emailData.emailId,
      },
    });

    log("DEBUG", "SMTP send successful", {
      senderId: smtpSender.id,
      email: smtpSender.email,
      host: smtpSender.smtpHost,
    });
  } catch (error) {
    log("ERROR", "SMTP send failed", {
      senderId: smtpSender.id,
      error: error.message,
      stack: error.stack,
    });
    throw error;
  }
}

/* =========================
   UPDATE SENDER METRICS
========================= */
async function updateSenderMetrics(senderId, senderType) {
  const updateData = {
    lastUsedAt: new Date(),
  };

  switch (senderType) {
    case "gmail":
      await GmailSender.update(updateData, {
        where: { id: senderId },
      });
      break;
    case "outlook":
      await OutlookSender.update(updateData, {
        where: { id: senderId },
      });
      break;
    case "smtp":
      // Check if column exists first
      try {
        await SmtpSender.update(updateData, {
          where: { id: senderId },
        });
      } catch (err) {
        // Column doesn't exist yet, skip
        log("DEBUG", "SmtpSender.lastUsedAt not available yet", {
          senderId,
          error: err.message,
        });
      }
      await SmtpSender.increment("dailySentCount", {
        by: 1,
        where: { id: senderId },
      });
      break;
  }
}

/* =========================
   MAIN WORKER
========================= */
(async () => {
  try {
    console.log("\n" + "=".repeat(80));
    console.log(
      "🚀 EMAIL-SENDER WORKER STARTING AT:",
      new Date().toISOString(),
    );
    console.log("=".repeat(80));

    console.log("📋 Environment:", {
      NODE_ENV: process.env.NODE_ENV || "not set",
      REDIS_URL: process.env.REDIS_URL ? "✅ Set" : "❌ NOT SET",
      RABBITMQ_URL: process.env.RABBITMQ_URL ? "✅ Set" : "❌ NOT SET",
      SMTP_HOST: process.env.SMTP_HOST ? "✅ Set" : "❌ NOT SET",
      GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ? "✅ Set" : "❌ NOT SET",
      MICROSOFT_CLIENT_ID: process.env.MICROSOFT_CLIENT_ID
        ? "✅ Set"
        : "❌ NOT SET",
    });

    console.log("🔌 Connecting to RabbitMQ...");
    const channel = await getChannel();
    console.log("✅ RabbitMQ connected successfully");

    console.log(`📦 Asserting queue: ${QUEUES.EMAIL_SEND}`);
    await channel.assertQueue(QUEUES.EMAIL_SEND, { durable: true });
    console.log(`✅ Queue asserted: ${QUEUES.EMAIL_SEND}`);

    channel.prefetch(5);
    console.log("✅ Prefetch set to 5");

    try {
      const queueStatus = await channel.checkQueue(QUEUES.EMAIL_SEND);
      console.log("📊 Queue Status:", {
        queue: QUEUES.EMAIL_SEND,
        messageCount: queueStatus.messageCount,
        consumerCount: queueStatus.consumerCount,
      });
    } catch (queueErr) {
      console.error("❌ Failed to check queue status:", queueErr.message);
    }

    try {
      console.log("🗄️ Testing database connection...");
      const testEmail = await Email.findOne({ limit: 1 });
      console.log("✅ Database connected successfully");
    } catch (dbErr) {
      console.error("❌ Database connection failed:", dbErr.message);
      throw new Error(`Database connection failed: ${dbErr.message}`);
    }

    log("INFO", "📧 Email Sender ready (multi-sender version)");
    console.log("✅ Email Sender worker is now LISTENING for messages");
    console.log("=".repeat(80) + "\n");

    channel.consume(QUEUES.EMAIL_SEND, async (msg) => {
      if (!msg) {
        console.log("⚠️ Received null message");
        return;
      }

      const startTime = Date.now();
      let emailRecord = null;
      let senderRecord = null;
      let sendRecord = null;
      let emailId = null;
      let senderType = null;

      try {
        console.log("\n" + "-".repeat(60));
        console.log("📨 RECEIVED MESSAGE FROM QUEUE:", {
          queue: QUEUES.EMAIL_SEND,
          timestamp: new Date().toISOString(),
          content: msg.content.toString(),
          deliveryTag: msg.fields.deliveryTag,
        });

        const payload = JSON.parse(msg.content.toString());
        emailId = payload.emailId;
        senderType = payload.senderType;

        console.log("📧 Processing email:", { emailId, senderType });

        // Load email
        emailRecord = await Email.findByPk(emailId);
        if (!emailRecord) {
          console.log(`❌ Email not found in database: ${emailId}`);
          log("WARN", "Email not found", { emailId });
          return channel.ack(msg);
        }

        console.log("📧 Email record loaded:", {
          id: emailRecord.id,
          status: emailRecord.status,
          senderId: emailRecord.senderId,
          senderType: emailRecord.senderType,
          recipientEmail: emailRecord.recipientEmail,
          campaignId: emailRecord.campaignId,
        });

        // Check if already sent
        if (emailRecord.status === "sent") {
          console.log(`⏭️ Email already sent: ${emailId}`);
          log("DEBUG", "Email already sent", { emailId });
          return channel.ack(msg);
        }

        // Get sender based on type
        const senderTypeToUse = senderType || emailRecord.senderType;
        if (!emailRecord.senderId || !senderTypeToUse) {
          throw new Error(
            `Email not properly routed - missing sender info (senderId: ${emailRecord.senderId}, senderType: ${senderTypeToUse})`,
          );
        }

        console.log("🔍 Looking up sender:", {
          senderId: emailRecord.senderId,
          senderType: senderTypeToUse,
        });
        senderRecord = await getSenderByType(
          emailRecord.senderId,
          senderTypeToUse,
        );

        if (!senderRecord) {
          throw new Error(
            `Sender not found (${senderTypeToUse}:${emailRecord.senderId})`,
          );
        }

        if (!senderRecord.isVerified) {
          throw new Error(
            `Sender not verified (${senderTypeToUse}:${emailRecord.senderId})`,
          );
        }

        console.log("✅ Sender found and verified:", {
          id: senderRecord.id,
          email: senderRecord.email,
          type: senderTypeToUse,
          isVerified: senderRecord.isVerified,
        });

        // Get or create campaign send record
        sendRecord = await CampaignSend.findOne({ where: { emailId } });
        if (sendRecord && sendRecord.status !== "queued") {
          console.log(
            `⏭️ CampaignSend already processed: ${emailId}, status: ${sendRecord.status}`,
          );
          log("DEBUG", "CampaignSend already processed", {
            emailId,
            status: sendRecord.status,
          });
          return channel.ack(msg);
        }

        if (!sendRecord) {
          console.log("📝 Creating CampaignSend record");
          sendRecord = await CampaignSend.create({
            emailId,
            campaignId: emailRecord.campaignId,
            recipientId: emailRecord.recipientId,
            senderId: emailRecord.senderId,
            senderType: senderTypeToUse,
            status: "queued",
            queuedAt: new Date(),
          });
          console.log("✅ CampaignSend created:", { id: sendRecord.id });
        }

        // Log queued event
        await EmailEvent.create({
          emailId,
          eventType: "queued",
          eventTimestamp: new Date(),
          metadata: {
            senderType: senderTypeToUse,
            senderId: emailRecord.senderId,
          },
        });

        log("INFO", "Starting email send", {
          emailId,
          senderType: senderTypeToUse,
          senderId: emailRecord.senderId,
          senderEmail: senderRecord.email,
          recipient: emailRecord.recipientEmail,
        });

        // Generate message ID
        const domain = senderRecord.email.split("@")[1];
        const messageId = generateMessageId(emailId, domain);

        // Prepare email data
        const emailData = {
          emailId,
          campaignId: emailRecord.campaignId,
          recipientEmail: emailRecord.recipientEmail,
          subject: emailRecord.metadata?.subject || "No subject",
          htmlBody:
            emailRecord.metadata?.htmlBody || emailRecord.metadata?.body || "",
        };

        console.log("📤 Sending email via:", senderTypeToUse);

        // Send based on sender type
        switch (senderTypeToUse) {
          case "gmail":
            await sendViaGmail(senderRecord, emailData, messageId);
            break;
          case "outlook":
            await sendViaOutlook(senderRecord, emailData, messageId);
            break;
          case "smtp":
            await sendViaSmtp(senderRecord, emailData, messageId);
            break;
          default:
            throw new Error(`Unsupported sender type: ${senderTypeToUse}`);
        }

        console.log("✅ Email sent successfully to provider");

        // Update all records after successful send
        await Promise.all([
          emailRecord.update({
            status: "sent",
            providerMessageId: messageId,
            sentAt: new Date(),
            senderType: senderTypeToUse,
          }),
          CampaignSend.update(
            {
              status: "sent",
              sentAt: new Date(),
              providerMessageId: messageId,
            },
            { where: { emailId } },
          ),
          Campaign.increment("totalSent", {
            by: 1,
            where: { id: emailRecord.campaignId },
          }),
          EmailEvent.create({
            emailId,
            eventType: "sent",
            eventTimestamp: new Date(),
            metadata: {
              senderType: senderTypeToUse,
              senderId: emailRecord.senderId,
              providerMessageId: messageId,
            },
          }),
          updateSenderMetrics(emailRecord.senderId, senderTypeToUse),
        ]);

        const duration = Date.now() - startTime;
        log("INFO", "✅ Email sent successfully", {
          emailId,
          senderType: senderTypeToUse,
          senderId: emailRecord.senderId,
          providerMessageId: messageId,
          durationMs: duration,
        });

        console.log(`✅ Email processed successfully in ${duration}ms:`, {
          emailId,
          providerMessageId: messageId,
        });
        console.log("-".repeat(60) + "\n");

        channel.ack(msg);
      } catch (err) {
        const duration = Date.now() - startTime;
        console.error(`❌ Email send failed after ${duration}ms:`, {
          emailId,
          senderType,
          error: err.message,
          stack: err.stack,
        });

        log("ERROR", "❌ Email send failed", {
          emailId,
          senderType: senderType,
          senderId: emailRecord?.senderId,
          error: err.message,
          stack: err.stack,
          durationMs: duration,
        });

        // Handle failures - use emailRecord which is in scope
        if (emailRecord) {
          await emailRecord.update({
            status: "failed",
            lastError: err.message.slice(0, 500),
            failedAt: new Date(),
          });
        }

        if (sendRecord) {
          await sendRecord.update({
            status: "failed",
            error: err.message.slice(0, 500),
            failedAt: new Date(),
          });
        }

        // Create bounce event for hard failures
        const isHardBounce =
          err.message.includes("expired") ||
          err.message.includes("unavailable") ||
          err.message.includes("invalid") ||
          err.message.includes("rejected");

        await BounceEvent.create({
          emailId,
          bounceType: isHardBounce ? "hard" : "soft",
          reason: err.message.slice(0, 500),
          occurredAt: new Date(),
          metadata: {
            senderType: senderType,
            senderId: emailRecord?.senderId,
            error: err.message,
          },
        });

        // Update sender as failed if it's a token/auth issue
        if (
          err.message.includes("token") ||
          err.message.includes("auth") ||
          err.message.includes("credentials")
        ) {
          if (senderRecord) {
            const updateData = {
              isVerified: false,
              lastError: err.message.slice(0, 500),
            };

            switch (senderType) {
              case "gmail":
                await GmailSender.update(updateData, {
                  where: { id: senderRecord.id },
                });
                break;
              case "outlook":
                await OutlookSender.update(updateData, {
                  where: { id: senderRecord.id },
                });
                break;
              case "smtp":
                await SmtpSender.update(updateData, {
                  where: { id: senderRecord.id },
                });
                break;
            }

            log("WARN", "Sender marked as unverified due to auth error", {
              senderId: senderRecord.id,
              senderType: senderType,
              error: err.message,
            });
          }
        }

        channel.ack(msg);
      }
    });

    console.log("✅ Email sender worker is running. Press Ctrl+C to stop.");
  } catch (err) {
    console.error("\n" + "=".repeat(80));
    console.error("💥 FATAL: Email sender worker failed to start!");
    console.error("=".repeat(80));
    console.error("Error:", err.message);
    console.error("Stack:", err.stack);
    console.error("=".repeat(80) + "\n");

    log("FATAL", "Worker failed to start", {
      error: err.message,
      stack: err.stack,
    });

    process.exit(1);
  }
})();
