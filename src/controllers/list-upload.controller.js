import crypto from "crypto";
import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import csv from "csv-parser";
import XLSX from "xlsx";
import ListUploadBatch from "../models/list-upload-batch.model.js";
import ListUploadRecord from "../models/list-upload-record.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import { Op, fn, col, literal } from "sequelize";
import { asyncHandler } from "../helpers/async-handler.js";
import sequelize from "../config/db.js";
import {
  normalizeEmail,
  extractDomain,
  isValidEmail,
  getEmailProvider,
} from "../utils/email-processor.js";
import { enqueueEmailVerification } from "../helpers/enqueue-email-verifier.js";

// Ensure uploads directory exists
const ensureUploadsDir = async () => {
  const uploadsDir = path.join(process.cwd(), "src/uploads");
  try {
    await fsPromises.access(uploadsDir);
  } catch {
    await fsPromises.mkdir(uploadsDir, { recursive: true });
  }
  return uploadsDir;
};

export const uploadList = async (req, res) => {
  try {
    // Ensure upload directory exists
    await ensureUploadsDir();

    const file = req.file;
    const userId = req.user.id;

    if (!file) {
      return res.status(400).json({
        success: false,
        message: "File required",
      });
    }

    console.log(`📁 File uploaded: ${file.originalname}, path: ${file.path}`);

    // Check if file exists
    if (!fs.existsSync(file.path)) {
      return res.status(500).json({
        success: false,
        message: "File not saved properly",
      });
    }

    // Calculate checksum
    const fileBuffer = fs.readFileSync(file.path);
    const checksum = crypto
      .createHash("sha256")
      .update(fileBuffer)
      .digest("hex");

    // Check for duplicate upload
    const existingBatch = await ListUploadBatch.findOne({
      where: {
        userId,
        checksum,
        status: { [Op.ne]: "failed" },
      },
    });

    if (existingBatch) {
      // Clean up uploaded file
      try {
        fs.unlinkSync(file.path);
      } catch (cleanupError) {
        console.error("Failed to cleanup duplicate file:", cleanupError);
      }

      return res.status(409).json({
        success: false,
        message: "Duplicate upload detected",
        batchId: existingBatch.id,
      });
    }

    // Create batch record
    const batch = await ListUploadBatch.create({
      userId,
      originalFilename: file.originalname,
      storagePath: file.path,
      fileType: file.originalname.split(".").pop().toLowerCase(),
      checksum,
      status: "uploaded",
    });

    console.log(`✅ Batch created: ${batch.id}`);

    // Parse and process immediately (non-blocking)
    processUploadedFile(batch.id, userId).catch((error) => {
      console.error(`❌ Failed to process batch ${batch.id}:`, error);
    });

    return res.status(202).json({
      success: true,
      batchId: batch.id,
      status: "uploaded",
      message: "File accepted and processing started",
    });
  } catch (error) {
    console.error("Upload error:", error);

    // Clean up file if exists
    if (req.file && req.file.path && fs.existsSync(req.file.path)) {
      try {
        fs.unlinkSync(req.file.path);
      } catch (cleanupError) {
        console.error("Failed to cleanup error file:", cleanupError);
      }
    }

    return res.status(500).json({
      success: false,
      message: "Upload failed",
      error: error.message,
    });
  }
};

// CSV Parser function (was missing)
const parseCSV = (filePath) => {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (data) => results.push(data))
      .on("end", () => resolve(results))
      .on("error", (error) => reject(error));
  });
};

// Parse Excel
const parseXLSX = (filePath) => {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const records = XLSX.utils.sheet_to_json(worksheet);

    // Normalize header names
    return records.map((record) => {
      const normalizedRecord = {};
      Object.keys(record).forEach((key) => {
        if (record[key] !== undefined && record[key] !== null) {
          const normalizedKey = key
            .toString()
            .toLowerCase()
            .replace(/\s+/g, "");
          normalizedRecord[normalizedKey] = record[key];
        }
      });
      return normalizedRecord;
    });
  } catch (error) {
    console.error("Excel parsing error:", error);
    throw new Error(`Failed to parse Excel file: ${error.message}`);
  }
};

// Parse TXT
const parseTXT = (filePath) => {
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const trimmed = line.trim();
      if (trimmed.includes(",") && !trimmed.includes("@")) {
        const parts = trimmed.split(",");
        if (parts.length > 1 && parts[0].includes("@")) {
          return { email: parts[0].trim() };
        }
      }
      return { email: trimmed };
    });
};

