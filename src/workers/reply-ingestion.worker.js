import "../models/index.js";
import axios from "axios";
import { google } from "googleapis";
import Imap from "imap";
import { simpleParser } from "mailparser";
import https from "https";
import { Op } from "sequelize";

import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import Email from "../models/email.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import ReplyEvent from "../models/reply-event.model.js";
import Campaign from "../models/campaign.model.js";

import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";
import { tryCompleteCampaign } from "../utils/campaign-completion.checker.js";
import { refreshGoogleToken } from "../utils/refresh-google-token.js";
import sequelize from "../config/db.js";

/* =========================
   LOGGER
========================= */
const log = (level, message, meta = {}) =>
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "reply-ingestion",
      level,
      message,
      ...meta,
    }),
  );

/* =========================
   REQUIRED GMAIL SCOPES
========================= */
const REQUIRED_GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

/* =========================
   HELPER: Normalize email for matching
   Handles Gmail-specific quirks (dots, plus signs, googlemail.com)
========================= */
function normalizeEmailForMatching(email) {
  if (!email) return email;

  let normalized = email.toLowerCase().trim();

  // Handle Gmail: remove dots and plus aliases
  if (
    normalized.includes("@gmail.com") ||
    normalized.includes("@googlemail.com")
  ) {
    const [localPart] = normalized.split("@");
    let cleanLocal = localPart.replace(/\./g, "");
    cleanLocal = cleanLocal.split("+")[0];
    normalized = `${cleanLocal}@gmail.com`;
  }

  // Handle Outlook/Hotmail/Live: case insensitive, remove plus aliasing
  if (
    normalized.includes("@outlook.com") ||
    normalized.includes("@hotmail.com") ||
    normalized.includes("@live.com")
  ) {
    normalized = normalized.split("+")[0];
  }

  return normalized;
}

/* =========================
   HELPER: Extract emails from header
========================= */
function extractEmails(header) {
  if (!header) return [];
  const matches = header.match(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  );
  return matches || [];
}

/* =========================
   PROCESS REPLY - FIXED WITH ERROR HANDLING
========================= */
async function processReply({ sender, email, reply }) {
  try {
    if (email.status === "replied") {
      log("DEBUG", "Email already replied, skipping", {
        emailId: email.id,
        status: email.status,
      });
      return;
    }

    log("INFO", "📩 Reply detected - Processing", {
      emailId: email.id,
      recipientEmail: email.recipientEmail,
      from: reply.from,
      subject: reply.subject,
      senderType: sender.type,
      senderEmail: sender.email,
    });

    // Create ReplyEvent
    await ReplyEvent.create({
      emailId: email.id,
      replyFrom: reply.from,
      subject: reply.subject,
      body: reply.body,
      receivedAt: reply.receivedAt,
      metadata: {
        provider: sender.type || "smtp",
        inReplyTo: reply.inReplyTo,
        threadId: reply.threadId,
        messageId: reply.messageId,
      },
    });

    // Update email status
    await email.update({
      status: "replied",
      repliedAt: reply.receivedAt || new Date(),
    });

    // Update campaign recipient
    const [count, [recipient]] = await CampaignRecipient.update(
      {
        status: "replied",
        repliedAt: reply.receivedAt || new Date(),
        nextRunAt: null,
      },
      {
        where: {
          campaignId: email.campaignId,
          email: email.recipientEmail,
          status: { [Op.ne]: "replied" },
        },
        returning: true,
      },
    );

    if (recipient) {
      await Campaign.increment("totalReplied", {
        by: 1,
        where: { id: email.campaignId },
      });
    }

    // Cancel future sends
    await CampaignSend.update(
      { status: "skipped" },
      {
        where: {
          campaignId: email.campaignId,
          recipientId: recipient.id,
          status: "queued",
        },
      },
    );

    log("INFO", "🛑 Follow-ups stopped for recipient", {
      campaignId: email.campaignId,
      recipientId: recipient.id,
    });

    await tryCompleteCampaign(email.campaignId);

    log("INFO", "✅ Reply processing complete", {
      emailId: email.id,
      from: reply.from,
    });
  } catch (error) {
    log("ERROR", "❌ processReply failed", {
      emailId: email.id,
      error: error.message,
      stack: error.stack,
      from: reply.from,
      subject: reply.subject,
    });
    throw error;
  }
}

