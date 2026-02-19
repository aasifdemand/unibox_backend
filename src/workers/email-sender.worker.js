import "../models/index.js";
import nodemailer from "nodemailer";
import { randomUUID } from "crypto";
import axios from "axios";

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
   PLACEHOLDER ENGINE - FIXED
========================= */

function replacePlaceholders(template, data = {}) {
  if (!template) return template;

  // Log what we're working with
  log("DEBUG", "replacePlaceholders input", {
    hasTemplate: !!template,
    templatePreview: template.substring(0, 100),
    dataKeys: Object.keys(data),
    sampleData: {
      email: data.email,
      name: data.name,
      first_name: data.first_name,
      company: data.company,
    },
  });

  // Create enhanced data object with all possible placeholder variations
  const enhancedData = {
    // Base fields from recipient model
    email: data.email || "",
    name: data.name || "",

    // All metadata fields (spread first so they can be overridden)
    ...data,

    // Derive first_name and last_name from the name field (highest priority)
    first_name:
      data.first_name ||
      data.firstName ||
      (data.name ? data.name.split(" ")[0] : ""),
    last_name:
      data.last_name ||
      data.lastName ||
      (data.name ? data.name.split(" ").slice(1).join(" ") : ""),

    // Also provide camelCase versions
    firstName:
      data.firstName ||
      data.first_name ||
      (data.name ? data.name.split(" ")[0] : ""),
    lastName:
      data.lastName ||
      data.last_name ||
      (data.name ? data.name.split(" ").slice(1).join(" ") : ""),

    // Ensure unsubscribe_link is always available
    unsubscribe_link: data.unsubscribe_link || "{{unsubscribe_link}}",
  };

  // Clean up any undefined values
  Object.keys(enhancedData).forEach((key) => {
    if (enhancedData[key] === undefined || enhancedData[key] === null) {
      enhancedData[key] = "";
    }
  });

  log("DEBUG", "Enhanced data for replacement", {
    keys: Object.keys(enhancedData),
    first_name: enhancedData.first_name,
    last_name: enhancedData.last_name,
    company: enhancedData.company,
    city: enhancedData.city,
    role: enhancedData.role,
    country: enhancedData.country,
    industry: enhancedData.industry,
  });

  // Check if template has any placeholders
  if (!template.includes("{{")) {
    log("DEBUG", "No placeholders in template");
    return template;
  }

  // Replace all placeholders
  const result = template.replace(/{{\s*(\w+)\s*}}/g, (_, key) => {
    const value = enhancedData[key];
    if (value === undefined || value === null || value === "") {
      log("DEBUG", `Placeholder {{${key}}} not found or empty, removing`);
      return "";
    }
    return String(value);
  });

  log("DEBUG", "Replacement complete", {
    originalLength: template.length,
    resultLength: result.length,
    changed: template !== result,
  });

  return result;
}

function generateMessageId(emailId, domain) {
  return `<${emailId}.${randomUUID().slice(0, 8)}.${Date.now()}@${domain}>`;
}