// Find email field in record
const findEmailField = (record) => {
  if (!record) return null;

  const possibleEmailFields = [
    "email",
    "emailaddress",
    "mail",
    "e-mail",
    "e_mail",
    "emailid",
    "useremail",
    "username",
    "contactemail",
    "primaryemail",
  ];

  // Check exact matches first
  for (const field of possibleEmailFields) {
    if (
      record[field] !== undefined &&
      record[field] !== null &&
      record[field] !== ""
    ) {
      return String(record[field]).trim();
    }
  }

  // Check if any key contains "email"
  for (const key in record) {
    if (
      key.toLowerCase().includes("email") &&
      record[key] !== undefined &&
      record[key] !== null &&
      record[key] !== ""
    ) {
      return String(record[key]).trim();
    }
  }

  // Check first column
  const firstKey = Object.keys(record)[0];
  if (firstKey && record[firstKey]) {
    const value = String(record[firstKey]).trim();
    if (value.includes("@")) {
      return value;
    }
  }

  // Check all values
  for (const key in record) {
    const value = String(record[key]).trim();
    if (value.includes("@") && value.includes(".")) {
      return value;
    }
  }

  return null;
};

// Find name field in record
const findNameField = (record) => {
  if (!record) return null;

  const possibleNameFields = [
    "name",
    "fullname",
    "full_name",
    "firstname",
    "first_name",
    "lastname",
    "last_name",
    "username",
    "displayname",
    "contactname",
    "personname",
  ];

  for (const field of possibleNameFields) {
    if (
      record[field] !== undefined &&
      record[field] !== null &&
      record[field] !== ""
    ) {
      return String(record[field]).trim();
    }
  }

  // Check if any key contains "name"
  for (const key in record) {
    if (
      key.toLowerCase().includes("name") &&
      record[key] !== undefined &&
      record[key] !== null &&
      record[key] !== ""
    ) {
      return String(record[key]).trim();
    }
  }

  return null;
};

// Async processing function
const processUploadedFile = async (batchId, userId) => {
  let batch;
  try {
    batch = await ListUploadBatch.findByPk(batchId);
    if (!batch) {
      console.error(`Batch ${batchId} not found`);
      return;
    }

    console.log(`🔄 Processing batch ${batchId}: ${batch.originalFilename}`);

    // Check if file exists
    if (!fs.existsSync(batch.storagePath)) {
      throw new Error(`File not found: ${batch.storagePath}`);
    }

    await batch.update({ status: "parsing" });

    let records = [];
    switch (batch.fileType) {
      case "csv":
        console.log("📊 Parsing CSV file");
        records = await parseCSV(batch.storagePath);
        break;
      case "xlsx":
        console.log("📊 Parsing Excel file");
        records = await parseXLSX(batch.storagePath);
        break;
      case "txt":
        console.log("📊 Parsing text file");
        records = await parseTXT(batch.storagePath);
        break;
      default:
        throw new Error(`Unsupported file type: ${batch.fileType}`);
    }

    console.log(`✅ Parsed ${records.length} records from file`);

    // Process records
    await processRecords(batch, records);

    // Enqueue email verification
    console.log(`📨 Enqueuing email verification for batch ${batch.id}...`);
    await enqueueEmailVerification(batch.id);
    console.log(`✅ Email verification enqueued for batch ${batch.id}`);
  } catch (error) {
    console.error(`❌ Processing error for batch ${batchId}:`, error);

    if (batch) {
      await batch.update({
        status: "failed",
        errorReason: error.message,
      });
    }

    // Clean up file
    try {
      if (batch?.storagePath && fs.existsSync(batch.storagePath)) {
        fs.unlinkSync(batch.storagePath);
        console.log(`🧹 Cleaned up file: ${batch.storagePath}`);
      }
    } catch (cleanupError) {
      console.error("Failed to clean up file:", cleanupError);
    }
  }
};

