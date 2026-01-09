import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
  createSender,
  listSenders,
} from "../controllers/sender.controller.js";
/**
 * @swagger
 * tags:
 *   name: Senders
 *   description: Sender mailbox management
 */

const router = Router();

/**
 * @swagger
 * /senders/create:
 *   post:
 *     summary: Create a sender (SMTP mailbox)
 *     tags: [Senders]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - email
 *               - displayName
 *               - provider
 *               - smtpHost
 *               - smtpPort
 *               - smtpUser
 *               - smtpPassword
 *             properties:
 *               email:
 *                 type: string
 *                 example: aasifdemand@gmail.com
 *               displayName:
 *                 type: string
 *                 example: Aasif from Unibox
 *               provider:
 *                 type: string
 *                 example: gmail
 *               smtpHost:
 *                 type: string
 *                 example: smtp.gmail.com
 *               smtpPort:
 *                 type: integer
 *                 example: 587
 *               smtpSecure:
 *                 type: boolean
 *                 example: false
 *               smtpUser:
 *                 type: string
 *                 example: aasifdemand@gmail.com
 *               smtpPassword:
 *                 type: string
 *                 example: app-password
 *     responses:
 *       201:
 *         description: Sender created successfully
 *       400:
 *         description: Validation error
 */
router.post("/create", protect, createSender);

/**
 * @swagger
 * /senders:
 *   get:
 *     summary: List all senders for logged-in user
 *     tags: [Senders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of senders
 */
router.get("/", protect, listSenders);


export default router;