/* =========================
   CHECK GMAIL SCOPES
========================= */
async function validateGmailScopes(gmailSender) {
  if (!gmailSender.scopes) {
    log("ERROR", "❌ Gmail sender missing scopes array", {
      email: gmailSender.email,
      senderId: gmailSender.id,
    });
    return false;
  }

  const missingScopes = REQUIRED_GMAIL_SCOPES.filter(
    (scope) => !gmailSender.scopes.includes(scope),
  );

  if (missingScopes.length > 0) {
    log(
      "ERROR",
      "❌ Gmail sender missing required scopes for reading replies",
      {
        email: gmailSender.email,
        senderId: gmailSender.id,
        missingScopes,
        currentScopes: gmailSender.scopes,
      },
    );

    await gmailSender.update({
      isVerified: false,
      verificationError: `Missing required scopes: ${missingScopes.join(", ")}. Please re-authenticate.`,
    });

    return false;
  }

  return true;
}

/* =========================
   GMAIL API INGESTION - WORKING PERFECTLY
========================= */
async function ingestGmailReplies(gmailSender, messageIdMap) {
  const senderId = gmailSender.id;

  const hasValidScopes = await validateGmailScopes(gmailSender);
  if (!hasValidScopes) {
    log("WARN", "⏭️ Skipping Gmail sender - missing required scopes", {
      email: gmailSender.email,
      senderId,
    });
    return;
  }

  const checkFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  log("INFO", "🔍 Checking Gmail sender inbox for replies", {
    email: gmailSender.email,
    senderId,
    checkingSince: checkFrom.toISOString(),
    messageIdsTracked: messageIdMap.size,
  });

  if (messageIdMap.size === 0) {
    log("INFO", "⏭️ Skipping - no campaign emails sent from this sender", {
      email: gmailSender.email,
      senderId,
    });
    return;
  }

  try {
    if (!gmailSender.accessToken) {
      log("WARN", "Gmail sender missing access token", {
        email: gmailSender.email,
        senderId,
      });
      return;
    }

    let tokenData = null;
    let isTokenExpired = true;

    if (gmailSender.expiresAt) {
      const expiryDate = new Date(gmailSender.expiresAt);
      isTokenExpired = expiryDate <= new Date();

      if (!isTokenExpired) {
        tokenData = {
          accessToken: gmailSender.accessToken,
        };
      }
    }

    if (isTokenExpired && gmailSender.refreshToken) {
      try {
        tokenData = await refreshGoogleToken(gmailSender);
        if (!tokenData) {
          log("ERROR", "Failed to refresh Google token", {
            email: gmailSender.email,
            senderId,
          });
          return;
        }
      } catch (tokenError) {
        log("ERROR", "Token refresh process failed", {
          error: tokenError.message,
          email: gmailSender.email,
          senderId,
        });
        return;
      }
    } else if (isTokenExpired && !gmailSender.refreshToken) {
      log("ERROR", "Access token expired and no refresh token available", {
        email: gmailSender.email,
        senderId,
      });
      return;
    }

    if (!tokenData) {
      log("ERROR", "Failed to get valid Google token", {
        email: gmailSender.email,
        senderId,
      });
      return;
    }

    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({
      access_token: tokenData.accessToken,
      refresh_token: gmailSender.refreshToken,
    });

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    const bufferTime = 5 * 60;
    const searchTimestamp = Math.floor(checkFrom.getTime() / 1000) - bufferTime;
    const searchQuery = `after:${searchTimestamp}`;

    const response = await gmail.users.messages.list({
      userId: "me",
      q: searchQuery,
      maxResults: 100,
    });

    const messages = response.data.messages || [];

    if (messages.length === 0) {
      log("DEBUG", "No messages found in the last 7 days");
      return;
    }

    let processedCount = 0;
    let skippedCount = 0;

    const campaignIds = new Set();
    for (const emailId of messageIdMap.values()) {
      const email = await Email.findByPk(emailId, {
        attributes: ["campaignId"],
      });
      if (email && email.campaignId) campaignIds.add(email.campaignId);
    }

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    for (const msg of messages) {
      try {
        const existingReply = await ReplyEvent.findOne({
          where: {
            metadata: {
              messageId: msg.id,
            },
          },
        });

        if (existingReply) {
          skippedCount++;
          continue;
        }

        const messageRes = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "full",
        });

        const message = messageRes.data;
        const headers = message.payload?.headers || [];

        const fromHeader = headers.find((h) => h.name === "From")?.value || "";
        const toHeader = headers.find((h) => h.name === "To")?.value || "";
        const deliveredToHeader =
          headers.find((h) => h.name === "Delivered-To")?.value || "";
        const ccHeader = headers.find((h) => h.name === "Cc")?.value || "";
        const subjectHeader =
          headers.find((h) => h.name === "Subject")?.value || "";
        const inReplyToHeader =
          headers.find((h) => h.name === "In-Reply-To")?.value || "";
        const referencesHeader =
          headers.find((h) => h.name === "References")?.value || "";
        const dateHeader = headers.find((h) => h.name === "Date")?.value || "";
        const messageIdHeader =
          headers.find((h) => h.name === "Message-ID")?.value || "";

        const fromMatch =
          fromHeader.match(/<([^>]+)>/) ||
          fromHeader.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
        const from = fromMatch
          ? fromMatch[1].toLowerCase()
          : fromHeader.toLowerCase();

        const allRecipients = [
          ...extractEmails(toHeader),
          ...extractEmails(deliveredToHeader),
          ...extractEmails(ccHeader),
        ].map((e) => e.toLowerCase());

        if (!allRecipients.includes(gmailSender.email.toLowerCase())) {
          skippedCount++;
          continue;
        }

        if (
          from === gmailSender.email.toLowerCase() ||
          from.includes("noreply") ||
          from.includes("no-reply")
        ) {
          skippedCount++;
          continue;
        }

        const messageDate =
          new Date(dateHeader) ||
          new Date(parseInt(message.internalDate || Date.now()));

        let body = "";
        if (message.payload?.body?.data) {
          body = Buffer.from(message.payload.body.data, "base64").toString();
        } else if (message.payload?.parts) {
          const textPart = message.payload.parts.find(
            (p) => p.mimeType === "text/plain",
          );
          if (textPart && textPart.body?.data) {
            body = Buffer.from(textPart.body.data, "base64").toString();
          }
        }

        const threadIds = [
          inReplyToHeader,
          ...(referencesHeader ? referencesHeader.split(/\s+/) : []),
        ].filter(Boolean);

        let emailId = null;
        let matchedVia = null;

        for (const ref of threadIds) {
          if (messageIdMap.has(ref)) {
            emailId = messageIdMap.get(ref);
            matchedVia = "exact thread ID";
            break;
          }
        }

        if (!emailId) {
          for (const ref of threadIds) {
            const cleanRef = ref.replace(/[<>]/g, "");
            for (const [key, value] of messageIdMap.entries()) {
              const cleanKey = key.replace(/[<>]/g, "");
              if (cleanKey.includes(cleanRef) || cleanRef.includes(cleanKey)) {
                emailId = value;
                matchedVia = "partial thread ID";
                break;
              }
            }
            if (emailId) break;
          }
        }

        if (!emailId && /^re:/i.test(subjectHeader)) {
          const baseSubject = subjectHeader.replace(/^re:\s*/i, "").trim();

          const email = await Email.findOne({
            where: {
              senderId: gmailSender.id,
              recipientEmail: from,
              campaignId: { [Op.in]: Array.from(campaignIds) },
              createdAt: { [Op.gte]: thirtyDaysAgo },
              [Op.or]: [
                {
                  providerMessageId: {
                    [Op.in]: Array.from(messageIdMap.keys()),
                  },
                },
                {
                  metadata: {
                    subject: { [Op.iLike]: `%${baseSubject}%` },
                  },
                },
              ],
            },
            order: [["createdAt", "DESC"]],
          });

          if (email) {
            emailId = email.id;
            matchedVia = "subject fallback";
          }
        }

        if (!emailId) {
          skippedCount++;
          continue;
        }

        const email = await Email.findByPk(emailId);
        if (!email) {
          continue;
        }

        const normalizedRecipient = normalizeEmailForMatching(
          email.recipientEmail,
        );
        const normalizedFrom = normalizeEmailForMatching(from);

        if (normalizedRecipient !== normalizedFrom) {
          skippedCount++;
          continue;
        }

        await processReply({
          sender: { ...gmailSender.toJSON(), type: "gmail" },
          email,
          reply: {
            from,
            subject: subjectHeader,
            body,
            receivedAt: messageDate,
            inReplyTo: inReplyToHeader,
            threadId: message.threadId,
            messageId: messageIdHeader,
          },
        });

        processedCount++;

        try {
          await gmail.users.messages.modify({
            userId: "me",
            id: msg.id,
            requestBody: {
              removeLabelIds: ["UNREAD"],
            },
          });
        } catch (modifyError) {
          // Ignore
        }
      } catch (e) {
        skippedCount++;
      }
    }

    log("INFO", "📬 Gmail sender inbox check complete", {
      email: gmailSender.email,
      totalMessages: messages.length,
      processedCount,
      skippedCount,
    });
  } catch (err) {
    log("ERROR", "❌ Gmail inbox ingestion failed", {
      error: err.message,
      sender: gmailSender.email,
    });
  }
}