// Process and deduplicate records
// Process and deduplicate records
const processRecords = async (batch, records) => {
  console.log(`🔄 Processing ${records.length} records for batch ${batch.id}`);

  const batchRecords = [];
  const normalizedToRaw = new Map();
  const validRecordsData = [];

  // Step 1: Pre-process and validate
  for (const record of records) {
    try {
      const emailValue = findEmailField(record);
      if (!emailValue || !isValidEmail(emailValue)) continue;

      const normalizedEmail = normalizeEmail(emailValue);
      if (!normalizedEmail) continue;

      const domain = extractDomain(normalizedEmail);
      if (!domain) continue;

      const name = findNameField(record);

      // Clean metadata
      const metadata = { ...record };
      Object.keys(metadata).forEach((key) => {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes("email") || lowerKey.includes("name")) {
          delete metadata[key];
        }
      });

      validRecordsData.push({
        emailValue,
        normalizedEmail,
        domain,
        name,
        metadata,
        originalRecord: record,
      });

      if (!normalizedToRaw.has(normalizedEmail)) {
        normalizedToRaw.set(normalizedEmail, { domain });
      }
    } catch (err) {
      // Logic for invalid records can stay as is or be simplified
    }
  }

  // Step 2: Bulk Registry Lookup
  const uniqueEmails = Array.from(normalizedToRaw.keys());
  const existingRegistryEntries = await GlobalEmailRegistry.findAll({
    where: { normalizedEmail: uniqueEmails },
    attributes: ["normalizedEmail", "id"],
  });

  const existingEmailSet = new Set(
    existingRegistryEntries.map((e) => e.normalizedEmail),
  );

  // Step 3: Map results to batch records
  let validCount = 0;
  let duplicateCount = 0;
  let failedCount = 0;

  for (const data of validRecordsData) {
    const isNew = !existingEmailSet.has(data.normalizedEmail);
    if (isNew) {
      validCount++;
    } else {
      duplicateCount++;
    }

    batchRecords.push({
      batchId: batch.id,
      rawEmail: data.emailValue,
      normalizedEmail: data.normalizedEmail,
      domain: data.domain,
      name: data.name || null,
      metadata: Object.keys(data.metadata).length > 0 ? data.metadata : null,
      status: isNew ? "parsed" : "duplicate",
      failureReason: null,
    });
  }

  // Step 4: Bulk Registry Upsert (Simplified)
  const registryToCreate = uniqueEmails
    .filter((email) => !existingEmailSet.has(email))
    .map((email) => ({
      normalizedEmail: email,
      domain: normalizedToRaw.get(email).domain,
      emailProvider: getEmailProvider(normalizedToRaw.get(email).domain),
      firstSeenAt: new Date(),
      lastSeenAt: new Date(),
    }));

  if (registryToCreate.length > 0) {
    await GlobalEmailRegistry.bulkCreate(registryToCreate, {
      ignoreDuplicates: true,
    });
  }

  // Bulk update lastSeenAt for existing (Optional but good for tracking)
  if (existingEmailSet.size > 0) {
    await GlobalEmailRegistry.update(
      { lastSeenAt: new Date() },
      { where: { normalizedEmail: Array.from(existingEmailSet) } },
    );
  }

  // Step 5: Bulk Insert Batch Records
  if (batchRecords.length > 0) {
    const CHUNK_SIZE = 1000;
    for (let i = 0; i < batchRecords.length; i += CHUNK_SIZE) {
      const chunk = batchRecords.slice(i, i + CHUNK_SIZE);
      await ListUploadRecord.bulkCreate(chunk, { ignoreDuplicates: true });
    }
  }

  // Update batch statistics
  await batch.update({
    status: "completed",
    totalRecords: records.length,
    validRecords: validCount,
    duplicateRecords: duplicateCount,
    failedRecords: failedCount,
    processedAt: new Date(),
  });

  console.log(`✅ Processing complete for batch ${batch.id}`);

  // Clean up
  if (batch.storagePath && fs.existsSync(batch.storagePath)) {
    fs.unlinkSync(batch.storagePath);
  }
};

export const getBatchVerificationStats = async (batchId) => {
  try {
    const rows = await ListUploadRecord.findAll({
      where: {
        batchId,
        normalizedEmail: { [Op.ne]: null },
      },
      include: [
        {
          model: GlobalEmailRegistry,
          required: false,
          attributes: [],
        },
      ],
      attributes: [
        [
          fn(
            "SUM",
            literal(
              `CASE WHEN "GlobalEmailRegistry"."verificationStatus" = 'valid' THEN 1 ELSE 0 END`,
            ),
          ),
          "validCount",
        ],
        [
          fn(
            "SUM",
            literal(
              `CASE WHEN "GlobalEmailRegistry"."verificationStatus" = 'invalid' THEN 1 ELSE 0 END`,
            ),
          ),
          "invalidCount",
        ],
        [
          fn(
            "SUM",
            literal(
              `CASE WHEN "GlobalEmailRegistry"."verificationStatus" = 'risky' THEN 1 ELSE 0 END`,
            ),
          ),
          "riskyCount",
        ],
        [
          fn(
            "SUM",
            literal(
              `CASE 
                WHEN "GlobalEmailRegistry"."verificationStatus" IS NULL
                OR "GlobalEmailRegistry"."verificationStatus" IN ('unknown','verifying')
                THEN 1 ELSE 0 END`,
            ),
          ),
          "unverifiedCount",
        ],
      ],
      raw: true,
    });

    return {
      valid: Number(rows[0]?.validCount || 0),
      invalid: Number(rows[0]?.invalidCount || 0),
      risky: Number(rows[0]?.riskyCount || 0),
      unverified: Number(rows[0]?.unverifiedCount || 0),
    };
  } catch (error) {
    console.error(
      `Error getting verification stats for batch ${batchId}:`,
      error,
    );
    return {
      valid: 0,
      invalid: 0,
      risky: 0,
      unverified: 0,
    };
  }
};

