import { Router } from "express";
import {
  forgotPassword,
  googleCallback,
  login,
  logout,
  resetPassword,
  signup,
} from "../controllers/auth.controller.js";
import passport from "passport";
import { protect, protectOptional } from "../middlewares/auth.middleware.js";
import Sender from "../models/sender.model.js";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: Authentication APIs
 */

/**
 * @swagger
 * /api/v1/auth/signup:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     security: []   # public
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name:
 *                 type: string
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *     responses:
 *       201:
 *         description: Signup successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       409:
 *         description: User already exists
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/signup", signup);

/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     summary: Login user
 *     tags: [Auth]
 *     security: []   # public
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               password:
 *                 type: string
 *                 format: password
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: Invalid credentials
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/login", login);

/**
 * @swagger
 * /api/v1/auth/google:
 *   get:
 *     summary: Login with Google
 *     tags: [Auth]
 *     security: []
 */
router.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: false,
  })
);

/**
 * @swagger
 * /api/v1/auth/google/callback:
 *   get:
 *     summary: Google OAuth callback
 *     tags: [Auth]
 *     security: []
 */
router.get(
  "/google/callback",
  passport.authenticate("google", {
    session: false,
    prompt: "select_account",
    failureRedirect: "/login",
  }),
  googleCallback
);

/**
 * Start Outlook OAuth
 */
router.get("/microsoft/start", (req, res, next) => {
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({
      success: false,
      message: "Missing userId",
    });
  }

  passport.authenticate("microsoft", {
    prompt: "select_account",
    scope: [
      "openid",
      "profile",
      "offline_access",
      "User.Read",
      "Mail.Send",
      "Mail.Read",
    ],
    state: userId, // 👈 CRITICAL
    session: false,
  })(req, res, next);
});



/**
 * OAuth callback
 */
router.get(
  "/microsoft/callback",
  passport.authenticate("microsoft", {
    session: false,
    failureRedirect: `${process.env.FRONTEND_URL}/connect/outlook?error=oauth_failed`,
  }),
  async (req, res) => {
    try {
      const userId = req.query.state;

      if (!userId) {
        throw new Error("Missing OAuth state (userId)");
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
        emails?.[0]?.value ||
        _json?.mail ||
        _json?.userPrincipalName;

      await Sender.create({
        userId,
        email,
        displayName,
        domain: email.split("@")[1],
        provider: "outlook",

        oauthProvider: "microsoft",
        oauthAccessToken: _accessToken,
        oauthRefreshToken: _refreshToken,
        oauthExpiresAt: new Date(Date.now() + _expiresIn * 1000),
      });

      res.redirect(
        `${process.env.FRONTEND_URL}/senders?connected=outlook`
      );
    } catch (err) {
      console.error(err);
      res.redirect(
        `${process.env.FRONTEND_URL}/senders?error=save_failed`
      );
    }
  }
);



/**
 * @swagger
 * /api/v1/auth/forgot-password:
 *   post:
 *     summary: Send OTP to user's email for password reset
 *     tags: [Auth]
 *     security: []   # public
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *                 example: user@example.com
 *     responses:
 *       200:
 *         description: OTP sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/forgot-password", forgotPassword);

/**
 * @swagger
 * /api/v1/auth/reset-password:
 *   post:
 *     summary: Verify OTP and reset user password
 *     tags: [Auth]
 *     security: []   # public
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, otp, newPassword]
 *             properties:
 *               email:
 *                 type: string
 *                 format: email
 *               otp:
 *                 type: string
 *                 example: "123456"
 *               newPassword:
 *                 type: string
 *                 format: password
 *     responses:
 *       200:
 *         description: Password reset successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       400:
 *         description: Invalid or expired OTP
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/reset-password", resetPassword);

/**
 * @swagger
 * /api/v1/auth/logout:
 *   post:
 *     summary: Logout the currently authenticated user
 *     tags: [Auth]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: Logout successful
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *       401:
 *         description: Not authenticated
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.post("/logout", logout);

export default router;




