import { asyncHandler } from "../helpers/async-handler.js";
import AppError from "../utils/app-error.js";
import xlsx from "xlsx";
import { promises as fsPromises } from "fs";

import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";

import { testGmailConnection } from "../utils/gmail-tester.js";
import { testOutlookConnection } from "../utils/outlook-tester.js";

import { verifySmtp, verifyImap } from "../services/smtp-imap.service.js";
import pLimit from "p-limit";

// =========================
// CREATE SMTP SENDER
// =========================
export const createSender = asyncHandler(async (req, res) => {
  const {
    email,
    displayName,

    /* SMTP */
    smtpHost,
    smtpPort = 587,
    smtpSecure = true,
    smtpUser,
    smtpPassword,

    /* IMAP */
    imapHost,
    imapPort = 993,
    imapSecure = true,
    imapUser,
    imapPassword,

    /* Optional */
    provider = "custom", // e.g., aws, sendgrid, mailgun, custom
    dailyLimit = 500,
    hourlyLimit = 100,
  } = req.body;

  // Validation
  if (!email || !displayName) {
    throw new AppError("Email and display name are required", 400);
  }

  if (!smtpHost || !smtpPort || !smtpUser || !smtpPassword) {
    throw new AppError("Incomplete SMTP configuration", 400);
  }

  if (!imapHost || !imapPort || !imapUser || !imapPassword) {
    throw new AppError("Incomplete IMAP configuration", 400);
  }

  // Check if email already exists in any sender type
  const [existingGmail, existingOutlook, existingSmtp] = await Promise.all([
    GmailSender.findOne({
      where: { email: email.toLowerCase(), userId: req.user.id },
    }),
    OutlookSender.findOne({
      where: { email: email.toLowerCase(), userId: req.user.id },
    }),
    SmtpSender.findOne({
      where: { email: email.toLowerCase(), userId: req.user.id },
    }),
  ]);

  if (existingGmail || existingOutlook || existingSmtp) {
    throw new AppError("Sender with this email already exists", 409);
  }

  // Test SMTP connection
  try {
    await verifySmtp({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      user: smtpUser,
      password: smtpPassword,
    });
  } catch (err) {
    throw new AppError(`SMTP connection failed: ${err.message}`, 400);
  }

  // Test IMAP connection
  try {
    await verifyImap({
      host: imapHost,
      port: imapPort,
      secure: imapSecure,
      user: imapUser,
      password: imapPassword,
    });
  } catch (err) {
    throw new AppError(`IMAP connection failed: ${err.message}`, 400);
  }

  // Create SMTP sender
  const sender = await SmtpSender.create({
    userId: req.user.id,
    email: email.toLowerCase(),
    displayName,
    domain: email.split("@")[1],

    // SMTP settings
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUsername: smtpUser,
    smtpPassword: smtpPassword,

    // IMAP settings
    imapHost,
    imapPort,
    imapSecure,
    imapUsername: imapUser,
    imapPassword: imapPassword,

    // Additional settings
    provider,
    dailyLimit,
    hourlyLimit,

    // Test results
    smtpTestResult: { success: true, testedAt: new Date() },
    imapTestResult: { success: true, testedAt: new Date() },
    lastTestedAt: new Date(),

    // State
    isVerified: true,
    isActive: true,
  });

  res.status(201).json({
    success: true,
    data: {
      ...sender.toJSON(),
      type: "smtp",
    },
  });
});

