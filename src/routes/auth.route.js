import { Router } from "express";
import passport from "../config/passportgoogle-oauth.js";
import {
  forgotPassword,
  googleCallback,
  login,
  logout,
  resetPassword,
  signup,
} from "../controllers/auth.controller.js";
import { asyncHandler } from "../helpers/async-handler.js";

const router = Router();

/**
 * @swagger
 * tags:
 *   name: Auth
 *   description: User Authentication APIs
 */

// =========================
// LOCAL AUTHENTICATION
// =========================

/**
 * @swagger
 * /api/v1/auth/signup:
 *   post:
 *     summary: Register a new user
 *     tags: [Auth]
 *     security: []
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
 */
router.post("/signup", signup);

/**
 * @swagger
 * /api/v1/auth/login:
 *   post:
 *     summary: Login user
 *     tags: [Auth]
 *     security: []
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
 */
router.post("/login", login);

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
 */
router.post("/logout", logout);

// =========================
// PASSWORD RESET
// =========================

/**
 * @swagger
 * /api/v1/auth/forgot-password:
 *   post:
 *     summary: Send OTP to user's email for password reset
 *     tags: [Auth]
 *     security: []
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
 *     responses:
 *       200:
 *         description: OTP sent successfully
 */
router.post("/forgot-password", forgotPassword);

/**
 * @swagger
 * /api/v1/auth/reset-password:
 *   post:
 *     summary: Verify OTP and reset user password
 *     tags: [Auth]
 *     security: []
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
 *               newPassword:
 *                 type: string
 *                 format: password
 *     responses:
 *       200:
 *         description: Password reset successful
 */
router.post("/reset-password", resetPassword);

// =========================
// USER OAUTH (NOT FOR SENDERS)
// =========================

/**
 * @swagger
 * /api/v1/auth/google:
 *   get:
 *     summary: Login with Google (User Authentication)
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirects to Google OAuth
 */
router.get(
  "/google",
  passport.authenticate("google", {
    scope: ["profile", "email"],
    session: false,
  }),
);

/**
 * @swagger
 * /api/v1/auth/google/callback:
 *   get:
 *     summary: Google OAuth callback (User Authentication)
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirects to frontend
 */
router.get(
  "/google/callback",
  passport.authenticate("google", {
    session: false,
    prompt: "select_account",
    failureRedirect: "/login",
  }),
  googleCallback,
);

/**
 * @swagger
 * /api/v1/auth/microsoft:
 *   get:
 *     summary: Login with Microsoft (User Authentication)
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirects to Microsoft OAuth
 */
router.get("/microsoft", (req, res, next) => {
  passport.authenticate("microsoft", {
    prompt: "select_account",
    scope: ["openid", "profile", "email", "User.Read"],
    session: false,
  })(req, res, next);
});

/**
 * @swagger
 * /api/v1/auth/microsoft/callback:
 *   get:
 *     summary: Microsoft OAuth callback (User Authentication)
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       302:
 *         description: Redirects to frontend
 */
router.get(
  "/microsoft/callback",
  passport.authenticate("microsoft", {
    session: false,
    failureRedirect: "/login?error=oauth_failed",
  }),
  asyncHandler(async (req, res) => {
    // Handle user authentication callback
    // This is different from sender OAuth
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:8080";
    const cleanUrl = frontendUrl.endsWith("/")
      ? frontendUrl.slice(0, -1)
      : frontendUrl;

    // Generate JWT token for user
    // Redirect to frontend with token
    res.redirect(`${cleanUrl}/dashboard?token=${userToken}`);
  }),
);

export default router;
