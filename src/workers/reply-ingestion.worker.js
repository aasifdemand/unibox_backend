import "../models/index.js";
import axios from "axios";
import Imap from "imap";
import { simpleParser } from "mailparser";
import https from "https";
import { Op } from "sequelize";

import Sender from "../models/sender.model.js";
import Email from "../models/email.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import ReplyEvent from "../models/reply-event.model.js";

import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";

/* =========================
   CONSTANTS
========================= */
const GMAIL_MAILBOXES = ["INBOX", "[Gmail]/All Mail"];

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
    })
  );

/* =========================
   PROCESS REPLY (AUTHORITATIVE)
========================= */
async function processReply({ sender, email, reply }) {
  log("INFO", "📩 Reply detected", {
    emailId: email.id,
    from: reply.from,
  });

  await ReplyEvent.create({
    emailId: email.id,
    replyFrom: reply.from,
    subject: reply.subject,
    body: reply.body,
    receivedAt: reply.receivedAt,
    metadata: {
      provider: sender.provider,
      inReplyTo: reply.inReplyTo,
    },
  });

  await email.update({
    status: "replied",
    repliedAt: reply.receivedAt || new Date(),
  });

  await CampaignRecipient.update(
    { status: "replied", repliedAt: reply.receivedAt || new Date() },
    {
      where: {
        campaignId: email.campaignId,
        email: email.recipientEmail,
      },
    }
  );

  await CampaignSend.update(
    { status: "skipped" },
    {
      where: {
        campaignId: email.campaignId,
        status: "queued",
      },
    }
  );

  log("INFO", "🛑 Follow-ups stopped", { emailId: email.id });
}

/* =========================
   IMAP INGESTION (FIXED)
========================= */
async function ingestViaImap(sender, messageIdMap) {
  return new Promise((resolve) => {
    const imap = new Imap({
      user: sender.imapUser,
      password: sender.imapPass,
      host: sender.imapHost,
      port: sender.imapPort,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
    });

    let mailboxIndex = 0;
    let processed = 0;

    const nextMailbox = () => {
      if (mailboxIndex >= GMAIL_MAILBOXES.length) {
        imap.end();
        return resolve(processed);
      }

      const mailbox = GMAIL_MAILBOXES[mailboxIndex++];
      log("INFO", "📂 Opening mailbox", { mailbox });

      imap.openBox(mailbox, false, (err) => {
        if (err) return nextMailbox();

        imap.search(["ALL"], (err, results) => {
          if (!results?.length) return nextMailbox();

          const fetch = imap.fetch(results, {
            bodies: "",
            struct: true,
          });

          fetch.on("message", (msg) => {
            let buffer = "";
            let uid = null;

            msg.once("attributes", (attrs) => {
              uid = attrs.uid;
            });

            msg.on("body", (s) =>
              s.on("data", (c) => (buffer += c.toString()))
            );

            msg.once("end", async () => {
              try {
                const parsed = await simpleParser(buffer);

                // Mark SEEN immediately
                if (uid) {
                  imap.addFlags(uid, ["\\Seen"], { uid: true }, () => {});
                }

                const from = parsed.from?.value?.[0]?.address?.toLowerCase();

                // Skip self-sent & system emails
                if (!from || from === sender.email.toLowerCase()) return;
                if (from.includes("noreply")) return;

                log("DEBUG", "📧 Parsed IMAP message", {
                  subject: parsed.subject,
                  from,
                  inReplyTo: parsed.inReplyTo,
                  references: parsed.references,
                });

                // Collect possible thread IDs
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

                // Subject fallback
                if (!emailId && /^re:/i.test(parsed.subject || "")) {
                  const baseSubject = parsed.subject.replace(/^re:\s*/i, "");

                  const fallback = await Email.findOne({
                    where: {
                      senderId: sender.id,
                      subject: { [Op.iLike]: `%${baseSubject}%` },
                    },
                  });

                  if (fallback) emailId = fallback.id;
                }

                if (!emailId) return;

                const email = await Email.findByPk(emailId);
                if (!email || email.status === "replied") return;

                await processReply({
                  sender,
                  email,
                  reply: {
                    from,
                    subject: parsed.subject,
                    body: parsed.html || parsed.text,
                    receivedAt: parsed.date || new Date(),
                    inReplyTo: parsed.inReplyTo,
                  },
                });

                processed++;
              } catch (e) {
                log("ERROR", "❌ IMAP processing error", { error: e.message });
              }
            });
          });

          fetch.once("end", nextMailbox);
        });
      });
    };

    imap.once("ready", nextMailbox);
    imap.once("error", () => resolve(processed));
    imap.connect();
  });
}

/* =========================
   OUTLOOK INGESTION (SAFE)
========================= */
async function ingestViaOutlook(sender, messageIdMap) {
  const token = await getValidMicrosoftToken(sender);
  const agent = new https.Agent({ rejectUnauthorized: false });

  const res = await axios.get(
    "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages",
    {
      headers: { Authorization: `Bearer ${token}` },
      params: { $top: 50, $orderby: "receivedDateTime desc" },
      httpsAgent: agent,
    }
  );

  let processed = 0;

  for (const msg of res.data.value || []) {
    const threadIds = [msg.inReplyTo, ...(msg.references || [])].filter(
      Boolean
    );

    let emailId = null;

    for (const ref of threadIds) {
      if (messageIdMap.has(ref)) {
        emailId = messageIdMap.get(ref);
        break;
      }
    }

    if (!emailId) continue;

    const email = await Email.findByPk(emailId);
    if (!email || email.status === "replied") continue;

    await processReply({
      sender,
      email,
      reply: {
        from: msg.from?.emailAddress?.address,
        subject: msg.subject,
        body: msg.body?.content,
        receivedAt: new Date(msg.receivedDateTime),
        inReplyTo: msg.inReplyTo,
      },
    });

    processed++;
  }

  return processed;
}

/* =========================
   MAIN LOOP
========================= */
const POLL_INTERVAL_MS = 1 * 60 * 1000;

(async () => {
  log("INFO", "🚀 Reply ingestion worker started");

  while (true) {
    try {
      const senders = await Sender.findAll({ where: { isVerified: true } });

      for (const sender of senders) {
        const emails = await Email.findAll({
          where: {
            senderId: sender.id,
            status: "sent",
            providerMessageId: { [Op.ne]: null },
          },
          limit: 1000,
          order: [["createdAt", "DESC"]],
        });

        const map = new Map();
        emails.forEach((e) => map.set(e.providerMessageId, e.id));

        if (sender.provider === "outlook") {
          await ingestViaOutlook(sender, map);
        } else if (sender.imapHost && sender.imapUser && sender.imapPass) {
          await ingestViaImap(sender, map);
        }
      }
    } catch (err) {
      log("ERROR", "❌ Reply ingestion cycle failed", {
        error: err.message,
      });
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
})();