// =========================
// BULK UPLOAD SMTP SENDERS FROM XLSX
// =========================
export const bulkUploadSenders = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new AppError("Please upload an XLSX file", 400);
  }

  const filePath = req.file.path;
  let data;
  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    data = xlsx.utils.sheet_to_json(sheet);
  } catch (parseError) {
    // Cleanup file if parsing fails
    await fsPromises.unlink(filePath).catch(() => {});
    throw new AppError(`Failed to parse Excel file: ${parseError.message}`, 400);
  }

  if (!data || data.length === 0) {
    await fsPromises.unlink(filePath).catch(() => {});
    throw new AppError("The uploaded sheet is empty", 400);
  }

  const userId = req.user.id;
  const results = {
    total: data.length,
    success: 0,
    failed: 0,
    errors: [],
  };

  const sendersToCreate = [];

  for (const [index, row] of data.entries()) {
    try {
      // Clean row keys (handle variations in naming/spacing)
      const cleanRow = {};
      Object.keys(row).forEach((key) => {
        cleanRow[key.trim().toLowerCase()] = row[key];
      });

      const {
        first_name,
        last_name,
        email,
        domain,
        password,
        type,
      } = cleanRow;

      // Extract values allowing for common variations in header names
      const emailVal = email || cleanRow.email_address || cleanRow.user_email;
      const domainVal = domain || cleanRow.site_domain;
      const passVal = password || cleanRow.pass || cleanRow.smtp_password;
      const typeVal = type || cleanRow.sender_type || cleanRow.account_type;

      if (!emailVal || !domainVal || !passVal || !typeVal) {
        throw new Error(
          `Row ${index + 1}: Missing required fields (email, domain, password, type)`
        );
      }

      const emailLower = emailVal.toString().trim().toLowerCase();
      const domainLower = domainVal.toString().trim().toLowerCase();
      const typeLower = typeVal.toString().trim().toLowerCase();
      const displayName = `${first_name || ""} ${last_name || ""}`.trim() || emailLower.split("@")[0];

      let smtpHost, imapHost;
      if (typeLower === "aapanel") {
        smtpHost = `mail.${domainLower}`;
        imapHost = `mail.${domainLower}`;
      } else if (typeLower === "postal") {
        smtpHost = `smtp.${domainLower}`;
        imapHost = `imap.${domainLower}`;
      } else {
        throw new Error(`Row ${index + 1}: Unsupported type "${typeVal}"`);
      }

      sendersToCreate.push({
        userId,
        email: emailLower,
        displayName,
        domain: domainLower,
        smtpHost,
        smtpPort: 465,
        smtpSecure: true,
        smtpUsername: emailLower,
        smtpPassword: passVal.toString(),
        imapHost,
        imapPort: 993,
        imapSecure: true,
        imapUsername: emailLower,
        imapPassword: passVal.toString(),
        provider: typeLower,
        isActive: true,
      });
      results.success++;
    } catch (err) {
      results.failed++;
      results.errors.push(err.message);
    }
  }

  if (sendersToCreate.length > 0) {
    // Check for duplicates in the database
    const emails = sendersToCreate.map((s) => s.email);
    const existing = await SmtpSender.findAll({
      where: {
        email: emails,
        userId,
      },
      attributes: ["email"],
    });

    const existingSet = new Set(existing.map((e) => e.email.toLowerCase()));
    
    // Check for duplicates within the uploaded file itself
    const seenInFile = new Set();
    
    const finalBatch = [];
    for (const sender of sendersToCreate) {
      if (existingSet.has(sender.email)) {
        results.success--;
        results.failed++;
        results.errors.push(`Row for ${sender.email}: Already exists in your account.`);
      } else if (seenInFile.has(sender.email)) {
        results.success--;
        results.failed++;
        results.errors.push(`Row for ${sender.email}: Duplicate entry in the Excel sheet.`);
      } else {
        seenInFile.add(sender.email);
        finalBatch.push(sender);
      }
    }

    if (finalBatch.length > 0) {
      // Perform SMTP and IMAP handshakes for the batch
      const limit = pLimit(5); // Concurrency limit of 5
      
      const verificationPromises = finalBatch.map((sender) => 
        limit(async () => {
          try {
            // Test SMTP
            await verifySmtp({
              host: sender.smtpHost,
              port: sender.smtpPort,
              secure: sender.smtpSecure,
              user: sender.smtpUsername,
              password: sender.smtpPassword,
            });

            // Test IMAP
            await verifyImap({
              host: sender.imapHost,
              port: sender.imapPort,
              secure: sender.imapSecure,
              user: sender.imapUsername,
              password: sender.imapPassword,
            });

            sender.isVerified = true;
            sender.smtpTestResult = { success: true, testedAt: new Date() };
            sender.imapTestResult = { success: true, testedAt: new Date() };
            sender.lastTestedAt = new Date();
          } catch (err) {
            sender.isVerified = false;
            sender.verificationError = err.message;
            sender.smtpTestResult = { success: false, error: err.message };
            sender.imapTestResult = { success: false, error: err.message };
            sender.lastTestedAt = new Date();
          }
        })
      );

      await Promise.all(verificationPromises);
      
      const verifiedBatch = finalBatch.filter((s) => s.isVerified);
      const failedInVerification = finalBatch.filter((s) => !s.isVerified);

      // Adjust counts for verification failures
      results.success -= failedInVerification.length;
      results.failed += failedInVerification.length;
      
      failedInVerification.forEach((s) => {
        results.errors.push(`${s.email}: Authentication failed (${s.verificationError})`);
      });

      if (verifiedBatch.length > 0) {
        await SmtpSender.bulkCreate(verifiedBatch);
      }
    }
  }

  // Cleanup temporary file
  await fsPromises.unlink(filePath).catch((err) => {
    console.error("Failed to delete temp upload file:", err);
  });

  res.json({
    success: true,
    message: `Batch processing complete. ${results.success} senders added, ${results.failed} errors.`,
    data: {
      successCount: results.success,
      failedCount: results.failed,
      errors: results.errors.slice(0, 50), // Return first 50 errors
      totalRows: results.total,
    },
  });
});

