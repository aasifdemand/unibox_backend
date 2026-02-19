import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
  activateCampaign,
  createCampaign,
  pauseCampaign,
  resumeCampaign,
  getCampaigns,
  getCampaign,
  updateCampaign,
  deleteCampaign,
  getCampaignReplies,
} from "../controllers/campaign.controller.js";

/**
 * @swagger
 * tags:
 *   name: Campaigns
 *   description: Campaign management APIs
 */

const router = Router();

/**
 * @swagger
 * /campaigns:
 *   get:
 *     summary: Get all campaigns for the current user
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of campaigns
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Campaign'
 *       401:
 *         description: Unauthorized
 */
router.get("/", protect, getCampaigns);

/**
 * @swagger
 * /campaigns/create:
 *   post:
 *     summary: Create a new email campaign
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - senderId
 *               - listBatchId
 *               - subject
 *               - htmlBody
 *             properties:
 *               name:
 *                 type: string
 *                 example: January Outreach – Unibox Intro
 *               subject:
 *                 type: string
 *                 example: Quick question {{name}}
 *               htmlBody:
 *                 type: string
 *                 example: "<p>Hi {{name}},</p><p>Quick intro...</p>"
 *               textBody:
 *                 type: string
 *               previewText:
 *                 type: string
 *               senderId:
 *                 type: string
 *                 format: uuid
 *               senderType:
 *                 type: string
 *                 enum: [gmail, outlook, smtp]
 *               listBatchId:
 *                 type: string
 *                 format: uuid
 *               scheduleType:
 *                 type: string
 *                 enum: [now, later]
 *                 default: now
 *               scheduledAt:
 *                 type: string
 *                 format: date-time
 *                 nullable: true
 *               timezone:
 *                 type: string
 *                 default: UTC
 *               throttlePerMinute:
 *                 type: integer
 *                 minimum: 1
 *                 maximum: 100
 *                 default: 10
 *               trackOpens:
 *                 type: boolean
 *                 default: true
 *               trackClicks:
 *                 type: boolean
 *                 default: true
 *               unsubscribeLink:
 *                 type: boolean
 *                 default: true
 *     responses:
 *       201:
 *         description: Campaign created successfully
 *       400:
 *         description: Missing required fields or invalid data
 *       401:
 *         description: Unauthorized
 */
router.post("/create", protect, createCampaign);

/**
 * @swagger
 * /campaigns/{id}:
 *   get:
 *     summary: Get a specific campaign by ID
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Campaign details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   $ref: '#/components/schemas/Campaign'
 *       404:
 *         description: Campaign not found
 *       401:
 *         description: Unauthorized
 */
router.get("/:id", protect, getCampaign);

/**
 * @swagger
 * /campaigns/{id}:
 *   put:
 *     summary: Update a campaign
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               subject:
 *                 type: string
 *               htmlBody:
 *                 type: string
 *               textBody:
 *                 type: string
 *               previewText:
 *                 type: string
 *               scheduledAt:
 *                 type: string
 *                 format: date-time
 *               timezone:
 *                 type: string
 *               throttlePerMinute:
 *                 type: integer
 *               trackOpens:
 *                 type: boolean
 *               trackClicks:
 *                 type: boolean
 *               unsubscribeLink:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Campaign updated successfully
 *       400:
 *         description: Invalid data
 *       404:
 *         description: Campaign not found
 *       401:
 *         description: Unauthorized
 */
router.put("/:id", protect, updateCampaign);

/**
 * @swagger
 * /campaigns/{id}:
 *   delete:
 *     summary: Delete a campaign
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Campaign deleted successfully
 *       404:
 *         description: Campaign not found
 *       401:
 *         description: Unauthorized
 */
router.delete("/:id", protect, deleteCampaign);

/**
 * @swagger
 * /campaigns/{id}/activate:
 *   post:
 *     summary: Activate a campaign (enqueue recipients)
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Campaign activated
 *       400:
 *         description: Invalid campaign state
 */
router.post("/:id/activate", protect, activateCampaign);

/**
 * @swagger
 * /campaigns/{id}/pause:
 *   post:
 *     summary: Pause a running campaign
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Campaign paused
 */
router.post("/:id/pause", protect, pauseCampaign);

/**
 * @swagger
 * /campaigns/{id}/resume:
 *   post:
 *     summary: Resume a paused campaign
 *     tags: [Campaigns]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Campaign resumed
 */
router.post("/:id/resume", protect, resumeCampaign);

// In your campaign routes
router.get("/:id/replies", protect, getCampaignReplies);

export default router;