async function ingestOutlookReplies(outlookSender, messageIdMap) {
  const senderId = outlookSender.id;

  log("INFO", "🔍 Checking Outlook sender ALL folders for replies", {
    email: outlookSender.email,
    senderId,
    messageIdsTracked: messageIdMap.size,
  });

  if (messageIdMap.size === 0) {
    log("INFO", "⏭️ Skipping Outlook sender - no campaign emails", {
      email: outlookSender.email,
      senderId,
    });
    return;
  }

  try {
    const freshSender = await OutlookSender.findByPk(senderId);
    if (!freshSender) return;

    const token = await getValidMicrosoftToken(freshSender);
    if (!token) {
      log("ERROR", "❌ Failed to get valid Microsoft token", {
        email: outlookSender.email,
      });
      return;
    }

    const agent = new https.Agent({
      rejectUnauthorized: false,
      keepAlive: true,
    });

    const folders = ["inbox", "junkemail", "deleteditems", "archive"];
    const checkFrom = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    let allMessages = [];

    for (const folder of folders) {
      try {
        const endpoint = `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages`;

        const response = await axios.get(endpoint, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          params: {
            $top: 200,
            $orderby: "receivedDateTime desc",
            $filter: `receivedDateTime ge ${checkFrom.toISOString()}`,
            $select:
              "id,subject,from,toRecipients,ccRecipients,body,bodyPreview,conversationId,internetMessageId,internetMessageHeaders,receivedDateTime",
          },
          httpsAgent: agent,
          timeout: 15000,
        });

        const messages = response.data.value || [];
        messages.forEach((m) => (m._folder = folder));
        allMessages.push(...messages);
      } catch (err) {
        log("WARN", `⚠️ Failed fetching ${folder}`, {
          error: err.message,
        });
      }
    }

    const uniqueMessages = Array.from(
      new Map(allMessages.map((m) => [m.id, m])).values(),
    );

    let processedCount = 0;
    let skippedCount = 0;

    for (const msg of uniqueMessages) {
      try {
        // Prevent duplicate processing
        const existingReply = await ReplyEvent.findOne({
          where: {
            [Op.or]: [
              { "metadata.messageId": msg.internetMessageId },
              { "metadata.threadId": msg.conversationId },
            ],
          },
        });

        if (existingReply) {
          skippedCount++;
          continue;
        }

        const senderEmailLower = outlookSender.email.toLowerCase();

        const toRecipients =
          msg.toRecipients?.map((r) =>
            r.emailAddress?.address?.toLowerCase(),
          ) || [];

        const ccRecipients =
          msg.ccRecipients?.map((r) =>
            r.emailAddress?.address?.toLowerCase(),
          ) || [];

        const allRecipients = [...toRecipients, ...ccRecipients];

        if (!allRecipients.includes(senderEmailLower)) {
          skippedCount++;
          continue;
        }

        const from = msg.from?.emailAddress?.address?.toLowerCase();

        if (
          !from ||
          from === senderEmailLower ||
          from.includes("noreply") ||
          from.includes("mailer-daemon")
        ) {
          skippedCount++;
          continue;
        }

        /* =========================
           HEADER MATCHING (CRITICAL)
        ========================= */

        const headers = msg.internetMessageHeaders || [];

        const inReplyTo = headers.find(
          (h) => h.name.toLowerCase() === "in-reply-to",
        )?.value;

        const references = headers.find(
          (h) => h.name.toLowerCase() === "references",
        )?.value;

        const threadIds = [
          inReplyTo,
          ...(references ? references.split(/\s+/) : []),
        ].filter(Boolean);

        let emailId = null;
        let matchedVia = null;

        // Strategy 1: In-Reply-To / References
        for (const ref of threadIds) {
          const cleanRef = ref.replace(/[<>]/g, "");

          if (messageIdMap.has(ref)) {
            emailId = messageIdMap.get(ref);
            matchedVia = "inReplyTo exact";
            break;
          }

          if (messageIdMap.has(cleanRef)) {
            emailId = messageIdMap.get(cleanRef);
            matchedVia = "inReplyTo clean";
            break;
          }
        }

        // Strategy 2: conversationId fallback
        if (!emailId && msg.conversationId) {
          for (const [key, value] of messageIdMap.entries()) {
            if (
              key.includes(msg.conversationId) ||
              msg.conversationId.includes(key)
            ) {
              emailId = value;
              matchedVia = "conversationId";
              break;
            }
          }
        }

        if (!emailId) {
          skippedCount++;
          continue;
        }

        const email = await Email.findByPk(emailId);
        if (!email) {
          skippedCount++;
          continue;
        }

        const normalizedRecipient = normalizeEmailForMatching(
          email.recipientEmail,
        );
        const normalizedFrom = normalizeEmailForMatching(from);

        if (normalizedRecipient !== normalizedFrom) {
          skippedCount++;
          continue;
        }

        log("INFO", "✅ Outlook reply matched", {
          emailId,
          from,
          subject: msg.subject,
          matchedVia,
        });

        await processReply({
          sender: { ...outlookSender.toJSON(), type: "outlook" },
          email,
          reply: {
            from,
            subject: msg.subject || "(no subject)",
            body: msg.body?.content || msg.bodyPreview,
            receivedAt: new Date(msg.receivedDateTime),
            inReplyTo,
            messageId: msg.internetMessageId,
            threadId: msg.conversationId,
          },
        });

        processedCount++;
      } catch (err) {
        skippedCount++;
        log("ERROR", "❌ Outlook message processing failed", {
          error: err.message,
        });
      }
    }

    log("INFO", "📬 Outlook ingestion complete", {
      processedCount,
      skippedCount,
      total: uniqueMessages.length,
    });
  } catch (err) {
    log("ERROR", "❌ Outlook ingestion failed", {
      error: err.message,
    });
  }
}

