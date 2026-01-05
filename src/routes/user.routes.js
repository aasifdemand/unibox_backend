import express from "express";
import { protect } from "../middlewares/auth.middleware.js";
import { getProfile, updateProfile } from "../controllers/user.controller.js";

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: User
 *   description: User APIs
 */

/**
 * @swagger
 * /api/v1/users/me:
 *   get:
 *     summary: Get logged-in user profile
 *     tags: [User]
 *     security:
 *       - cookieAuth: []
 *     responses:
 *       200:
 *         description: User profile fetched successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *             example:
 *               success: true
 *               message: Success
 *               data:
 *                 id: "b3b1c9e6-9b8d-4c4c-8c91-123456789abc"
 *                 name: "Aasif Ali"
 *                 email: "aasif@example.com"
 *       401:
 *         description: Unauthorized (user not logged in)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.get("/me", protect, getProfile);

/**
 * @swagger
 * /api/v1/users/profile:
 *   patch:
 *     summary: Update logged-in user profile (partial update)
 *     tags: [User]
 *     security:
 *       - cookieAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 example: "Aasif Ali"
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "newemail@example.com"
 *     responses:
 *       200:
 *         description: Profile updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/SuccessResponse'
 *             example:
 *               success: true
 *               message: Profile updated successfully
 *               data:
 *                 id: "b3b1c9e6-9b8d-4c4c-8c91-123456789abc"
 *                 name: "Aasif Ali"
 *                 email: "newemail@example.com"
 *       400:
 *         description: No fields provided to update
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       401:
 *         description: Unauthorized (user not logged in)
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 *       409:
 *         description: Email already in use
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/ErrorResponse'
 */
router.patch("/profile", protect, updateProfile);

export default router;
