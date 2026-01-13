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
import { tryCompleteCampaign } from "../utils/campaign-completion.checker.js";

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
   PROCESS REPLY (SAFE)
========================= */
async function processReply({ sender, email, reply }) {
  // 🔒 Idempotency
  if (email.status === "replied") return;

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
    }
  );

  if (recipient) {
    await Campaign.increment("totalReplied", {
      by: 1,
      where: { id: email.campaignId },
    });
  }

  // 🔕 Cancel future sends
  await CampaignSend.update(
    { status: "skipped" },
    {
      where: {
        campaignId: email.campaignId,
        recipientId: recipient.id,
        status: "queued",
      },
    }
  );

  log("INFO", "🛑 Follow-ups stopped for recipient", {
    campaignId: email.campaignId,
    recipientId: recipient.id,
  });

  await tryCompleteCampaign(email.campaignId);
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

    const nextMailbox = () => {
      if (mailboxIndex >= GMAIL_MAILBOXES.length) {
        imap.end();
        return resolve();
      }

      const mailbox = GMAIL_MAILBOXES[mailboxIndex++];
      log("INFO", "📂 Opening mailbox", { mailbox });

      imap.openBox(mailbox, false, (err) => {
        if (err) return nextMailbox();

        imap.search(["ALL"], (err, results) => {
          if (!results?.length) return nextMailbox();

          const fetch = imap.fetch(results, { bodies: "" });

          fetch.on("message", (msg) => {
            let buffer = "";
            let uid;

            msg.once("attributes", (attrs) => (uid = attrs.uid));
            msg.on("body", (s) =>
              s.on("data", (c) => (buffer += c.toString()))
            );

            msg.once("end", async () => {
              try {
                const parsed = await simpleParser(buffer);

                if (uid) {
                  imap.addFlags(uid, ["\\Seen"], { uid: true }, () => {});
                }

                const from = parsed.from?.value?.[0]?.address?.toLowerCase();
                if (!from || from === sender.email.toLowerCase()) return;
                if (from.includes("noreply")) return;

                log("DEBUG", "📧 Parsed IMAP message", {
                  subject: parsed.subject,
                  from,
                  inReplyTo: parsed.inReplyTo,
                });

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

                // ✅ JSONB subject fallback (FIXED)
                if (!emailId && /^re:/i.test(parsed.subject || "")) {
                  const baseSubject = parsed.subject.replace(/^re:\s*/i, "");

                  const fallback = await Email.findOne({
                    where: {
                      senderId: sender.id,
                      metadata: {
                        subject: { [Op.iLike]: `%${baseSubject}%` },
                      },
                    },
                    order: [["createdAt", "DESC"]],
                  });

                  if (fallback) emailId = fallback.id;
                }

                if (!emailId) return;

                const email = await Email.findByPk(emailId);
                if (!email) return;

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
    imap.once("error", () => resolve());
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

  for (const msg of res.data.value || []) {
    const refs = [msg.inReplyTo, ...(msg.references || [])].filter(Boolean);

    let emailId = null;
    for (const ref of refs) {
      if (messageIdMap.has(ref)) {
        emailId = messageIdMap.get(ref);
        break;
      }
    }

    if (!emailId) continue;

    const email = await Email.findByPk(emailId);
    if (!email) continue;

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
  }
}

/* =========================
   MAIN LOOP
========================= */
const POLL_INTERVAL_MS = 60 * 1000;

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
        } else if (sender.imapHost) {
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