/* =========================
   SMTP INGESTION - UNCHANGED
========================= */
async function ingestSmtpReplies(smtpSender, messageIdMap) {
  const senderId = smtpSender.id;

  const checkFrom = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  if (messageIdMap.size === 0) {
    log("INFO", "⏭️ Skipping SMTP sender - no campaign emails", {
      email: smtpSender.email,
      senderId,
    });
    return;
  }

  if (
    !smtpSender.imapHost ||
    !smtpSender.imapUsername ||
    !smtpSender.imapPassword
  ) {
    log("WARN", "SMTP sender missing IMAP credentials - cannot check replies", {
      email: smtpSender.email,
      senderId,
    });
    return;
  }

  log("INFO", "🔍 Checking SMTP sender IMAP inbox for replies", {
    email: smtpSender.email,
    senderId,
    checkingSince: checkFrom.toISOString(),
  });

  return new Promise((resolve) => {
    const imap = new Imap({
      user: smtpSender.imapUsername,
      password: smtpSender.imapPassword,
      host: smtpSender.imapHost,
      port: smtpSender.imapPort || 993,
      tls: smtpSender.imapSecure !== false,
      tlsOptions: { rejectUnauthorized: false },
    });

    imap.once("ready", () => {
      imap.openBox("INBOX", false, (err) => {
        if (err) {
          log("ERROR", "Failed to open SMTP sender IMAP inbox", {
            error: err.message,
            sender: smtpSender.email,
          });
          imap.end();
          return resolve();
        }

        const searchCriteria = [["SINCE", checkFrom.toDateString()]];

        imap.search(searchCriteria, (err, results) => {
          if (err || !results?.length) {
            log("DEBUG", "No new SMTP messages in the last 7 days");
            imap.end();
            return resolve();
          }

          const fetch = imap.fetch(results, { bodies: "" });
          let processedCount = 0;

          fetch.on("message", (msg) => {
            let buffer = "";
            let uid;

            msg.once("attributes", (attrs) => (uid = attrs.uid));
            msg.on("body", (s) =>
              s.on("data", (c) => (buffer += c.toString())),
            );

            msg.once("end", async () => {
              try {
                const parsed = await simpleParser(buffer);

                const existingReply = await ReplyEvent.findOne({
                  where: {
                    metadata: {
                      messageId: parsed.messageId,
                    },
                  },
                });

                if (existingReply) {
                  return;
                }

                const toAddresses =
                  parsed.to?.value?.map((v) => v.address?.toLowerCase()) || [];
                const ccAddresses =
                  parsed.cc?.value?.map((v) => v.address?.toLowerCase()) || [];
                const allRecipients = [...toAddresses, ...ccAddresses];

                if (!allRecipients.includes(smtpSender.email.toLowerCase())) {
                  return;
                }

                const from = parsed.from?.value?.[0]?.address?.toLowerCase();
                if (
                  !from ||
                  from === smtpSender.email.toLowerCase() ||
                  from.includes("noreply")
                ) {
                  return;
                }

                if (uid) {
                  imap.addFlags(uid, ["\\Seen"], { uid: true }, () => {});
                }

                const messageDate = parsed.date || new Date();

                const threadIds = [
                  parsed.inReplyTo,
                  ...(parsed.references || []),
                ].filter(Boolean);

                let emailId = null;

                for (const ref of threadIds) {
                  if (messageIdMap.has(ref)) {
                    emailId = messageIdMap.get(ref);
                    break;
                  }
                }

                if (!emailId) {
                  for (const ref of threadIds) {
                    const cleanRef = ref?.replace(/[<>]/g, "") || "";
                    for (const [key, value] of messageIdMap.entries()) {
                      const cleanKey = key.replace(/[<>]/g, "");
                      if (
                        cleanKey.includes(cleanRef) ||
                        cleanRef.includes(cleanKey)
                      ) {
                        emailId = value;
                        break;
                      }
                    }
                    if (emailId) break;
                  }
                }

                if (!emailId && /^re:/i.test(parsed.subject || "")) {
                  const baseSubject = parsed.subject.replace(/^re:\s*/i, "");
                  const email = await Email.findOne({
                    where: {
                      senderId: smtpSender.id,
                      recipientEmail: from,
                      metadata: {
                        subject: { [Op.iLike]: `%${baseSubject}%` },
                      },
                    },
                    order: [["createdAt", "DESC"]],
                  });
                  if (email) emailId = email.id;
                }

                if (!emailId) return;

                const email = await Email.findByPk(emailId);
                if (!email) return;

                const normalizedRecipient = normalizeEmailForMatching(
                  email.recipientEmail,
                );
                const normalizedFrom = normalizeEmailForMatching(from);

                if (normalizedRecipient !== normalizedFrom) {
                  return;
                }

                await processReply({
                  sender: { ...smtpSender.toJSON(), type: "smtp" },
                  email,
                  reply: {
                    from,
                    subject: parsed.subject,
                    body: parsed.html || parsed.text,
                    receivedAt: messageDate,
                    inReplyTo: parsed.inReplyTo,
                    messageId: parsed.messageId,
                  },
                });

                processedCount++;
              } catch (e) {
                log("ERROR", "❌ SMTP IMAP processing error", {
                  error: e.message,
                  sender: smtpSender.email,
                });
              }
            });
          });

          fetch.once("end", () => {
            imap.end();
            log("INFO", "📬 SMTP sender inbox check complete", {
              email: smtpSender.email,
              totalMessages: results.length,
              processedCount,
            });
            resolve();
          });
        });
      });
    });

    imap.once("error", (err) => {
      log("ERROR", "SMTP IMAP connection error", {
        error: err.message,
        sender: smtpSender.email,
      });
      resolve();
    });

    imap.connect();
  });
}

