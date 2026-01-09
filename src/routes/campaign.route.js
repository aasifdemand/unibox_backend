import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
  activateCampaign,
  createCampaign,
  pauseCampaign,
  resumeCampaign,
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
 *               senderId:
 *                 type: string
 *                 format: uuid
 *               listBatchId:
 *                 type: string
 *                 format: uuid
 *               subject:
 *                 type: string
 *                 example: Quick question {{name}}
 *               htmlBody:
 *                 type: string
 *                 example: "<p>Hi {{name}},</p><p>Quick intro...</p>"
 *               textBody:
 *                 type: string
 *               scheduledAt:
 *                 type: string
 *                 format: date-time
 *                 nullable: true
 *     responses:
 *       201:
 *         description: Campaign created successfully
 *       401:
 *         description: Unauthorized
 */
router.post("/create",protect,createCampaign)


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

export default router;
