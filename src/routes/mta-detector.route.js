import express from "express";
import {
  detectProvider,
  bulkDetectProviders,
  clearDetectionCache,
} from "../controllers/mta-detector.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.get("/detect", detectProvider);

router.post("/detect/bulk", protect, bulkDetectProviders);
router.delete("/detect/cache", protect, clearDetectionCache);

export default router;