// Get batch status with verification results
export const getBatchStatus = asyncHandler(async (req, res) => {
  const batch = await ListUploadBatch.findOne({
    where: {
      id: req.params.batchId,
      userId: req.user.id,
    },
  });

  if (!batch) {
    return res.status(404).json({
      success: false,
      message: "Batch not found",
    });
  }

  // Get verification stats
  const verificationStats = await getBatchVerificationStats(batch.id);

  // Get record counts
  const counts = await ListUploadRecord.findAll({
    attributes: [
      "status",
      [sequelize.fn("COUNT", sequelize.col("id")), "count"],
    ],
    where: { batchId: batch.id },
    group: ["status"],
  });

  const countsMap = {};
  counts.forEach((item) => {
    countsMap[item.status] = parseInt(item.dataValues.count);
  });

  // In getBatchStatus function, replace the sampleRecords query:
  const sampleRecords = await ListUploadRecord.findAll({
    where: { batchId: batch.id },
    include: [
      {
        model: GlobalEmailRegistry,
        attributes: [
          "verificationStatus",
          "verifiedAt", // Changed from lastVerifiedAt
          "verificationMeta", // Use verificationMeta instead of reason
        ],
      },
    ],
    attributes: [
      "id",
      "status",
      "rawEmail",
      "normalizedEmail",
      "name",
      "failureReason",
      "createdAt",
    ],
    order: [["createdAt", "DESC"]],
    limit: 10,
  });

  // 🚀 OPTIMIZATION: Paginated verified records
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 500);
  const offset = (page - 1) * limit;

  const { count: totalVerified, rows: allVerifiedRecords } =
    await ListUploadRecord.findAndCountAll({
      where: {
        batchId: batch.id,
        normalizedEmail: { [Op.ne]: null },
      },
      include: [
        {
          model: GlobalEmailRegistry,
          attributes: ["verificationStatus", "verifiedAt", "verificationMeta"],
        },
      ],
      attributes: [
        "id",
        "status",
        "rawEmail",
        "normalizedEmail",
        "name",
        "failureReason",
        "createdAt",
      ],
      order: [["createdAt", "DESC"]],
      limit,
      offset,
    });

  // Update the mapped records to use correct field names:
  const mappedSampleRecords = sampleRecords.map((record) => ({
    id: record.id,
    status: record.status,
    email: record.normalizedEmail || record.rawEmail,
    name: record.name,
    failureReason: record.failureReason,
    verificationStatus: record.GlobalEmailRegistry?.verificationStatus,
    verifiedAt: record.GlobalEmailRegistry?.verifiedAt, // Changed from lastVerifiedAt
    verificationReason: record.GlobalEmailRegistry?.verificationMeta, // Changed from reason
    createdAt: record.createdAt,
  }));

  // Update the mappedAllRecords similarly:
  const mappedAllRecords = allVerifiedRecords.map((record) => ({
    id: record.id,
    status: record.status,
    email: record.normalizedEmail || record.rawEmail,
    name: record.name,
    failureReason: record.failureReason,
    verificationStatus: record.GlobalEmailRegistry?.verificationStatus,
    verifiedAt: record.GlobalEmailRegistry?.verifiedAt,
    verificationReason: record.GlobalEmailRegistry?.verificationMeta,
    createdAt: record.createdAt,
  }));

  const verificationBreakdown = await ListUploadRecord.findAll({
    where: {
      batchId: batch.id,
      normalizedEmail: { [Op.ne]: null },
    },
    include: [
      {
        model: GlobalEmailRegistry,
        required: false,
        attributes: [],
      },
    ],
    attributes: [
      [
        literal(
          `COALESCE("GlobalEmailRegistry"."verificationStatus", 'unknown')`,
        ),
        "verificationStatus",
      ],
      [sequelize.fn("COUNT", sequelize.col("ListUploadRecord.id")), "count"],
    ],
    group: [
      literal(
        `COALESCE("GlobalEmailRegistry"."verificationStatus", 'unknown')`,
      ),
    ],
    raw: true,
  });

  const verificationBreakdownMap = {};
  verificationBreakdown.forEach((item) => {
    verificationBreakdownMap[item.verificationStatus] = parseInt(item.count);
  });

  res.json({
    success: true,
    data: {
      batch: {
        id: batch.id,
        originalFilename: batch.originalFilename,
        fileType: batch.fileType,
        status: batch.status,
        totalRecords: batch.totalRecords,
        validRecords: batch.validRecords,
        duplicateRecords: batch.duplicateRecords,
        failedRecords: batch.failedRecords,
        checksum: batch.checksum,
        errorReason: batch.errorReason,
        createdAt: batch.createdAt,
        updatedAt: batch.updatedAt,
      },
      counts: countsMap,
      verification: verificationStats,
      verificationBreakdown: verificationBreakdownMap,
      sampleRecords: mappedSampleRecords,
      allRecords: mappedAllRecords,
      pagination: {
        total: totalVerified,
        page,
        limit,
        pages: Math.ceil(totalVerified / limit),
      },
    },
  });
});
// Get user's batches
export const getUserBatches = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  const { count, rows: batches } = await ListUploadBatch.findAndCountAll({
    where: { userId: req.user.id },
    order: [["createdAt", "DESC"]],
    limit,
    offset,
    attributes: [
      "id",
      "originalFilename",
      "fileType",
      "status",
      "totalRecords",
      "validRecords",
      "duplicateRecords",
      "failedRecords",
      "createdAt",
      "updatedAt",
    ],
  });

  // 🔹 Add verification stats per batch
  const enrichedBatches = await Promise.all(
    batches.map(async (batch) => {
      const verification = await getBatchVerificationStats(batch.id);

      return {
        ...batch.toJSON(),
        verification, // ✅ verified / invalid / unverified
      };
    }),
  );

  res.status(200).json({
    success: true,
    data: enrichedBatches,
    pagination: {
      page,
      limit,
      total: count,
      pages: Math.ceil(count / limit),
    },
  });
});