// =========================
// LIST ALL SENDERS
// =========================

// =========================
export const listSenders = asyncHandler(async (req, res) => {
  try {
    const userId = req.user.id;

    const [smtpSenders, gmailSenders, outlookSenders] = await Promise.all([
      SmtpSender.findAll({
        where: { userId },
        attributes: { exclude: ["smtpPassword", "imapPassword"] },
        paranoid: false,
      }),
      GmailSender.findAll({
        where: { userId },
        attributes: {
          exclude: ["accessToken", "refreshToken", "googleProfile"],
        },
        paranoid: false,
      }),
      OutlookSender.findAll({
        where: { userId },
        attributes: { exclude: ["accessToken", "refreshToken"] },
        paranoid: false,
      }),
    ]);

    const allSenders = [
      ...smtpSenders.map((sender) => ({
        id: sender.id,
        type: "smtp", // ✅ Include type
        email: sender.email,
        displayName: sender.displayName,
        isVerified: sender.isVerified,
        createdAt: sender.createdAt,
        lastUsedAt: sender.lastUsedAt,
        smtpHost: sender.smtpHost,
        smtpPort: sender.smtpPort,
        domain: sender.domain,
      })),
      ...gmailSenders.map((sender) => ({
        id: sender.id,
        type: "gmail", // ✅ Include type
        email: sender.email,
        displayName: sender.displayName,
        isVerified: sender.isVerified,
        createdAt: sender.createdAt,
        lastUsedAt: sender.lastUsedAt,
        googleId: sender.googleId,
        domain: sender.domain,
        expiresAt: sender.expiresAt,
        picture: sender.picture,
      })),
      ...outlookSenders.map((sender) => ({
        id: sender.id,
        type: "outlook", // ✅ Include type
        email: sender.email,
        displayName: sender.displayName,
        isVerified: sender.isVerified,
        createdAt: sender.createdAt,
        lastUsedAt: sender.lastUsedAt,
        microsoftId: sender.microsoftId,
        domain: sender.domain,
        expiresAt: sender.expiresAt,
      })),
    ];

    allSenders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    const totalCount = allSenders.length;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const offset = (page - 1) * limit;
    const paginatedSenders = allSenders.slice(offset, offset + limit);

    res.json({
      success: true,
      data: paginatedSenders,
      count: paginatedSenders.length,
      pagination: {
        total: totalCount,
        page,
        limit,
        pages: Math.ceil(totalCount / limit),
      },
      countsByType: {
        smtp: smtpSenders.length,
        gmail: gmailSenders.length,
        outlook: outlookSenders.length,
      },
    });
  } catch (error) {
    console.error("Error listing senders:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch senders",
      error: error.message,
    });
  }
});
// =========================
// BULK DELETE SENDERS
// =========================
export const bulkDeleteSenders = asyncHandler(async (req, res) => {
  const { senderIds } = req.body; // Array of { id, type }
  const userId = req.user.id;

  if (!senderIds || !Array.isArray(senderIds)) {
    throw new AppError("senderIds array is required", 400);
  }

  const results = {
    success: 0,
    failed: 0,
    errors: [],
  };

  for (const item of senderIds) {
    const { id, type } = item;
    try {
      let model;
      if (type === "gmail") model = GmailSender;
      else if (type === "outlook") model = OutlookSender;
      else if (type === "smtp") model = SmtpSender;
      else throw new Error(`Invalid type: ${type}`);

      const sender = await model.findOne({ where: { id, userId } });
      if (sender) {
        await sender.destroy({ force: true });
        results.success++;
      } else {
        results.failed++;
        results.errors.push(`Sender ${id} of type ${type} not found`);
      }
    } catch (err) {
      results.failed++;
      results.errors.push(`Failed to delete ${id}: ${err.message}`);
    }
  }

  res.json({
    success: true,
    message: `Batch delete complete. ${results.success} deleted, ${results.failed} failed.`,
    data: results,
  });
});

