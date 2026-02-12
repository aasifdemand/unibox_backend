import { Router } from "express";
import { upload } from "../middlewares/upload.middleware.js";
import {
  deleteBatch,
  exportBatch,
  getBatchStatus,
  getUserBatches,
  retryBatch,
  uploadList,
} from "../controllers/list-upload.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Lists
 *   description: List upload and processing APIs
 */

/**
 * @swagger
 * /api/v1/list/upload:
 *   post:
 *     summary: Upload a contact list file (CSV, XLSX, TXT)
 *     description: |
 *       Upload a list file containing email addresses.
 *       The file is validated, stored, and processed asynchronously.
 *
 *       Processing includes:
 *       - Parsing & normalization
 *       - Deduplication
 *       - Record-level job queuing
 *
 *       The request is non-blocking and returns a batch ID immediately.
 *     tags: [Lists]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required:
 *               - file
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: CSV, XLSX, or TXT file containing email records
 *     responses:
 *       202:
 *         description: File accepted and processing started
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *             example:
 *               success: true
 *               message: List uploaded successfully
 *               data:
 *                 batchId: "c8e4a3b2-9f65-4b8f-9c9a-6d0a8d4e91ab"
 *                 status: uploaded
 *       400:
 *         description: Invalid file or missing file
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Duplicate upload detected (same checksum)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/upload", protect, upload.single("file"), uploadList);

/**
 * @swagger
 * /api/v1/list/batch/{batchId}/status:
 *   get:
 *     summary: Get batch processing status
 *     tags: [Lists]
 *     security:
 *       - cookieAuth: []
 */
router.get("/batch/:batchId/status", protect, getBatchStatus);

/**
 * @swagger
 * /api/v1/list/batches:
 *   get:
 *     summary: Get user's upload batches
 *     tags: [Lists]
 *     security:
 *       - cookieAuth: []
 */
router.get("/batches", protect, getUserBatches);

// In your backend routes (list-upload.routes.js or similar)
router.delete("/batch/:batchId", protect, deleteBatch);
router.post("/batch/:batchId/retry", protect, retryBatch);
router.get("/batch/:batchId/export", protect, exportBatch);

export default router;
