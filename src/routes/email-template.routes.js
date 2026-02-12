import express from "express";
import {
  createEmailTemplate,
  updateEmailTemplate,
  getEmailTemplate,
  listEmailTemplates,
  deleteEmailTemplate,
} from "../controllers/email-template.controller.js";
import { protect } from "../middlewares/auth.middleware.js";

const router = express.Router();

router.post("/", protect, createEmailTemplate);
router.get("/", protect, listEmailTemplates);
router.get("/:templateId", protect, getEmailTemplate);
router.put("/:templateId", protect, updateEmailTemplate);
router.delete("/:templateId", protect, deleteEmailTemplate);

export default router;
