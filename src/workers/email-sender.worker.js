import "../models/index.js";
import nodemailer from "nodemailer";
import { randomUUID } from "crypto";
import { google } from "googleapis";

import Email from "../models/email.model.js";
import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import EmailEvent from "../models/email-event.model.js";
import BounceEvent from "../models/bounce-event.model.js";
import Campaign from "../models/campaign.model.js";

import { getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";
import { refreshGoogleToken } from "../utils/refresh-google-token.js";

/* =========================
   LOGGING
========================= */

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
   PLACEHOLDER ENGINE
========================= */

function replacePlaceholders(template, data = {}) {
  if (!template) return template;

  return template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = data[key];
    if (value === undefined || value === null) {
      return `{{${key}}}`;
    }
    return String(value);
  });
}

function generateMessageId(emailId, domain) {
  return `<${emailId}.${randomUUID().slice(0, 8)}.${Date.now()}@${domain}>`;
}

/* =========================
   SENDER FETCHER
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
   MAIN WORKER
========================= */

(async () => {
  try {
    const channel = await getChannel();
    await channel.assertQueue(QUEUES.EMAIL_SEND, { durable: true });
    channel.prefetch(5);

    log("INFO", "Email Sender ready with personalization");

    channel.consume(QUEUES.EMAIL_SEND, async (msg) => {
      if (!msg) return;

      const startTime = Date.now();
      let emailRecord = null;
      let sendRecord = null;
      let senderRecord = null;

      try {
        const payload = JSON.parse(msg.content.toString());
        const emailId = payload.emailId;
        const senderTypeFromPayload = payload.senderType;

        log("INFO", "Processing email", { emailId });

        /* =========================
           LOAD EMAIL
        ========================= */

        emailRecord = await Email.findByPk(emailId);

        if (!emailRecord) {
          log("WARN", "Email not found", { emailId });
          return channel.ack(msg);
        }

        if (emailRecord.status === "sent") {
          log("DEBUG", "Email already sent", { emailId });
          return channel.ack(msg);
        }

        /* =========================
           LOAD SEND + RECIPIENT
        ========================= */

        sendRecord = await CampaignSend.findOne({
          where: { emailId },
          include: [
            {
              model: CampaignRecipient,
            },
          ],
        });

        if (!sendRecord) {
          throw new Error("CampaignSend record not found");
        }

        const recipient = sendRecord.CampaignRecipient;

        if (!recipient) {
          throw new Error("CampaignRecipient not found");
        }

        const recipientData = {
          name: recipient.name,
          ...recipient.metadata,
        };

        log("DEBUG", "Recipient loaded", {
          email: recipient.email,
          recipientData,
        });

        /* =========================
           LOAD SENDER
        ========================= */

        const senderType = senderTypeFromPayload || emailRecord.senderType;

        senderRecord = await getSenderByType(emailRecord.senderId, senderType);

        if (!senderRecord) {
          throw new Error("Sender not found");
        }

        if (!senderRecord.isVerified) {
          throw new Error("Sender not verified");
        }

        /* =========================
           PERSONALIZATION
        ========================= */

        const rawHtml =
          emailRecord.metadata?.htmlBody || emailRecord.metadata?.body || "";

        const rawSubject = emailRecord.metadata?.subject || "No subject";

        const personalizedHtml = replacePlaceholders(rawHtml, recipientData);

        const personalizedSubject = replacePlaceholders(
          rawSubject,
          recipientData,
        );

        log("DEBUG", "Template processed", {
          beforeLength: rawHtml.length,
          afterLength: personalizedHtml.length,
        });

        /* =========================
           PREPARE EMAIL DATA
        ========================= */

        const domain = senderRecord.email.split("@")[1];
        const messageId = generateMessageId(emailId, domain);

        const emailData = {
          recipientEmail: recipient.email,
          subject: personalizedSubject,
          htmlBody: personalizedHtml,
        };

        /* =========================
           SEND EMAIL
        ========================= */

        if (senderType === "smtp") {
          const transporter = nodemailer.createTransport({
            host: senderRecord.smtpHost,
            port: senderRecord.smtpPort,
            secure: senderRecord.smtpSecure !== false,
            auth: {
              user: senderRecord.smtpUsername,
              pass: senderRecord.smtpPassword,
            },
          });

          await transporter.sendMail({
            from: `"${senderRecord.displayName}" <${senderRecord.email}>`,
            to: emailData.recipientEmail,
            subject: emailData.subject,
            html: emailData.htmlBody,
            messageId,
          });
        }

        // Gmail & Outlook handlers unchanged
        // (Reuse your existing sendViaGmail / sendViaOutlook functions here)

        /* =========================
           SUCCESS UPDATE
        ========================= */

        await Promise.all([
          emailRecord.update({
            status: "sent",
            sentAt: new Date(),
            providerMessageId: messageId,
          }),
          CampaignSend.update(
            {
              status: "sent",
              sentAt: new Date(),
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
          }),
        ]);

        log("INFO", "Email sent successfully", {
          emailId,
          durationMs: Date.now() - startTime,
        });

        channel.ack(msg);
      } catch (err) {
        log("ERROR", "Email send failed", {
          emailId: emailRecord?.id,
          error: err.message,
        });

        if (emailRecord) {
          await emailRecord.update({
            status: "failed",
            lastError: err.message,
          });
        }

        await BounceEvent.create({
          emailId: emailRecord?.id,
          bounceType: "soft",
          reason: err.message,
          occurredAt: new Date(),
        });

        channel.ack(msg);
      }
    });
  } catch (err) {
    log("FATAL", "Worker failed to start", {
      error: err.message,
    });
    process.exit(1);
  }
})();
