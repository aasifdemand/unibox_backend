// workers/email-verifier.worker.js - CORRECTED VERSION
import "../models/index.js";
import axios from "axios";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import ListUploadRecord from "../models/list-upload-record.model.js";
import ListUploadBatch from "../models/list-upload-batch.model.js";
import { getChannel } from "../queues/rabbitmq.js";
import { QUEUES } from "../queues/queues.js";
import { Op } from "sequelize";

const VERIFICATION_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const POLL_INTERVAL_MS = 15000; // Poll every 15 seconds
const MAX_POLL_ATTEMPTS = 60; // Max 15 minutes of polling (60 * 15s)
const BATCH_SIZE_LIMIT = 500; // Process 500 emails at a time

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
      timeout: 60000,
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
        completedCount: res.data.rows?.length || 0,
        total: res.data.total || 0,
      };
    }

    console.log(`✅ Complete results received for request ${requestId}`);

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
      completedCount: res.data.rows?.length || 0,
      total: res.data.total || 0,
    };
  } catch (err) {
    if (err.response?.status === 404) {
      console.log(`❌ Request ${requestId} not found`);
      return {
        ready: false,
        results: null,
        error: "Request not found",
      };
    }
    console.error(`❌ Polling error for ${requestId}:`, err.message);
    throw err;
  }
}

