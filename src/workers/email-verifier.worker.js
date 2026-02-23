// workers/email-verifier.worker.js
import "../models/index.js";
import axios from "axios";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import ListUploadRecord from "../models/list-upload-record.model.js";
import ListUploadBatch from "../models/list-upload-batch.model.js";
import { getChannel } from "../queues/rabbit.js";
import { QUEUES } from "../queues/queues.js";
import { Op } from "sequelize";

/* =========================
   CONSTANTS
========================= */
const VERIFICATION_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 15000;
const MAX_POLL_ATTEMPTS = 60;
const BATCH_SIZE_LIMIT = 500;

const MAX_EMAIL_RETRIES = 3;
const RETRY_DELAY_MS = 20_000;

/* =========================
   HELPERS
========================= */
const normalizeEmail = (e) => (e || "").trim().toLowerCase();

const isFresh = (date) =>
  date && Date.now() - new Date(date).getTime() < VERIFICATION_TTL_MS;

const canRetryEmail = (meta) => (meta?.retryCount ?? 0) < MAX_EMAIL_RETRIES;

const nextRetryMeta = (oldMeta = {}) => ({
  ...oldMeta,
  retryCount: (oldMeta.retryCount ?? 0) + 1,
  lastRetryAt: new Date(),
});

/* =========================
   ENDBOUNCE API
========================= */
async function submitBatchToEndBounce(emails) {
  console.log(`📤 Submitting ${emails.length} emails to EndBounce`);

  const res = await axios.post(
    "https://api.endbounce.com/api/integrations/v1/verify",
    { emails },
    {
      headers: {
        "x-api-key": process.env.ENDBOUNCE_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    },
  );

  console.log(`🆔 requestId=${res.data.request_id}`);
  return res.data.request_id;
}

async function pollBatchResults(requestId) {
  const res = await axios.get(
    `https://api.endbounce.com/api/integrations/v1/jobs/${requestId}/results`,
    {
      params: { status: "all" },
      headers: { "x-api-key": process.env.ENDBOUNCE_API_KEY },
      timeout: 30000,
    },
  );

  const results = {};
  if (res.data.rows?.length) {
    for (const row of res.data.rows) {
      results[normalizeEmail(row.email)] = {
        status: row.status ?? "unknown",
        score: row.score ?? null,
        raw: row,
      };
    }
  }

  return { ready: res.data.partial === false, results };
}

/* =========================
   WORKER
========================= */
(async () => {
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.EMAIL_VERIFY, { durable: true });
  channel.prefetch(1);

  console.log("🚀 Email Verification Worker started");

  channel.consume(QUEUES.EMAIL_VERIFY, async (msg) => {
    if (!msg) return;
    const { batchId } = JSON.parse(msg.content.toString());

    try {
      const batch = await ListUploadBatch.findByPk(batchId);
      if (!batch) {
        channel.ack(msg);
        return;
      }

      await batch.update({
        status: "verifying",
        verificationStartedAt: new Date(),
      });

      const records = await ListUploadRecord.findAll({
        where: {
          batchId,
          normalizedEmail: { [Op.ne]: null },
          status: { [Op.in]: ["parsed", "duplicate"] },
        },
        attributes: ["normalizedEmail"],
      });

      let emails = records.map((r) => normalizeEmail(r.normalizedEmail));

      for (let i = 0; i < emails.length; i += BATCH_SIZE_LIMIT) {
        const chunk = emails.slice(i, i + BATCH_SIZE_LIMIT);
        let pendingEmails = [...chunk];

        for (let attempt = 0; attempt <= MAX_EMAIL_RETRIES; attempt++) {
          if (!pendingEmails.length) break;

          if (attempt > 0) {
            console.log(
              `🔁 Retry ${attempt}/${MAX_EMAIL_RETRIES} for ${pendingEmails.length} emails`,
            );
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          }

          const requestId = await submitBatchToEndBounce(pendingEmails);

          await GlobalEmailRegistry.update(
            {
              verificationStatus: "verifying",
              verificationMeta: { requestId, batchId, attempt },
              verifiedAt: new Date(),
            },
            {
              where: {
                normalizedEmail: { [Op.in]: pendingEmails },
                verificationStatus: "unknown",
              },
            },
          );

          let results = null;

          for (let poll = 1; poll <= MAX_POLL_ATTEMPTS; poll++) {
            const res = await pollBatchResults(requestId);
            if (res.ready) {
              results = res.results;
              break;
            }
            await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          }

          if (!results) continue;

          const stillPending = [];
          const successUpdates = [];

          // Group by status for bulk updates
          const updatesByStatus = {};

          for (const email of pendingEmails) {
            const result = results[email];

            if (result) {
              const status = result.status;
              if (!updatesByStatus[status]) updatesByStatus[status] = [];
              updatesByStatus[status].push(email);
            } else {
              const record = await GlobalEmailRegistry.findOne({
                where: { normalizedEmail: email },
              });

              if (canRetryEmail(record?.verificationMeta)) {
                stillPending.push(email);
                await GlobalEmailRegistry.update(
                  {
                    verificationMeta: nextRetryMeta(record?.verificationMeta),
                  },
                  { where: { normalizedEmail: email } },
                );
              } else {
                console.log(`❌ ${email} max retries reached`);
                await GlobalEmailRegistry.update(
                  {
                    verificationStatus: "unknown",
                    verificationMeta: {
                      ...record?.verificationMeta,
                      finalFailure: true,
                    },
                    verifiedAt: new Date(),
                  },
                  { where: { normalizedEmail: email } },
                );
              }
            }
          }

          // Bulk Update Registry for successes
          for (const [status, emailList] of Object.entries(updatesByStatus)) {
            console.log(`✅ Bulk updating ${emailList.length} emails to ${status}`);
            await GlobalEmailRegistry.update(
              {
                verificationStatus: status,
                verifiedAt: new Date(),
                // Note: verificationScore/Meta would differ per email if we wanted precision,
                // but for bulk we can use the common requestId/batchId
                verificationMeta: {
                  requestId,
                  batchId,
                  completedAt: new Date(),
                },
              },
              { where: { normalizedEmail: { [Op.in]: emailList } } },
            );
          }

          pendingEmails = stillPending;
        }
      }

      await batch.update({
        status: "verified",
        verificationCompletedAt: new Date(),
      });
    } catch (err) {
      console.error("❌ Worker failed:", err);
      await ListUploadBatch.update(
        { status: "verification_failed", verificationError: err.message },
        { where: { id: batchId } },
      );
    }

    channel.ack(msg);
  });

  process.on("SIGINT", async () => {
    console.log("🛑 Worker shutting down");
    await channel.close();
    process.exit(0);
  });
})();
