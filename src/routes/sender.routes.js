import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";
import { asyncHandler } from "../helpers/async-handler.js";
import {
  createSender,
  listSenders,
  deleteSender,
  testSender,
  refreshSenderToken,
  revokeSenderAccess,
  testSmtpConnection,
  testImapConnection,
  getSender,
  updateSender,
  bulkUploadSenders,
  bulkDeleteSenders,
} from "../controllers/sender.controller.js";
import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import passportGoogle from "../config/passportgoogle-senders.js";
import passportMicrosoft from "../config/passport-microsoft.config.js";
import {upload} from "../middlewares/upload.middleware.js";

/**
 * @swagger
 * tags:
 *   name: Senders
 *   description: Sender mailbox management
 */

const router = Router();

// =========================
// SMTP SENDER ENDPOINTS
// =========================

/**
 * @swagger
 * /senders/create:
 *   post:
 *     summary: Create a custom SMTP sender
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
 *               - smtpHost
 *               - smtpPort
 *               - smtpUser
 *               - smtpPassword
 *             properties:
 *               email:
 *                 type: string
 *                 example: sender@yourdomain.com
 *               displayName:
 *                 type: string
 *                 example: Your Company Name
 *               smtpHost:
 *                 type: string
 *                 example: smtp.yourdomain.com
 *               smtpPort:
 *                 type: integer
 *                 example: 587
 *               smtpSecure:
 *                 type: boolean
 *                 example: true
 *               smtpUser:
 *                 type: string
 *                 example: sender@yourdomain.com
 *               smtpPassword:
 *                 type: string
 *                 example: app-password
 *               imapHost:
 *                 type: string
 *                 example: imap.yourdomain.com
 *               imapPort:
 *                 type: integer
 *                 example: 993
 *               imapUser:
 *                 type: string
 *                 example: sender@yourdomain.com
 *               imapPassword:
 *                 type: string
 *                 example: app-password
 *     responses:
 *       201:
 *         description: SMTP sender created successfully
 *       400:
 *         description: Validation error
 */
router.post("/create", protect, createSender);
router.post("/bulk-upload", protect, upload.single("file"), bulkUploadSenders);
router.post("/bulk-delete", protect, bulkDeleteSenders);

/**
 * @swagger
 * /senders:
 *   get:
 *     summary: List all senders for logged-in user (including OAuth and SMTP)
 *     tags: [Senders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of senders
 */
router.get("/", protect, listSenders);

/**
 * @swagger
 * /senders/{senderId}:
 *   delete:
 *     summary: Delete a sender
 *     tags: [Senders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: senderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Sender deleted successfully
 */
router.delete("/:senderId", protect, deleteSender);

/**
 * @swagger
 * /senders/{senderId}/test:
 *   post:
 *     summary: Test sender connection
 *     tags: [Senders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: senderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Test results
 */
router.post("/:senderId/test", protect, testSender);

router.get("/:senderId", protect, getSender);
router.put("/:senderId", protect, updateSender);

// =========================
// GMAIL OAUTH ENDPOINTS
// =========================

/**
 * @swagger
 * /senders/oauth/gmail:
 *   get:
 *     summary: Start Gmail OAuth connection
 *     tags: [Senders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       302:
 *         description: Redirects to Google OAuth
 */
// Change this in your /senders/oauth/gmail route:
router.get("/oauth/gmail", protect, (req, res, next) => {
  const state = `sender-${req.user.id}`;

  passportGoogle.authenticate("google-sender", {
    scope: [
      "profile",
      "email",
      "https://www.googleapis.com/auth/gmail.readonly", // For searching and reading
      "https://www.googleapis.com/auth/gmail.modify", // For marking as read
      "https://www.googleapis.com/auth/gmail.send",
    ],
    session: false,
    prompt: "consent", // ← CHANGE from "select_account" to "consent"
    accessType: "offline", // This is already correct
    state: state,
  })(req, res, next);
});
/**
 * @swagger
 * /senders/oauth/gmail/callback:
 *   get:
 *     summary: Gmail OAuth callback
 *     tags: [Senders]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirects to frontend with success/error
 */
