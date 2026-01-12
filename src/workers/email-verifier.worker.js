import "../models/index.js";
import axios from "axios";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import ListUploadRecord from "../models/list-upload-record.model.js";
import { getChannel } from "../queues/rabbitmq.js";
import { QUEUES } from "../queues/queues.js";
import { Op } from "sequelize";

const VERIFICATION_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 15000; // Poll every 15 seconds
const MAX_POLL_ATTEMPTS = 40; // Max 10 minutes of polling (40 * 15s)

const normalizeEmail = (e) => (e || "").trim().toLowerCase();

const isFresh = (date) =>
  date && Date.now() - new Date(date).getTime() < VERIFICATION_TTL_MS;

/* =========================
   ENDBOUNCE BATCH FUNCTIONS
========================= */
async function submitBatchToEndBounce(emails) {
  console.log(`📤 Submitting batch of ${emails.length} emails to EndBounce`);

  const res = await axios.post(
    "https://api.endbounce.com/api/integrations/v1/verify",
    { emails },
    {
      headers: {
        "x-api-key": process.env.ENDBOUNCE_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 30000,
    }
  );

  console.log(`✅ Batch submitted. Request ID: ${res.data.request_id}`);
  return res.data.request_id;
}

async function pollBatchResults(requestId) {
  try {
    console.log(`🔍 Polling results for request: ${requestId}`);

    const res = await axios.get(
      `https://api.endbounce.com/api/integrations/v1/jobs/${requestId}/results?status=all`,
      {
        headers: { "x-api-key": process.env.ENDBOUNCE_API_KEY },
        timeout: 30000,
      }
    );

    if (res.data.partial) {
      console.log(`⏳ Partial results for request ${requestId}`);
      return {
        ready: false,
        results: null,
      };
    }

    console.log(`✅ Complete results received for request ${requestId}`);

    // Transform results into a map for easy lookup
    const resultsMap = {};
    if (res.data.rows && res.data.rows.length > 0) {
      res.data.rows.forEach((row) => {
        const email = normalizeEmail(row.email);
        resultsMap[email] = {
          status: ["valid", "invalid", "risky"].includes(row.status)
            ? row.status
            : "unknown",
          score: row.score ?? null,
          raw: row,
        };
      });
    }

    return {
      ready: true,
      results: resultsMap,
    };
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`❌ Request ${requestId} not found`);
      return {
        ready: false,
        results: null,
      };
    }
    console.error(`❌ Polling error for ${requestId}:`, err.message);
    throw err;
  }
}

