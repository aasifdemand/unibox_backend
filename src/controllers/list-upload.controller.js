import crypto from "crypto";
import fs from "fs";
import csv from "csv-parser";
import XLSX from "xlsx";
import ListUploadBatch from "../models/list-upload-batch.model.js";
import ListUploadRecord from "../models/list-upload-record.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import { Op } from "sequelize";
import { asyncHandler } from "../helpers/async-handler.js";
import sequelize from "../config/db.js";
import { 
  normalizeEmail, 
  extractDomain, 
  isValidEmail,
  getEmailProvider 
} from "../utils/email-processor.js";

export const uploadList = async (req, res) => {
  const file = req.file;
  const userId = req.user.id;

  if (!file) {
    return res.status(400).json({ message: "File required" });
  }

  try {
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
        status: { [Op.ne]: "failed" }
      }
    });

    if (existingBatch) {
      fs.unlinkSync(file.path);
      return res.status(409).json({
        success: false,
        message: "Duplicate upload detected",
        batchId: existingBatch.id
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

    // Parse and process immediately (non-blocking via setTimeout)
    setTimeout(() => processUploadedFile(batch.id, userId), 0);

    return res.status(202).json({
      success: true,
      batchId: batch.id,
      status: "uploaded",
      message: "File accepted and processing started"
    });

  } catch (error) {
    if (file && file.path && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
    
    return res.status(500).json({
      success: false,
      message: "Upload failed",
      error: error.message
    });
  }
};

// Async processing function
const processUploadedFile = async (batchId, userId) => {
  const batch = await ListUploadBatch.findByPk(batchId);
  if (!batch) return;

  try {
    await batch.update({ status: "parsing" });
    
    // Parse file based on type
    let records = [];
    switch (batch.fileType) {
      case "csv":
        records = await parseCSV(batch.storagePath);
        break;
      case "xlsx":
        records = await parseXLSX(batch.storagePath);
        break;
      case "txt":
        records = await parseTXT(batch.storagePath);
        break;
      default:
        throw new Error(`Unsupported file type: ${batch.fileType}`);
    }

    console.log(`Parsed ${records.length} records from file`);
    
    if (records.length > 0) {
      console.log('Sample record:', records[0]);
    }

    // Process each record
    await processRecords(batch, records);

  } catch (error) {
    console.error('Processing error:', error);
    await batch.update({
      status: "failed",
      errorReason: error.message
    });
    
    // Clean up file if processing fails
    try {
      if (batch.storagePath && fs.existsSync(batch.storagePath)) {
        fs.unlinkSync(batch.storagePath);
      }
    } catch (cleanupError) {
      console.error('Failed to clean up file:', cleanupError);
    }
  }
};

// Parse CSV
const parseCSV = (filePath) => {
  return new Promise((resolve, reject) => {
    const records = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on("data", (row) => records.push(row))
      .on("end", () => resolve(records))
      .on("error", reject);
  });
};

// Parse Excel
const parseXLSX = (filePath) => {
  try {
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const records = XLSX.utils.sheet_to_json(worksheet);
    
    // Normalize header names (remove spaces, lowercase)
    return records.map(record => {
      const normalizedRecord = {};
      Object.keys(record).forEach(key => {
        if (record[key] !== undefined && record[key] !== null) {
          const normalizedKey = key.toString().toLowerCase().replace(/\s+/g, '');
          normalizedRecord[normalizedKey] = record[key];
        }
      });
      return normalizedRecord;
    });
  } catch (error) {
    console.error('Excel parsing error:', error);
    throw new Error(`Failed to parse Excel file: ${error.message}`);
  }
};

// Parse TXT (one email per line)
const parseTXT = (filePath) => {
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter(line => line.trim())
    .map(line => {
      const trimmed = line.trim();
      // Try to detect if line contains CSV-like data
      if (trimmed.includes(',') && !trimmed.includes('@')) {
        // Might be a CSV line, try to parse
        const parts = trimmed.split(',');
        if (parts.length > 1 && parts[0].includes('@')) {
          return { email: parts[0].trim() };
        }
      }
      return { email: trimmed };
    });
};

// Find email field in record (case-insensitive)
const findEmailField = (record) => {
  if (!record) return null;
  
  const possibleEmailFields = [
    'email', 'emailaddress', 'mail', 'e-mail', 'e_mail', 'emailid',
    'useremail', 'username', 'contactemail', 'primaryemail'
  ];
  
  // Check exact matches first
  for (const field of possibleEmailFields) {
    if (record[field] !== undefined && record[field] !== null && record[field] !== '') {
      return String(record[field]);
    }
  }
  
  // Check if any key contains "email"
  for (const key in record) {
    if (key.toLowerCase().includes('email') && 
        record[key] !== undefined && record[key] !== null && record[key] !== '') {
      return String(record[key]);
    }
  }
  
  // Check first column if no email field found
  const firstKey = Object.keys(record)[0];
  if (firstKey && record[firstKey]) {
    const value = String(record[firstKey]);
    if (value.includes('@')) {
      return value;
    }
  }
  
  // Check all values for email-like pattern
  for (const key in record) {
    const value = String(record[key]);
    if (value.includes('@') && value.includes('.')) {
      return value;
    }
  }
  
  return null;
};

// Find name field in record
const findNameField = (record) => {
  if (!record) return null;
  
  const possibleNameFields = [
    'name', 'fullname', 'full_name', 'fullname',
    'firstname', 'first_name', 'firstname',
    'lastname', 'last_name', 'lastname',
    'username', 'displayname', 'contactname', 'personname'
  ];
  
  // Check exact matches first
  for (const field of possibleNameFields) {
    if (record[field] !== undefined && record[field] !== null && record[field] !== '') {
      return String(record[field]);
    }
  }
  
  // Check if any key contains "name"
  for (const key in record) {
    if (key.toLowerCase().includes('name') && 
        record[key] !== undefined && record[key] !== null && record[key] !== '') {
      return String(record[key]);
    }
  }
  
  return null;
};

// Process and deduplicate records
const processRecords = async (batch, records) => {
  const batchRecords = [];
  let duplicateCount = 0;
  let validCount = 0;
  let failedCount = 0;

  console.log(`Processing ${records.length} records...`);

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    let emailValue = null;
    
    try {
      if (!record || typeof record !== 'object') {
        throw new Error(`Invalid record format at index ${i}`);
      }

      console.log(`Processing record ${i + 1}:`, Object.keys(record));
      
      // Find email field
      emailValue = findEmailField(record);
      if (!emailValue) {
        throw new Error(`No email field found. Available fields: ${Object.keys(record).join(', ')}`);
      }

      console.log(`Found email: ${emailValue}`);
      
      // Validate email format before normalization
      if (!isValidEmail(emailValue)) {
        throw new Error(`Invalid email format: ${emailValue}`);
      }
      
      // Normalize email
      const normalizedEmail = normalizeEmail(emailValue);
      if (!normalizedEmail) {
        throw new Error(`Could not normalize email: ${emailValue}`);
      }

      // Extract domain for additional checks
      const domain = extractDomain(normalizedEmail);
      if (!domain) {
        throw new Error(`Could not extract domain from: ${normalizedEmail}`);
      }

      // Check for duplicates in global registry
      const [globalRecord, created] = await GlobalEmailRegistry.findOrCreate({
        where: { normalizedEmail },
        defaults: {
          domain,
          emailProvider: getEmailProvider(domain),
          firstSeenAt: new Date(),
          lastSeenAt: new Date()
        }
      });

      // Update lastSeenAt for existing records
      if (!created) {
        await globalRecord.update({ 
          lastSeenAt: new Date(),
          emailProvider: getEmailProvider(domain) // Update provider if changed
        });
      }

      // Find name
      const name = findNameField(record);
      
      // Prepare metadata (exclude email and name fields)
      const metadata = { ...record };
      Object.keys(metadata).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('email') || lowerKey.includes('name')) {
          delete metadata[key];
        }
      });

      // Clean up metadata (remove undefined/null values)
      Object.keys(metadata).forEach(key => {
        if (metadata[key] === undefined || metadata[key] === null || metadata[key] === '') {
          delete metadata[key];
        }
      });

      // Prepare record for batch
      batchRecords.push({
        batchId: batch.id,
        rawEmail: emailValue,
        normalizedEmail,
        domain,
        name: name || null,
        metadata: Object.keys(metadata).length > 0 ? metadata : null,
        status: created ? "parsed" : "duplicate",
        failureReason: created ? null : "Duplicate in global registry",
        createdAt: new Date()
      });

      validCount++;
      if (!created) duplicateCount++;
      
      console.log(`Record ${i + 1} processed successfully: ${created ? 'New' : 'Duplicate'}`);

    } catch (error) {
      console.log(`Record ${i + 1} failed: ${error.message}`);
      batchRecords.push({
        batchId: batch.id,
        rawEmail: emailValue || JSON.stringify(record),
        normalizedEmail: null,
        domain: null,
        name: null,
        metadata: { 
          rawData: record, 
          error: error.message,
          availableFields: Object.keys(record || {})
        },
        status: "invalid",
        failureReason: error.message,
        createdAt: new Date()
      });
      failedCount++;
    }
  }

  // Bulk insert records
  if (batchRecords.length > 0) {
    try {
      await ListUploadRecord.bulkCreate(batchRecords, {
        validate: true,
        ignoreDuplicates: true
      });
      console.log(`Inserted ${batchRecords.length} records into database`);
    } catch (dbError) {
      console.error('Database insert error:', dbError);
      // Try inserting one by one
      for (const record of batchRecords) {
        try {
          await ListUploadRecord.create(record);
        } catch (singleError) {
          console.error('Failed to insert single record:', singleError);
        }
      }
    }
  }

  // Update batch statistics
  await batch.update({
    totalRecords: records.length,
    validRecords: validCount,
    duplicateRecords: duplicateCount,
    failedRecords: failedCount,
    status: "completed",
    updatedAt: new Date()
  });

  console.log(`Processing complete. Valid: ${validCount}, Duplicates: ${duplicateCount}, Failed: ${failedCount}`);
  
  // Clean up the uploaded file after processing
  try {
    if (batch.storagePath && fs.existsSync(batch.storagePath)) {
      fs.unlinkSync(batch.storagePath);
      console.log(`Cleaned up file: ${batch.storagePath}`);
    }
  } catch (cleanupError) {
    console.error('Failed to clean up file:', cleanupError);
  }
};