// =========================
// DELETE SENDER - FORCE DELETE
// =========================
export const deleteSender = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const { type } = req.query;
  const userId = req.user.id;

  let deleted = false;
  let deletedType = null;

  if (type === "outlook") {
    // 🔴 Find including soft-deleted
    const sender = await OutlookSender.findOne({
      where: {
        id: senderId,
        userId,
      },
      paranoid: false,
    });

    if (sender) {
      // 🔴 FORCE DELETE - completely remove from database
      await sender.destroy({ force: true });
      deleted = true;
      deletedType = "outlook";
      console.log(`✅ Outlook sender permanently deleted: ${sender.email}`);
    }
  }

  if (!deleted) {
    throw new AppError("Sender not found", 404);
  }

  res.json({
    success: true,
    message: `${deletedType} sender deleted successfully`,
  });
});
// =========================
// TEST SENDER CONNECTION
// =========================
export const testSender = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;

  // Try to find sender in each model
  const [gmailSender, outlookSender, smtpSender] = await Promise.all([
    GmailSender.findOne({ where: { id: senderId, userId } }),
    OutlookSender.findOne({ where: { id: senderId, userId } }),
    SmtpSender.findOne({ where: { id: senderId, userId } }),
  ]);

  let sender = gmailSender || outlookSender || smtpSender;
  if (!sender) {
    throw new AppError("Sender not found", 404);
  }

  let testResult = {};

  // Test based on sender type
  if (gmailSender) {
    try {
      testResult = await testGmailConnection({
        accessToken: sender.accessToken,
        email: sender.email,
      });
      await gmailSender.update({
        isVerified: true,
        lastTestedAt: new Date(),
      });
    } catch (err) {
      testResult = { success: false, error: err.message };
      await gmailSender.update({
        isVerified: false,
        verificationError: err.message,
        lastTestedAt: new Date(),
      });
    }
  } else if (outlookSender) {
    try {
      testResult = await testOutlookConnection({
        accessToken: sender.accessToken,
        email: sender.email,
      });
      await outlookSender.update({
        isVerified: true,
        lastTestedAt: new Date(),
      });
    } catch (err) {
      testResult = { success: false, error: err.message };
      await outlookSender.update({
        isVerified: false,
        verificationError: err.message,
        lastTestedAt: new Date(),
      });
    }
  } else if (smtpSender) {
    try {
      // Test SMTP
      const smtpTest = await testSmtpConnection({
        smtpHost: sender.smtpHost,
        smtpPort: sender.smtpPort,
        smtpSecure: sender.smtpSecure,
        smtpUser: sender.smtpUsername,
        smtpPass: sender.smtpPassword,
      });

      // Test IMAP if configured
      let imapTest = null;
      if (sender.imapHost && sender.imapUsername && sender.imapPassword) {
        imapTest = await testImapConnection({
          imapHost: sender.imapHost,
          imapPort: sender.imapPort,
          imapSecure: sender.imapSecure,
          imapUser: sender.imapUsername,
          imapPass: sender.imapPassword,
        });
      }

      testResult = {
        success: true,
        smtp: smtpTest,
        imap: imapTest,
      };

      await smtpSender.update({
        isVerified: true,
        smtpTestResult: smtpTest,
        imapTestResult: imapTest,
        lastTestedAt: new Date(),
        verificationError: null,
      });
    } catch (err) {
      testResult = { success: false, error: err.message };
      await smtpSender.update({
        isVerified: false,
        verificationError: err.message,
        lastTestedAt: new Date(),
      });
    }
  }

  res.json({
    success: true,
    data: {
      senderId,
      type: gmailSender ? "gmail" : outlookSender ? "outlook" : "smtp",
      testResult,
    },
  });
});

// =========================
// REFRESH OAUTH TOKEN
// =========================
export const refreshSenderToken = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;

  // Only applicable to OAuth senders
  const [gmailSender, outlookSender] = await Promise.all([
    GmailSender.findOne({ where: { id: senderId, userId } }),
    OutlookSender.findOne({ where: { id: senderId, userId } }),
  ]);

  const sender = gmailSender || outlookSender;
  if (!sender) {
    throw new AppError("OAuth sender not found", 404);
  }

  // In a real implementation, you would call Google/Microsoft API
  // to refresh the token using the refresh token
  // This is a simplified version
  res.json({
    success: true,
    message: "Token refresh initiated",
    data: {
      senderId,
      type: gmailSender ? "gmail" : "outlook",
      refreshed: true,
    },
  });
});