router.get(
  "/oauth/gmail/callback",
  passportGoogle.authenticate("google-sender", {
    session: false,
    failureRedirect: `${process.env.FRONTEND_URL || "http://localhost:8080"}/dashboard/audience?error=gmail_auth_failed`,
  }),
  asyncHandler(async (req, res) => {
    try {
      const userData = req.user; // This comes from Passport strategy

      if (!userData) {
        return res.redirect(
          `${process.env.FRONTEND_URL || "http://localhost:8080"}/dashboard/audience?error=auth_failed`,
        );
      }

      const email = userData.email || userData.profile?.emails?.[0]?.value;
      const displayName =
        userData.displayName ||
        userData.profile?.displayName ||
        email?.split("@")[0];
      const accessToken = userData.accessToken;
      const refreshToken = userData.refreshToken;
      const googleId = userData.googleId || userData.profile?.id;
      const userId = userData.userId; // From state parameter

      if (!email) {
        return res.redirect(
          `${process.env.FRONTEND_URL || "http://localhost:8080"}/dashboard/audience?error=no_email`,
        );
      }

      if (!userId) {
        return res.redirect(
          `${process.env.FRONTEND_URL || "http://localhost:8080"}/dashboard/audience?error=no_user_id`,
        );
      }

      // Check if Gmail sender already exists
      const existingSender = await GmailSender.findOne({
        where: {
          userId: userId,
          email: email.toLowerCase(),
        },
      });

      let sender;
      if (existingSender) {
        // Update existing sender
        await existingSender.update({
          accessToken,
          refreshToken,
          expiresAt: new Date(Date.now() + 3600 * 1000),
          isVerified: true, // ← MAKE SURE THIS IS SET
          isActive: true,
          googleId,
          lastUsedAt: new Date(),
        });
        sender = existingSender;
      } else {
        // Create new Gmail sender
        sender = await GmailSender.create({
          userId: userId,
          email: email.toLowerCase(),
          displayName: displayName || email.split("@")[0],
          domain: email.split("@")[1],
          accessToken,
          refreshToken,
          expiresAt: new Date(Date.now() + 3600 * 1000),
          googleId,
          isVerified: true, // ← MAKE SURE THIS IS SET
          isActive: true,
          lastUsedAt: new Date(),
        });
      }

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:8080";
      const cleanUrl = frontendUrl.endsWith("/")
        ? frontendUrl.slice(0, -1)
        : frontendUrl;

      return res.redirect(
        `${cleanUrl}/dashboard/audience?success=gmail_connected&senderId=${sender.id}`,
      );
    } catch (err) {
      console.error("Gmail OAuth callback error:", err);
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:8080";
      const cleanUrl = frontendUrl.endsWith("/")
        ? frontendUrl.slice(0, -1)
        : frontendUrl;
      return res.redirect(
        `${cleanUrl}/dashboard/audience?error=save_failed&message=${encodeURIComponent(err.message)}`,
      );
    }
  }),
);
// =========================
// OUTLOOK OAUTH ENDPOINTS
// =========================

/**
 * @swagger
 * /senders/oauth/outlook:
 *   get:
 *     summary: Start Outlook OAuth connection
 *     tags: [Senders]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       302:
 *         description: Redirects to Microsoft OAuth
 */
router.get("/oauth/outlook", protect, (req, res, next) => {
  const user = req.user;

  if (!user) {
    return res.status(401).json({
      success: false,
      message: "Authentication required",
    });
  }

  passportMicrosoft.authenticate("microsoft", {
    prompt: "login", // ✅ Valid values: 'login', 'none', 'consent', 'select_account'
    scope: [
      "openid",
      "profile",
      "offline_access",
      "User.Read",
      "Mail.Send",
      "Mail.Read",
      "Mail.ReadWrite",
    ],
    state: `sender-${user.id}`,
    session: false,
  })(req, res, next);
});

