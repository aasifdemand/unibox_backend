import express from "express";
import { trackOpen, trackClick } from "../controllers/tracking.controller.js";

const router = express.Router();

// Public tracking endpoints (no auth required)
router.get("/open/:emailId", trackOpen);
router.get("/click/:emailId", trackClick);

export default router;
