import "../models/index.js";
import nodemailer from "nodemailer";

import Email from "../models/email.model.js";
import Sender from "../models/sender.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import EmailEvent from "../models/email-event.model.js";
import BounceEvent from "../models/bounce-event.model.js";

import { getChannel } from "../queues/rabbitmq.js";
import { QUEUES } from "../queues/queues.js";

import { sendViaMicrosoftGraph } from "../utils/send-via-microsoft.js";

/* =========================
   LOGGER
========================= */
const log = (level, message, meta = {}) => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "email-sender",
      level,
      message,
      ...meta,
    })
  );
};

/* =========================
   WORKER
========================= */
(async () => {
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.EMAIL_SEND, { durable: true });
  channel.prefetch(5);

  log("INFO", "📧 Email Sender started");

  channel.consume(QUEUES.EMAIL_SEND, async (msg) => {
    if (!msg) return;

    const { emailId } = JSON.parse(msg.content.toString());

    let email; // ✅ declare OUTSIDE try

    try {
      email = await Email.findByPk(emailId);

      if (!email || email.status === "sent") {
        channel.ack(msg);
        return;
      }

      const sender = await Sender.findByPk(email.senderId);
      if (!sender) throw new Error("Sender not found");

      await EmailEvent.create({
        emailId,
        eventType: "queued",
        eventTimestamp: new Date(),
      });

      let providerMessageId;

      /* =========================
         OUTLOOK (GRAPH)
      ========================= */
      if (sender.provider === "outlook") {
        log("INFO", "📤 Sending via Microsoft Graph", {
          senderId: sender.id,
        });

        const res = await sendViaMicrosoftGraph(sender, email);
        providerMessageId = res.providerMessageId;
      }

      /* =========================
         SMTP (GMAIL / CUSTOM)
      ========================= */
      else {
        const transporter = nodemailer.createTransport({
          host: sender.smtpHost,
          port: sender.smtpPort,
          secure: sender.smtpSecure,
          auth: {
            user: sender.smtpUser,
            pass: sender.smtpPass,
          },
        });

        const result = await transporter.sendMail({
          from: `"${sender.displayName}" <${sender.email}>`,
          to: email.recipientEmail,
          subject: email.metadata.subject,
          html: email.metadata.htmlBody,
        });

        providerMessageId = result.messageId;
      }

      await EmailEvent.create({
        emailId,
        eventType: "sent",
        eventTimestamp: new Date(),
        metadata: {
          provider: sender.provider,
          providerMessageId,
        },
      });

      await email.update({
        status: "sent",
        providerMessageId,
        sentAt: new Date(),
      });

      log("INFO", "✅ Email sent", {
        emailId,
        provider: sender.provider,
      });

      channel.ack(msg);
    } catch (err) {
      log("ERROR", "💥 Email send failed", {
        emailId,
        error: err.message,
      });

      await EmailEvent.create({
        emailId,
        eventType: "failed",
        eventTimestamp: new Date(),
        metadata: { error: err.message },
      });

      await BounceEvent.create({
        emailId,
        bounceType: "hard",
        reason: err.message,
        occurredAt: new Date(),
      });

      if (email?.recipientEmail) {
        await CampaignRecipient.update(
          { status: "bounced" },
          { where: { email: email.recipientEmail } }
        );
      }

      channel.ack(msg); // ❌ do NOT retry hard failures
    }
  });
})();