/* =========================
   MAIN LOOP - CHECK ALL SENDER INBOXES FOR REPLIES
========================= */
const POLL_INTERVAL_MS = 60 * 1000;

(async () => {
  log(
    "INFO",
    "🚀 Reply ingestion worker started - checking SENDER inboxes for replies",
  );

  while (true) {
    try {
      const [gmailSenders, outlookSenders, smtpSenders] = await Promise.all([
        GmailSender.findAll({ where: { isVerified: true } }),
        OutlookSender.findAll({ where: { isVerified: true } }),
        SmtpSender.findAll({ where: { isVerified: true } }),
      ]);

      log("INFO", "📊 Checking sender inboxes for replies", {
        gmailCount: gmailSenders.length,
        outlookCount: outlookSenders.length,
        smtpCount: smtpSenders.length,
      });

      // ✅ GMAIL - WORKING
      for (const gmailSender of gmailSenders) {
        try {
          const hasValidScopes = await validateGmailScopes(gmailSender);
          if (!hasValidScopes) {
            log("WARN", "⏭️ Skipping Gmail sender - missing required scopes", {
              email: gmailSender.email,
              senderId: gmailSender.id,
            });
            continue;
          }

          const emails = await Email.findAll({
            where: {
              senderId: gmailSender.id,
              status: ["sent", "routed"],
              providerMessageId: { [Op.ne]: null },
            },
            limit: 1000,
            order: [["createdAt", "DESC"]],
          });

          if (emails.length === 0) {
            log("DEBUG", "⏭️ No campaign emails found for Gmail sender", {
              senderId: gmailSender.id,
              senderEmail: gmailSender.email,
            });
            continue;
          }

          const messageIdMap = new Map();
          emails.forEach((e) => {
            if (e.providerMessageId) {
              const fullId = e.providerMessageId;
              const cleanId = fullId.replace(/[<>]/g, "");
              messageIdMap.set(fullId, e.id);
              messageIdMap.set(cleanId, e.id);
            }
          });

          await ingestGmailReplies(gmailSender, messageIdMap);
        } catch (err) {
          log("ERROR", "Failed to process Gmail sender inbox", {
            senderId: gmailSender.id,
            email: gmailSender.email,
            error: err.message,
          });
        }
      }

      // ✅ OUTLOOK - FIXED TO MATCH GMAIL PATTERN
      for (const outlookSender of outlookSenders) {
        try {
          const emails = await Email.findAll({
            where: {
              senderId: outlookSender.id,
              senderType: "outlook",
              status: { [Op.in]: ["sent", "routed"] },
              providerMessageId: { [Op.ne]: null },
            },
            limit: 1000,
            order: [["createdAt", "DESC"]],
          });

          if (emails.length === 0) {
            log("DEBUG", "⏭️ No campaign emails found for Outlook sender", {
              senderId: outlookSender.id,
              senderEmail: outlookSender.email,
            });
            continue;
          }
          const messageIdMap = new Map();
          emails.forEach((e) => {
            if (e.providerMessageId) {
              const fullId = e.providerMessageId;
              const cleanId = fullId.replace(/[<>]/g, "");
              messageIdMap.set(fullId, e.id);
              messageIdMap.set(cleanId, e.id);

              // ✅ Also store without any special characters for better matching
              const superClean = fullId.replace(/[<>\[\]()]/g, "");
              messageIdMap.set(superClean, e.id);
            }

            // ✅ Also store conversationId if available
            if (e.metadata?.conversationId) {
              messageIdMap.set(e.metadata.conversationId, e.id);
            }
          });

          log("INFO", "📬 Checking Outlook sender with messageIdMap", {
            senderEmail: outlookSender.email,
            emailsSent: emails.length,
            messageIdsTracked: messageIdMap.size,
          });

          await ingestOutlookReplies(outlookSender, messageIdMap);
        } catch (err) {
          log("ERROR", "Failed to process Outlook sender inbox", {
            senderId: outlookSender.id,
            email: outlookSender.email,
            error: err.message,
          });
        }
      }

      // ✅ SMTP - UNCHANGED
      for (const smtpSender of smtpSenders) {
        try {
          const emails = await Email.findAll({
            where: {
              senderId: smtpSender.id,
              status: ["sent", "routed"],
              providerMessageId: { [Op.ne]: null },
            },
            limit: 1000,
            order: [["createdAt", "DESC"]],
          });

          if (emails.length === 0) continue;

          const messageIdMap = new Map();
          emails.forEach((e) => {
            if (e.providerMessageId) {
              messageIdMap.set(e.providerMessageId, e.id);
              messageIdMap.set(e.providerMessageId.replace(/[<>]/g, ""), e.id);
            }
          });

          await ingestSmtpReplies(smtpSender, messageIdMap);
        } catch (err) {
          log("ERROR", "Failed to process SMTP sender inbox", {
            senderId: smtpSender.id,
            email: smtpSender.email,
            error: err.message,
          });
        }
      }
    } catch (err) {
      log("ERROR", "❌ Reply ingestion cycle failed", {
        error: err.message,
        stack: err.stack,
      });
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
})();
