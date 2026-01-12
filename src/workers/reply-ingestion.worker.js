import "../models/index.js";
import axios from "axios";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import { getChannel } from "../queues/rabbitmq.js";
import { QUEUES } from "../queues/queues.js";

const VERIFICATION_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const normalizeEmail = (e) => e.trim().toLowerCase();

const isFresh = (verifiedAt) =>
  verifiedAt &&
  Date.now() - new Date(verifiedAt).getTime() <= VERIFICATION_TTL_MS;

/* =========================
   ENDBOUNCE
========================= */
async function verifyViaEndBounce(email) {
  const submit = await axios.post(
    "https://api.endbounce.com/api/integrations/v1/verify",
    { emails: [email] },
    {
      headers: {
        "x-api-key": process.env.ENDBOUNCE_API_KEY,
        "Content-Type": "application/json",
      },
    }
  );

  const requestId = submit.data.request_id;
  await new Promise((r) => setTimeout(r, 8000));

  for (let i = 0; i < 30; i++) {
    try {
      const res = await axios.get(
        `https://api.endbounce.com/api/integrations/v1/jobs/${requestId}/results?status=all`,
        { headers: { "x-api-key": process.env.ENDBOUNCE_API_KEY } }
      );

      if (res.data.partial) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      const row = res.data.rows?.[0] || {};
      return {
        status: ["valid", "invalid", "risky"].includes(row.status)
          ? row.status
          : "unknown",
        score: row.score ?? null,
        raw: row,
      };
    } catch (e) {
      if (e.response?.status === 404) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      throw e;
    }
  }

  throw new Error("Verification timeout");
}

/* =========================
   WORKER
========================= */
(async () => {
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.EMAIL_VERIFY, { durable: true });
  channel.prefetch(5);

  channel.consume(QUEUES.EMAIL_VERIFY, async (msg) => {
    if (!msg) return;

    let payload;
    try {
      payload = JSON.parse(msg.content.toString());
    } catch {
      channel.ack(msg);
      return;
    }

    const email = payload.email || payload.normalizedEmail;
    if (!email) {
      channel.ack(msg);
      return;
    }

    const normalizedEmail = normalizeEmail(email);

    try {
      const record = await GlobalEmailRegistry.findOne({
        where: { normalizedEmail },
      });

      if (record && isFresh(record.verifiedAt)) {
        channel.ack(msg);
        return;
      }

      const result = await verifyViaEndBounce(normalizedEmail);

      const payloadUpdate = {
        verificationStatus: result.status,
        verificationScore: result.score,
        verificationProvider: "endbounce",
        verificationMeta: result.raw,
        verifiedAt: new Date(),
        lastSeenAt: new Date(),
      };

      if (record) {
        await record.update(payloadUpdate);
      } else {
        await GlobalEmailRegistry.create({
          normalizedEmail,
          domain: normalizedEmail.split("@")[1],
          firstSeenAt: new Date(),
          ...payloadUpdate,
        });
      }

      channel.ack(msg);
    } catch (err) {
      // 🚨 LOGIC / ENUM ERRORS MUST NOT RETRY
      if (
        err.name === "SequelizeDatabaseError" ||
        err.name === "SequelizeValidationError"
      ) {
        console.error("Non-retryable DB error", err.message);
        channel.ack(msg);
        return;
      }

      // 🌐 Only retry network / 5xx
      const retryable = !err.response || err.response.status >= 500;
      channel.nack(msg, false, retryable);
    }
  });

  process.on("SIGINT", async () => {
    await channel.close();
    process.exit(0);
  });
})();