// Delete batch
export const deleteBatch = asyncHandler(async (req, res) => {
  const batch = await ListUploadBatch.findOne({
    where: {
      id: req.params.batchId,
      userId: req.user.id,
    },
  });

  if (!batch) {
    return res.status(404).json({
      success: false,
      message: "Batch not found",
    });
  }

  // Delete associated records
  await ListUploadRecord.destroy({
    where: { batchId: batch.id },
  });

  // Delete batch
  await batch.destroy();

  res.json({
    success: true,
    message: "Batch deleted successfully",
  });
});

// Retry batch
export const retryBatch = asyncHandler(async (req, res) => {
  const batch = await ListUploadBatch.findOne({
    where: {
      id: req.params.batchId,
      userId: req.user.id,
      status: "failed",
    },
  });

  if (!batch) {
    return res.status(404).json({
      success: false,
      message: "Failed batch not found",
    });
  }

  // Reset batch status
  await batch.update({
    status: "uploaded",
    errorReason: null,
  });

  // Reprocess the file
  await processUploadedFile(batch.id, req.user.id);

  res.json({
    success: true,
    message: "Batch retry initiated",
  });
});

// Export batch
export const exportBatch = asyncHandler(async (req, res) => {
  const { format = "csv" } = req.query;
  const batchId = req.params.batchId;

  const batch = await ListUploadBatch.findOne({
    where: {
      id: batchId,
      userId: req.user.id,
    },
  });

  if (!batch) {
    return res.status(404).json({
      success: false,
      message: "Batch not found",
    });
  }

  const records = await ListUploadRecord.findAll({
    where: { batchId },
    attributes: ["normalizedEmail", "name", "status", "createdAt"],
  });

  // Convert to requested format
  let content, contentType, extension;

  switch (format.toLowerCase()) {
    case "csv":
      content = convertToCSV(records);
      contentType = "text/csv";
      extension = "csv";
      break;
    case "json":
      content = JSON.stringify(records, null, 2);
      contentType = "application/json";
      extension = "json";
      break;
    case "xlsx":
      content = convertToXLSX(records);
      contentType =
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      extension = "xlsx";
      break;
    default:
      return res.status(400).json({
        success: false,
        message: "Unsupported export format",
      });
  }

  res.setHeader("Content-Type", contentType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename=batch-${batchId}.${extension}`,
  );
  res.send(content);
});