/* =========================
   BATCH PROCESSING WORKER
========================= */
(async () => {
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.EMAIL_VERIFY, { durable: true });
  channel.prefetch(1); // Process one batch at a time

  console.log("🚀 Email Verification Worker started (Batch Mode)");

  channel.consume(QUEUES.EMAIL_VERIFY, async (msg) => {
    if (!msg) return;

    const payload = JSON.parse(msg.content.toString());
    console.log(`📦 Processing batch: ${payload.batchId}`);

    try {
      // Get batch records that need verification
      const batchRecords = await ListUploadRecord.findAll({
        where: {
          batchId: payload.batchId,
          normalizedEmail: { [Op.ne]: null },
          status: { [Op.in]: ["parsed", "duplicate"] },
        },
        limit: 1000, // Process max 1000 emails at once
        attributes: ["id", "normalizedEmail"],
      });

      if (batchRecords.length === 0) {
        console.log(`✅ No emails to verify for batch ${payload.batchId}`);
        channel.ack(msg);
        return;
      }

      console.log(`🔢 Found ${batchRecords.length} emails to verify`);

      // Filter out emails with fresh verification
      const emailsToVerify = [];
      const emailIds = [];

      for (const record of batchRecords) {
        const email = record.normalizedEmail;
        const globalRecord = await GlobalEmailRegistry.findOne({
          where: { normalizedEmail: email },
        });

        if (!globalRecord || !isFresh(globalRecord.verifiedAt)) {
          emailsToVerify.push(email);
          emailIds.push(record.id);
        } else {
          console.log(`✅ Fresh verification exists for ${email}, skipping`);
        }
      }

      if (emailsToVerify.length === 0) {
        console.log(
          `✅ All emails already verified for batch ${payload.batchId}`
        );
        channel.ack(msg);
        return;
      }

      console.log(`🚀 Need to verify ${emailsToVerify.length} emails`);

      // Submit batch to EndBounce
      const requestId = await submitBatchToEndBounce(emailsToVerify);

      // Update GlobalEmailRegistry with verification in progress
      for (const email of emailsToVerify) {
        await GlobalEmailRegistry.upsert({
          normalizedEmail: email,
          verificationStatus: "verifying",
          verificationProvider: "endbounce",
          verificationMeta: {
            requestId,
            batchId: payload.batchId,
            submittedAt: new Date(),
          },
          verifiedAt: new Date(),
          lastSeenAt: new Date(),
        });
      }

      // Poll for results
      let pollAttempts = 0;
      let results = null;

      while (pollAttempts < MAX_POLL_ATTEMPTS && !results) {
        pollAttempts++;

        const pollResult = await pollBatchResults(requestId);

        if (pollResult.ready) {
          results = pollResult.results;
        } else {
          console.log(
            `⏳ Waiting for results (attempt ${pollAttempts}/${MAX_POLL_ATTEMPTS})`
          );

          if (pollAttempts < MAX_POLL_ATTEMPTS) {
            // Wait before next poll
            await new Promise((resolve) =>
              setTimeout(resolve, POLL_INTERVAL_MS)
            );
          }
        }
      }

      if (!results) {
        console.log(
          `❌ Max poll attempts reached for batch ${payload.batchId}`
        );

        // Mark all as unknown
        for (const email of emailsToVerify) {
          await GlobalEmailRegistry.update(
            {
              verificationStatus: "unknown",
              verificationProvider: "endbounce",
              verificationMeta: {
                requestId,
                batchId: payload.batchId,
                error: "Max poll attempts reached",
                pollAttempts,
              },
              verifiedAt: new Date(),
            },
            { where: { normalizedEmail: email } }
          );
        }

        channel.ack(msg);
        return;
      }

      // Process results and update records
      let successCount = 0;
      let errorCount = 0;

      for (const email of emailsToVerify) {
        const result = results[email];

        if (result) {
          // Update GlobalEmailRegistry
          await GlobalEmailRegistry.update(
            {
              verificationStatus: result.status,
              verificationScore: result.score,
              verificationProvider: "endbounce",
              verificationMeta: {
                requestId,
                batchId: payload.batchId,
                raw: result.raw,
                completedAt: new Date(),
              },
              verifiedAt: new Date(),
              lastSeenAt: new Date(),
            },
            { where: { normalizedEmail: email } }
          );

          // Update ListUploadRecord status
          const recordId = emailIds[emailsToVerify.indexOf(email)];
          if (recordId) {
            await ListUploadRecord.update(
              {
                verificationStatus: result.status,
                verificationScore: result.score,
                verificationProvider: "endbounce",
                verificationMeta: { requestId, raw: result.raw },
                verifiedAt: new Date(),
              },
              { where: { id: recordId } }
            );
          }

          successCount++;
          console.log(`✅ ${email}: ${result.status}`);
        } else {
          console.log(`❌ No result for ${email}`);
          errorCount++;

          // Update as unknown
          await GlobalEmailRegistry.update(
            {
              verificationStatus: "unknown",
              verificationProvider: "endbounce",
              verificationMeta: {
                requestId,
                batchId: payload.batchId,
                error: "No result returned",
                completedAt: new Date(),
              },
              verifiedAt: new Date(),
            },
            { where: { normalizedEmail: email } }
          );
        }
      }

      console.log(`🎉 Batch ${payload.batchId} completed!`);
      console.log(`   Success: ${successCount}, Errors: ${errorCount}`);
    } catch (err) {
      console.error(
        `❌ Failed to process batch ${payload.batchId}:`,
        err.message
      );

      // Mark all batch emails as error
      try {
        const batchRecords = await ListUploadRecord.findAll({
          where: {
            batchId: payload.batchId,
            normalizedEmail: { [Op.ne]: null },
          },
          attributes: ["normalizedEmail"],
        });

        for (const record of batchRecords) {
          if (record.normalizedEmail) {
            await GlobalEmailRegistry.update(
              {
                verificationStatus: "unknown",
                verificationProvider: "endbounce",
                verificationMeta: {
                  batchId: payload.batchId,
                  error: err.message,
                  failedAt: new Date(),
                },
                verifiedAt: new Date(),
              },
              { where: { normalizedEmail: record.normalizedEmail } }
            );
          }
        }
      } catch (updateError) {
        console.error("Failed to update error status:", updateError);
      }
    }

    channel.ack(msg);
  });

  // Handle process termination
  process.on("SIGINT", async () => {
    console.log("🛑 Shutting down worker...");
    await channel.close();
    process.exit(0);
  });
})();