function formatHtmlForEmail(html) {
  if (!html) return "";

  let processed = html;

  // First, ensure empty paragraphs create visible line breaks
  processed = processed.replace(
    /<p><\/p>/g,
    '<p style="margin: 0 0 0 0; line-height: 1.5;">&nbsp;</p>',
  );

  processed = processed.replace(
    /<p>\s*<\/p>/g,
    '<p style="margin: 0 0 0 0; line-height: 1.5;">&nbsp;</p>',
  );

  // Add basic styling to all paragraphs for consistent spacing
  // But preserve existing styles if they exist
  processed = processed.replace(
    /<p(?!\s*style)/g,
    '<p style="margin: 0 0 0 0; line-height: 1.5;"',
  );

  // Ensure proper spacing between elements
  processed = processed.replace(/<\/p>\s*<p/g, "</p><p");

  // Wrap in a container with proper font settings
  return `<div style="font-family: Arial, Helvetica, sans-serif; font-size: 14px; line-height: 1.6; color: #000000;">
    ${processed}
  </div>`;
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

function injectTracking(html, emailId, campaign) {
  if (!html) return html;

  let processed = html;

  // 1. Inject open tracking pixel (if campaign.trackOpens is true)
  if (campaign?.trackOpens) {
    const pixelUrl = `${process.env.APP_URL}/api/v1/track/open/${emailId}`;
    const pixel = `<img src="${pixelUrl}" width="1" height="1" style="display:none;" alt="" />`;

    // Add before closing body tag or at the end
    if (processed.includes("</body>")) {
      processed = processed.replace("</body>", `${pixel}</body>`);
    } else {
      processed += pixel;
    }

    log("DEBUG", "Open tracking pixel injected", { emailId, pixelUrl });
  }

  // 2. Rewrite links for click tracking (if campaign.trackClicks is true)
  if (campaign?.trackClicks) {
    // Find all href links
    const linkCount = (processed.match(/<a\s+/g) || []).length;

    processed = processed.replace(
      /<a\s+(?:[^>]*?\s+)?href="([^"]*)"/g,
      (match, url) => {
        // Don't track links that are already tracking URLs or anchor links
        if (url.startsWith("#") || url.includes("/track/")) {
          return match;
        }

        const trackingUrl = `${process.env.APP_URL}/api/v1/track/click/${emailId}?url=${encodeURIComponent(url)}`;
        return match.replace(`href="${url}"`, `href="${trackingUrl}"`);
      },
    );

    log("DEBUG", "Click tracking injected", { emailId, linkCount });
  }

  return processed;
}