// Get batch status
export const getBatchStatus = asyncHandler(async (req, res) => {
  const batch = await ListUploadBatch.findOne({
    where: {
      id: req.params.batchId,
      userId: req.user.id
    }
  });

  if (!batch) {
    return res.status(404).json({ 
      success: false,
      message: "Batch not found" 
    });
  }

  // Get record counts by status
  const counts = await ListUploadRecord.findAll({
    attributes: [
      'status',
      [sequelize.fn('COUNT', sequelize.col('id')), 'count']
    ],
    where: { batchId: batch.id },
    group: ['status']
  });

  const countsMap = {};
  counts.forEach(item => {
    countsMap[item.status] = parseInt(item.dataValues.count);
  });

  // Get sample records
  const sampleRecords = await ListUploadRecord.findAll({
    where: { batchId: batch.id },
    attributes: ['id', 'status', 'normalizedEmail', 'name', 'failureReason', 'createdAt'],
    order: [['createdAt', 'DESC']],
    limit: 10
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
        updatedAt: batch.updatedAt
      },
      counts: countsMap,
      sampleRecords: sampleRecords.map(record => ({
        id: record.id,
        status: record.status,
        email: record.normalizedEmail,
        name: record.name,
        failureReason: record.failureReason,
        createdAt: record.createdAt
      }))
    }
  });
});

// Get user's batches
export const getUserBatches = asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;

  const { count, rows: batches } = await ListUploadBatch.findAndCountAll({
    where: { userId: req.user.id },
    order: [['createdAt', 'DESC']],
    limit,
    offset,
    attributes: [
      'id',
      'originalFilename',
      'fileType',
      'status',
      'totalRecords',
      'validRecords',
      'duplicateRecords',
      'failedRecords',
      'createdAt',
      'updatedAt'
    ]
  });

  res.status(200).json({
    success: true,
    data: batches,
    pagination: {
      page,
      limit,
      total: count,
      pages: Math.ceil(count / limit)
    }
  });
});