// =========================
// REVOKE OAUTH ACCESS
// =========================
export const revokeSenderAccess = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;

  // Only applicable to OAuth senders
  const [gmailSender, outlookSender] = await Promise.all([
    GmailSender.findOne({ where: { id: senderId, userId } }),
    OutlookSender.findOne({ where: { id: senderId, userId } }),
  ]);

  const sender = gmailSender || outlookSender;
  if (!sender) {
    throw new AppError("OAuth sender not found", 404);
  }

  // In a real implementation, you would call Google/Microsoft API
  // to revoke the token
  // For now, just mark as not verified
  await sender.update({
    isVerified: false,
    accessToken: null,
    refreshToken: null,
    expiresAt: null,
  });

  res.json({
    success: true,
    message: "Access revoked successfully",
    data: {
      senderId,
      type: gmailSender ? "gmail" : "outlook",
      revoked: true,
    },
  });
});

// =========================
// UPDATE SMTP SENDER
// =========================
export const updateSender = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;
  const updateData = req.body;

  // Only SMTP senders can be updated via API
  const smtpSender = await SmtpSender.findOne({
    where: {
      id: senderId,
      userId: userId,
    },
  });

  if (!smtpSender) {
    throw new AppError("SMTP sender not found", 404);
  }

  // Don't allow changing email
  if (updateData.email && updateData.email !== smtpSender.email) {
    throw new AppError("Email cannot be changed", 400);
  }

  // If updating SMTP credentials, test connection
  if (updateData.smtpPassword || updateData.smtpHost || updateData.smtpPort) {
    try {
      await testSmtpConnection({
        smtpHost: updateData.smtpHost || smtpSender.smtpHost,
        smtpPort: updateData.smtpPort || smtpSender.smtpPort,
        smtpSecure:
          updateData.smtpSecure !== undefined
            ? updateData.smtpSecure
            : smtpSender.smtpSecure,
        smtpUser: updateData.smtpUser || smtpSender.smtpUsername,
        smtpPass: updateData.smtpPassword || smtpSender.smtpPassword,
      });
    } catch (err) {
      throw new AppError(`SMTP connection failed: ${err.message}`, 400);
    }
  }

  // Update sender
  await smtpSender.update(updateData);

  res.json({
    success: true,
    data: {
      ...smtpSender.toJSON(),
      type: "smtp",
    },
  });
});

// =========================
// GET SINGLE SENDER
// =========================
// =========================
// GET SINGLE SENDER - IMPROVED
// =========================
export const getSender = asyncHandler(async (req, res) => {
  const { senderId } = req.params;
  const userId = req.user.id;

  const [gmailSender, outlookSender, smtpSender] = await Promise.all([
    GmailSender.findOne({ where: { id: senderId, userId } }),
    OutlookSender.findOne({ where: { id: senderId, userId } }),
    SmtpSender.findOne({ where: { id: senderId, userId } }),
  ]);

  const sender = gmailSender || outlookSender || smtpSender;
  if (!sender) {
    throw new AppError("Sender not found", 404);
  }

  let type;
  let senderData;

  if (gmailSender) {
    type = "gmail";
    senderData = gmailSender.toJSON();
    delete senderData.accessToken;
    delete senderData.refreshToken;
    delete senderData.googleProfile;
  } else if (outlookSender) {
    type = "outlook";
    senderData = outlookSender.toJSON();
    delete senderData.accessToken;
    delete senderData.refreshToken;
  } else {
    type = "smtp";
    senderData = smtpSender.toJSON();
    delete senderData.smtpPassword;
    delete senderData.imapPassword;
  }

  res.json({
    success: true,
    data: {
      ...senderData,
      type,
    },
  });
});

// =========================
// TEST SMTP CONNECTION ONLY
// =========================
export const testSmtpConnection = asyncHandler(async (req, res) => {
  const { host, port, secure, user, password } = req.body || {};

  if (!host || !port || !user || !password) {
    throw new AppError("Missing required SMTP fields", 400);
  }

  await verifySmtp({ host, port, secure, user, password });

  res.json({
    success: true,
    message: "SMTP connection successful",
  });
});

// =========================
// TEST IMAP CONNECTION ONLY
// =========================
export const testImapConnection = asyncHandler(async (req, res) => {
  const { host, port, secure, user, password } = req.body || {};

  if (!host || !port || !user || !password) {
    throw new AppError("Missing required IMAP fields", 400);
  }

  await verifyImap({ host, port, secure, user, password });

  res.json({
    success: true,
    message: "IMAP connection successful",
  });
});