// Helper to determine bounce type based on error
function determineBounceType(error) {
  const message = error.message.toLowerCase();

  if (
    message.includes("550") ||
    message.includes("user unknown") ||
    message.includes("does not exist") ||
    message.includes("invalid recipient") ||
    message.includes("mailbox not found")
  ) {
    return "hard";
  }

  if (
    message.includes("blocked") ||
    message.includes("spam") ||
    message.includes("blacklisted")
  ) {
    return "complaint";
  }

  return "soft";
}

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
      let recipientData = {};

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
           LOAD SEND + RECIPIENT - Get full recipient data
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

        // 🔴 Build recipient data correctly from both model fields and metadata
        recipientData = {
          // Start with the email (always present)
          email: recipient.email,

          // Add the name from the model (this is where full name comes from)
          name: recipient.name || "",

          // Spread ALL metadata fields (city, role, company, country, industry)
          ...(recipient.metadata || {}),
        };

        // Derive first_name and last_name from the name field
        if (recipient.name) {
          const nameParts = recipient.name.trim().split(" ");
          recipientData.first_name = nameParts[0] || "";
          recipientData.last_name = nameParts.slice(1).join(" ") || "";

          // Also set camelCase versions
          recipientData.firstName = recipientData.first_name;
          recipientData.lastName = recipientData.last_name;
        }

        // Ensure all common placeholder variations exist
        recipientData.first_name =
          recipientData.first_name || recipientData.firstName || "";
        recipientData.last_name =
          recipientData.last_name || recipientData.lastName || "";
        recipientData.firstName =
          recipientData.firstName || recipientData.first_name;
        recipientData.lastName =
          recipientData.lastName || recipientData.last_name;

        // Add unsubscribe link placeholder
        recipientData.unsubscribe_link = "{{unsubscribe_link}}";

        // Log recipient data for debugging
        log("DEBUG", "✅ Recipient data fully constructed", {
          email: recipient.email,
          name: recipient.name,
          first_name: recipientData.first_name,
          last_name: recipientData.last_name,
          company: recipientData.company,
          city: recipientData.city,
          role: recipientData.role,
          country: recipientData.country,
          industry: recipientData.industry,
          metadataKeys: recipient.metadata
            ? Object.keys(recipient.metadata)
            : [],
          allKeys: Object.keys(recipientData),
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
           PERSONALIZATION - Get raw template from email metadata
        ========================= */

        // Get raw templates from email metadata (should contain placeholders)
        const rawHtml =
          emailRecord.metadata?.htmlBody || emailRecord.metadata?.body || "";

        const rawSubject = emailRecord.metadata?.subject || "No subject";

        // Log what placeholders exist in the template
        const subjectPlaceholders = rawSubject.match(/{{\s*(\w+)\s*}}/g) || [];
        const htmlPlaceholders = rawHtml.match(/{{\s*(\w+)\s*}}/g) || [];

        log("DEBUG", "Template placeholders found in raw template", {
          subjectPlaceholders,
          htmlPlaceholders,
          hasFirstName:
            subjectPlaceholders.includes("{{first_name}}") ||
            htmlPlaceholders.includes("{{first_name}}"),
          hasName:
            subjectPlaceholders.includes("{{name}}") ||
            htmlPlaceholders.includes("{{name}}"),
        });

        // Replace placeholders in HTML and subject using recipient data
        const personalizedHtml = replacePlaceholders(rawHtml, recipientData);
        const personalizedSubject = replacePlaceholders(
          rawSubject,
          recipientData,
        );

        // Get campaign to check tracking settings
        const campaign = await Campaign.findByPk(emailRecord.campaignId, {
          attributes: ["trackOpens", "trackClicks"],
        });

        // Inject tracking pixels/links
        let htmlWithTracking = personalizedHtml;
        if (campaign) {
          htmlWithTracking = injectTracking(
            personalizedHtml,
            emailId,
            campaign,
          );
        }

        // FORMAT HTML FOR EMAIL CLIENTS
        const finalHtml = formatHtmlForEmail(htmlWithTracking);

        log("DEBUG", "Template processed", {
          beforeLength: rawHtml.length,
          afterLength: finalHtml.length,
          subject: personalizedSubject,
          trackOpens: campaign?.trackOpens,
          trackClicks: campaign?.trackClicks,
          hasFirstName: personalizedSubject.includes("{{first_name")
            ? "still present"
            : "replaced",
        });

        /* =========================
           PREPARE EMAIL DATA
        ========================= */

        const domain = senderRecord.email.split("@")[1];
        const messageId = generateMessageId(emailId, domain);

        const emailData = {
          recipientEmail: recipient.email,
          subject: personalizedSubject,
          htmlBody: finalHtml,
        };

        /* =========================
           SEND EMAIL
        ========================= */

        if (senderType === "smtp") {
          try {
            // Configure TLS options based on environment
            const tlsOptions = {};

            // In development, bypass certificate validation
            if (process.env.NODE_ENV === "development") {
              tlsOptions.rejectUnauthorized = false;
              tlsOptions.ciphers = "SSLv3";
            } else {
              tlsOptions.rejectUnauthorized = true;
            }

            const transporter = nodemailer.createTransport({
              host: senderRecord.smtpHost,
              port: senderRecord.smtpPort,
              secure: senderRecord.smtpSecure !== false,
              auth: {
                user: senderRecord.smtpUsername,
                pass: senderRecord.smtpPassword,
              },
              tls: tlsOptions,
              // For some providers like Office 365
              requireTLS: true,
            });

            // Verify connection before sending
            await transporter.verify();

            await transporter.sendMail({
              from: `"${senderRecord.displayName}" <${senderRecord.email}>`,
              to: emailData.recipientEmail,
              subject: emailData.subject,
              html: emailData.htmlBody,
              messageId,
            });

            log("DEBUG", "SMTP connection verified and email sent");
          } catch (smtpError) {
            log("ERROR", "SMTP send failed", {
              error: smtpError.message,
              code: smtpError.code,
              command: smtpError.command,
              response: smtpError.response,
            });
            throw smtpError;
          }
        } else if (senderType === "gmail") {
          try {
            const tokenData = await refreshGoogleToken(senderRecord);

            if (!tokenData?.accessToken) {
              throw new Error("Failed to refresh Google token");
            }

            const rawEmail =
              `From: "${senderRecord.displayName}" <${senderRecord.email}>\r\n` +
              `To: ${emailData.recipientEmail}\r\n` +
              `Subject: ${emailData.subject}\r\n` +
              `MIME-Version: 1.0\r\n` +
              `Content-Type: text/html; charset=UTF-8\r\n\r\n` +
              `${emailData.htmlBody}`;

            const encodedMessage = Buffer.from(rawEmail)
              .toString("base64")
              .replace(/\+/g, "-")
              .replace(/\//g, "_")
              .replace(/=+$/, "");

            const sendResponse = await axios.post(
              `https://gmail.googleapis.com/gmail/v1/users/me/messages/send`,
              { raw: encodedMessage },
              {
                headers: {
                  Authorization: `Bearer ${tokenData.accessToken}`,
                  "Content-Type": "application/json",
                },
              },
            );

            const gmailInternalId = sendResponse.data.id;
            const threadId = sendResponse.data.threadId;

            await Promise.all([
              emailRecord.update({
                status: "sent",
                sentAt: new Date(),
                providerMessageId: gmailInternalId, // store internal ID
                providerThreadId: threadId, // 🔥 primary reply matcher
              }),
              CampaignSend.update(
                { status: "sent", sentAt: new Date() },
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

            log("INFO", "Email sent via Gmail (threadId stored)", {
              emailId,
              gmailInternalId,
              threadId,
            });

            channel.ack(msg);
            return;
          } catch (error) {
            log("ERROR", "Gmail send failed", {
              error: error.message,
              response: error.response?.data,
            });
            throw error;
          }
        } else if (senderType === "outlook") {
          try {
            const accessToken = await getValidMicrosoftToken(senderRecord);

            // Create draft message
            const createRes = await axios.post(
              `https://graph.microsoft.com/v1.0/me/messages`,
              {
                subject: emailData.subject,
                body: {
                  contentType: "HTML",
                  content: emailData.htmlBody,
                },
                toRecipients: [
                  { emailAddress: { address: emailData.recipientEmail } },
                ],
              },
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                },
              },
            );

            const messageId = createRes.data.id;

            // Send it
            await axios.post(
              `https://graph.microsoft.com/v1.0/me/messages/${messageId}/send`,
              {},
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                },
              },
            );

            // Fetch conversationId
            const sentMessage = await axios.get(
              `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                },
              },
            );

            const conversationId = sentMessage.data.conversationId;

            await Promise.all([
              emailRecord.update({
                status: "sent",
                sentAt: new Date(),
                providerMessageId: messageId,
                providerThreadId: conversationId, // 🔥 reply matcher
              }),
              CampaignSend.update(
                { status: "sent", sentAt: new Date() },
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

            log("INFO", "Email sent via Outlook (conversationId stored)", {
              emailId,
              messageId,
              conversationId,
            });

            channel.ack(msg);
            return;
          } catch (error) {
            log("ERROR", "Outlook send failed", {
              error: error.message,
              response: error.response?.data,
            });
            throw error;
          }
        }

        /* =========================
           SUCCESS UPDATE (SMTP fallthrough)
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
          senderType,
          durationMs: Date.now() - startTime,
          recipient: recipient.email,
          subjectPreview: emailData.subject.substring(0, 50),
        });

        channel.ack(msg);
      } catch (err) {
        log("ERROR", "Email send failed", {
          emailId: emailRecord?.id,
          senderType: emailRecord?.senderType,
          recipient: sendRecord?.CampaignRecipient?.email,
          error: err.message,
          stack: err.stack,
        });

        if (emailRecord) {
          await emailRecord.update({
            status: "failed",
            lastError: err.message,
          });
        }

        // Determine bounce type based on error
        const bounceType = determineBounceType(err);

        await BounceEvent.create({
          emailId: emailRecord?.id,
          bounceType,
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
