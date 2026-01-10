import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
  campaignOverview,
  campaignStepAnalytics,
  campaignRecipientsAnalytics,
  campaignReplies,
  campaignReplyTime,
} from "../controllers/analytics.controller.js";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Analytics
 *   description: Campaign analytics and reporting
 */

/**
 * @swagger
 * /api/v1/analytics/campaigns/{campaignId}/overview:
 *   get:
 *     summary: Get campaign overview analytics
 *     description: >
 *       Returns high-level campaign metrics including total sent, replies,
 *       status breakdown, and scheduling information.
 *     tags: [Analytics]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Campaign ID
 *     responses:
 *       200:
 *         description: Campaign overview analytics
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *       404:
 *         description: Campaign not found
 */
router.get("/campaigns/:campaignId/overview", protect, campaignOverview);

/**
 * @swagger
 * /api/v1/analytics/campaigns/{campaignId}/steps:
 *   get:
 *     summary: Get per-step campaign analytics
 *     description: >
 *       Returns analytics grouped by step number, including sent count,
 *       replies, and drop-offs per step.
 *     tags: [Analytics]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Campaign ID
 *     responses:
 *       200:
 *         description: Step-level analytics
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
 *                     type: object
 *                     properties:
 *                       step:
 *                         type: integer
 *                       sent:
 *                         type: integer
 *                       replied:
 *                         type: integer
 */
router.get("/campaigns/:campaignId/steps", protect, campaignStepAnalytics);

/**
 * @swagger
 * /api/v1/analytics/campaigns/{campaignId}/recipients:
 *   get:
 *     summary: Get recipient-level campaign analytics
 *     description: >
 *       Returns each recipient's journey including current step,
 *       status (pending, replied, bounced, completed), and timestamps.
 *     tags: [Analytics]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Campaign ID
 *     responses:
 *       200:
 *         description: Recipient analytics list
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
 *                     type: object
 *                     properties:
 *                       email:
 *                         type: string
 *                       status:
 *                         type: string
 *                       currentStep:
 *                         type: integer
 *                       lastSentAt:
 *                         type: string
 *                         format: date-time
 *                       repliedAt:
 *                         type: string
 *                         format: date-time
 */
router.get(
  "/campaigns/:campaignId/recipients",
  protect,
  campaignRecipientsAnalytics
);

/**
 * @swagger
 * /api/v1/analytics/campaigns/{campaignId}/replies:
 *   get:
 *     summary: Get replies received for a campaign
 *     description: >
 *       Returns all reply events received for a campaign, ordered
 *       by received time (latest first).
 *     tags: [Analytics]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Campaign ID
 *     responses:
 *       200:
 *         description: Campaign replies
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
 *                     type: object
 *                     properties:
 *                       replyFrom:
 *                         type: string
 *                       subject:
 *                         type: string
 *                       receivedAt:
 *                         type: string
 *                         format: date-time
 */
router.get("/campaigns/:campaignId/replies", protect, campaignReplies);

/**
 * @swagger
 * /api/v1/analytics/campaigns/{campaignId}/time-to-reply:
 *   get:
 *     summary: Get time-to-reply analytics
 *     description: >
 *       Returns time (in seconds) taken by recipients to reply
 *       after receiving the email. Useful for SLA and intent analysis.
 *     tags: [Analytics]
 *     security:
 *       - cookieAuth: []
 *     parameters:
 *       - in: path
 *         name: campaignId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Campaign ID
 *     responses:
 *       200:
 *         description: Time-to-reply metrics
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
 *                     type: object
 *                     properties:
 *                       replySeconds:
 *                         type: number
 */
router.get(
  "/campaigns/:campaignId/time-to-reply",
  protect,
  campaignReplyTime
);

export default router;