/**
 * @swagger
 * /senders/oauth/outlook/callback:
 *   get:
 *     summary: Outlook OAuth callback
 *     tags: [Senders]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirects to frontend with success/error
 */
router.get(
  "/oauth/outlook/callback",
  passportMicrosoft.authenticate("microsoft", {
    session: false,
    failureRedirect: `${process.env.FRONTEND_URL || "http://localhost:8080"}/dashboard/audience?error=outlook_auth_failed`,
  }),
  asyncHandler(async (req, res) => {
    try {
      // Extract userId from state parameter
      const state = req.query.state;
      const userId = state?.replace("sender-", "");

      if (!userId) {
        throw new Error("Missing user identification");
      }

      const {
        _accessToken,
        _refreshToken,
        _expiresIn,
        displayName,
        emails,
        _json,
      } = req.user;

      const email =
        emails?.[0]?.value || _json?.mail || _json?.userPrincipalName;

      if (!email) {
        throw new Error("Email not found in Microsoft profile");
      }

      // Check if Outlook sender already exists
      const existingSender = await OutlookSender.findOne({
        where: {
          userId,
          email: email.toLowerCase(),
        },
      });

      let sender;
      if (existingSender) {
        // Update existing sender
        await existingSender.update({
          accessToken: _accessToken,
          refreshToken: _refreshToken,
          expiresAt: new Date(Date.now() + _expiresIn * 1000),
          isVerified: true,
          microsoftId: req.user.id,
          lastUsedAt: new Date(),
          isVerified: true, // ← MAKE SURE THIS IS SET
          isActive: true,
        });
        sender = existingSender;
      } else {
        // Create new Outlook sender
        sender = await OutlookSender.create({
          userId,
          email: email.toLowerCase(),
          displayName: displayName || email.split("@")[0],
          domain: email.split("@")[1],
          accessToken: _accessToken,
          refreshToken: _refreshToken,
          expiresAt: new Date(Date.now() + _expiresIn * 1000),
          microsoftId: req.user.id,
          isVerified: true, // ← MAKE SURE THIS IS SET
          isActive: true,
          lastUsedAt: new Date(),
        });
      }

      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:8080";
      const cleanUrl = frontendUrl.endsWith("/")
        ? frontendUrl.slice(0, -1)
        : frontendUrl;

      return res.redirect(
        `${cleanUrl}/dashboard/audience?success=outlook_connected&senderId=${sender.id}`,
      );
    } catch (err) {
      console.error("Outlook OAuth callback error:", err);
      const frontendUrl = process.env.FRONTEND_URL || "http://localhost:8080";
      const cleanUrl = frontendUrl.endsWith("/")
        ? frontendUrl.slice(0, -1)
        : frontendUrl;
      return res.redirect(
        `${cleanUrl}/dashboard/audience?error=save_failed&message=${encodeURIComponent(err.message)}`,
      );
    }
  }),
);

// =========================
// TOKEN MANAGEMENT
// =========================

/**
 * @swagger
 * /senders/{senderId}/refresh-token:
 *   post:
 *     summary: Refresh OAuth token for a sender
 *     tags: [Senders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: senderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Token refreshed successfully
 */
router.post("/:senderId/refresh-token", protect, refreshSenderToken);

/**
 * @swagger
 * /senders/{senderId}/revoke:
 *   post:
 *     summary: Revoke OAuth access for a sender
 *     tags: [Senders]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: senderId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Access revoked successfully
 */
router.post("/:senderId/revoke", protect, revokeSenderAccess);

router.post("/test-smtp", protect, testSmtpConnection);
router.post("/test-imap", protect, testImapConnection);

export default router;