/* =========================
   BATCH PROCESSING WORKER - USING ACTUAL FIELDS
========================= */
(async () => {
  const channel = await getChannel();
  await channel.assertQueue(QUEUES.EMAIL_VERIFY, { durable: true });
  channel.prefetch(1);

  console.log("🚀 Email Verification Worker started (Batch Mode)");

  channel.consume(QUEUES.EMAIL_VERIFY, async (msg) => {
    if (!msg) return;

    const payload = JSON.parse(msg.content.toString());
    const batchId = payload.batchId;
    console.log(`📦 Processing batch: ${batchId}`);

    try {
      // Get the batch
      const batch = await ListUploadBatch.findByPk(batchId);
      if (!batch) {
        console.error(`❌ Batch ${batchId} not found`);
        channel.ack(msg);
        return;
      }

      // Update batch status to verifying
      await batch.update({
        status: "verifying",
        verificationStartedAt: new Date(),
      });

      // Get ALL batch records that need verification
      // NOTE: ListUploadRecord doesn't have verification fields!
      const allBatchRecords = await ListUploadRecord.findAll({
        where: {
          batchId: batchId,
          normalizedEmail: { [Op.ne]: null },
          status: { [Op.in]: ["parsed", "duplicate"] },
        },
        attributes: ["id", "normalizedEmail"], // Only fields that exist
        order: [["id", "ASC"]],
      });

      if (allBatchRecords.length === 0) {
        console.log(`✅ No emails to verify for batch ${batchId}`);
        await batch.update({
          status: "verified",
          verificationCompletedAt: new Date(),
        });
        channel.ack(msg);
        return;
      }

      console.log(`🔢 Total emails in batch: ${allBatchRecords.length}`);

      // Filter out emails with fresh verification in GlobalEmailRegistry
      const emailsToVerify = [];
      const emailIds = [];

      for (const record of allBatchRecords) {
        const email = record.normalizedEmail;

        // Check GlobalEmailRegistry for existing verification
        const globalRecord = await GlobalEmailRegistry.findOne({
          where: { normalizedEmail: email },
        });

        if (!globalRecord || !isFresh(globalRecord.verifiedAt)) {
          emailsToVerify.push(email);
          emailIds.push(record.id);
        } else {
          console.log(`✅ Fresh verification exists for ${email}, skipping`);
          // No need to update ListUploadRecord - it doesn't have verification fields
        }
      }

      if (emailsToVerify.length === 0) {
        console.log(`✅ All emails already verified for batch ${batchId}`);
        await batch.update({
          status: "verified",
          verificationCompletedAt: new Date(),
        });
        channel.ack(msg);
        return;
      }

      console.log(`🚀 Need to verify ${emailsToVerify.length} emails`);

      // Process in chunks
      const chunks = [];
      for (let i = 0; i < emailsToVerify.length; i += BATCH_SIZE_LIMIT) {
        chunks.push({
          emails: emailsToVerify.slice(i, i + BATCH_SIZE_LIMIT),
          ids: emailIds.slice(i, i + BATCH_SIZE_LIMIT),
          chunkNumber: Math.floor(i / BATCH_SIZE_LIMIT) + 1,
          totalChunks: Math.ceil(emailsToVerify.length / BATCH_SIZE_LIMIT),
        });
      }

      let totalSuccess = 0;
      let totalErrors = 0;

      // Process each chunk
      for (const chunk of chunks) {
        console.log(
          `\n📦 Processing chunk ${chunk.chunkNumber}/${chunk.totalChunks} (${chunk.emails.length} emails)`
        );

        // Submit chunk to EndBounce
        const requestId = await submitBatchToEndBounce(chunk.emails);

        // Update GlobalEmailRegistry with verification in progress
        for (const email of chunk.emails) {
          await GlobalEmailRegistry.upsert({
            normalizedEmail: email,
            verificationStatus: "verifying",
            verificationProvider: "endbounce",
            verificationMeta: {
              requestId,
              batchId: batchId,
              chunk: chunk.chunkNumber,
              submittedAt: new Date(),
            },
            verifiedAt: new Date(),
            lastSeenAt: new Date(),
          });
        }

        // Poll for results
        let pollAttempts = 0;
        let results = null;
        let pollResult;

        while (pollAttempts < MAX_POLL_ATTEMPTS) {
          pollAttempts++;

          console.log(
            `🔍 Polling attempt ${pollAttempts}/${MAX_POLL_ATTEMPTS} for chunk ${chunk.chunkNumber}`
          );

          pollResult = await pollBatchResults(requestId);

          if (pollResult.ready) {
            results = pollResult.results;
            console.log(`✅ Chunk ${chunk.chunkNumber} results ready!`);
            break;
          } else {
            const completed = pollResult.completedCount || 0;
            const total = pollResult.total || chunk.emails.length;
            const progress = Math.round((completed / total) * 100);

            console.log(
              `⏳ Chunk ${chunk.chunkNumber}: ${completed}/${total} completed (${progress}%)`
            );

            if (pollAttempts < MAX_POLL_ATTEMPTS) {
              await new Promise((resolve) =>
                setTimeout(resolve, POLL_INTERVAL_MS)
              );
            }
          }
        }

        if (!results) {
          console.log(
            `❌ Max poll attempts reached for chunk ${chunk.chunkNumber}`
          );

          // Mark all in chunk as unknown in GlobalEmailRegistry
          for (const email of chunk.emails) {
            await GlobalEmailRegistry.update(
              {
                verificationStatus: "unknown",
                verificationProvider: "endbounce",
                verificationMeta: {
                  requestId,
                  batchId: batchId,
                  chunk: chunk.chunkNumber,
                  error: "Max poll attempts reached",
                  pollAttempts,
                },
                verifiedAt: new Date(),
              },
              { where: { normalizedEmail: email } }
            );
          }

          totalErrors += chunk.emails.length;
          continue;
        }

        // Process results
        let chunkSuccess = 0;
        let chunkErrors = 0;

        for (let i = 0; i < chunk.emails.length; i++) {
          const email = chunk.emails[i];
          const result = results[email];

          if (result) {
            // Update GlobalEmailRegistry with final result
            await GlobalEmailRegistry.update(
              {
                verificationStatus: result.status,
                verificationScore: result.score,
                verificationProvider: "endbounce",
                verificationMeta: {
                  requestId,
                  batchId: batchId,
                  chunk: chunk.chunkNumber,
                  raw: result.raw,
                  completedAt: new Date(),
                },
                verifiedAt: new Date(),
                lastSeenAt: new Date(),
              },
              { where: { normalizedEmail: email } }
            );

            chunkSuccess++;
            console.log(`✅ ${email}: ${result.status}`);
          } else {
            console.log(`❌ No result for ${email}`);

            await GlobalEmailRegistry.update(
              {
                verificationStatus: "unknown",
                verificationProvider: "endbounce",
                verificationMeta: {
                  requestId,
                  batchId: batchId,
                  chunk: chunk.chunkNumber,
                  error: "No result returned",
                  completedAt: new Date(),
                },
                verifiedAt: new Date(),
              },
              { where: { normalizedEmail: email } }
            );

            chunkErrors++;
          }
        }

        totalSuccess += chunkSuccess;
        totalErrors += chunkErrors;

        console.log(
          `✅ Chunk ${chunk.chunkNumber} completed: ${chunkSuccess} success, ${chunkErrors} errors`
        );

        // Small delay between chunks
        if (chunk.chunkNumber < chunk.totalChunks) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      // Update final batch status
      await batch.update({
        status: "verified",
        verificationCompletedAt: new Date(),
        verifiedCount: totalSuccess,
        failedVerificationCount: totalErrors,
      });

      console.log(`\n🎉 Batch ${batchId} COMPLETELY PROCESSED!`);
      console.log(`   Total Success: ${totalSuccess}`);
      console.log(`   Total Errors: ${totalErrors}`);
      console.log(
        `   Total Skipped: ${allBatchRecords.length - emailsToVerify.length}`
      );
    } catch (err) {
      console.error(`❌ Failed to process batch ${batchId}:`, err.message);

      // Update batch status to verification_failed
      try {
        const batch = await ListUploadBatch.findByPk(batchId);
        if (batch) {
          await batch.update({
            status: "verification_failed",
            verificationError: err.message,
          });
        }
      } catch (updateError) {
        console.error("Failed to update batch status:", updateError);
      }

      // Mark all emails as error in GlobalEmailRegistry
      try {
        const batchRecords = await ListUploadRecord.findAll({
          where: {
            batchId: batchId,
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
                  batchId: batchId,
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

  process.on("uncaughtException", async (error) => {
    console.error("⚠️ Uncaught Exception:", error);
    await channel.close();
    process.exit(1);
  });

  process.on("unhandledRejection", async (reason, promise) => {
    console.error("⚠️ Unhandled Rejection at:", promise, "reason:", reason);
    await channel.close();
    process.exit(1);
  });
})();
