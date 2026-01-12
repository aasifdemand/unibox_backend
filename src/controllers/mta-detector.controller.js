import { asyncHandler } from "../helpers/async-handler.js";
import { mtaDetectorCache } from "../services/mta-detector-cache.service.js";
import AppError from "../utils/app-error.js";

/**
 * SINGLE EMAIL DETECT
 * GET /detect?email=
 */
export const detectProvider = asyncHandler(async (req, res) => {
  const { email } = req.query;

  if (!email) {
    throw new AppError("Email query parameter is required", 400);
  }

  const result = await mtaDetectorCache.detect(email);

  res.json({
    success: true,
    data: {
      input: email,
      type: "email",
      ...result,
    },
  });
});

/**
 * BULK EMAIL DETECT
 * POST /detect/bulk
 */
export const bulkDetectProviders = asyncHandler(async (req, res) => {
  const { emails = [] } = req.body;

  if (!Array.isArray(emails) || emails.length === 0) {
    throw new AppError("emails[] array is required", 400);
  }

  if (emails.length > 100) {
    throw new AppError("Batch size limit exceeded (100)", 400);
  }

  // Deduplicate (case-insensitive)
  const uniqueEmails = [...new Set(emails.map((e) => e.toLowerCase()))];

  const results = await Promise.all(
    uniqueEmails.map(async (email) => {
      try {
        const result = await mtaDetectorCache.detect(email);
        return {
          input: email,
          success: true,
          result,
        };
      } catch (err) {
        return {
          input: email,
          success: false,
          error: err.message,
        };
      }
    })
  );

  res.json({
    success: true,
    data: {
      total: results.length,
      successCount: results.filter((r) => r.success).length,
      failureCount: results.filter((r) => !r.success).length,
      results,
    },
  });
});

export const clearDetectionCache = asyncHandler(async (req, res) => {
  const { domain } = req.query;
  await mtaDetectorCache.clearCache(domain);
  res.json({ success: true });
});
