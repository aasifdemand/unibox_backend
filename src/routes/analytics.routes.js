import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
  getGlobalOverview,
  getPerformanceMetrics,
  getTimelineData,
  getTopCampaigns,
  getRecentReplies,
  getSenderStats,
  getHourlyStats,
} from "../controllers/analytics.controller.js";

const router = Router();

// routes/analytics.routes.js - Add these new endpoints
router.get("/overview", protect, getGlobalOverview);
router.get("/performance", protect, getPerformanceMetrics);
router.get("/timeline", protect, getTimelineData);
router.get("/top-campaigns", protect, getTopCampaigns);
router.get("/recent-replies", protect, getRecentReplies);
router.get("/sender-stats", protect, getSenderStats);
router.get("/hourly", protect, getHourlyStats);

export default router;
