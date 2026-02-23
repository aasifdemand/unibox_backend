import { asyncHandler } from "../helpers/async-handler.js";
import {
  createTemplate,
  updateTemplate,
  getTemplateById,
  listTemplates,
  deleteTemplate,
} from "../services/email-template.service.js";

/* =========================
   CREATE
========================= */
export const createEmailTemplate = asyncHandler(async (req, res) => {
  const template = await createTemplate(req.user.id, req.body);

  res.status(201).json({
    success: true,
    data: template,
  });
});

/* =========================
   UPDATE
========================= */
export const updateEmailTemplate = asyncHandler(async (req, res) => {
  const template = await updateTemplate(
    req.params.templateId,
    req.user.id,
    req.body,
  );

  res.json({
    success: true,
    data: template,
  });
});

/* =========================
   GET ONE
========================= */
export const getEmailTemplate = asyncHandler(async (req, res) => {
  const { templateId } = req.params;

  if (!templateId) {
    return res.status(400).json({
      success: false,
      message: "Template ID is required",
    });
  }

  const template = await getTemplateById(templateId, req.user.id);

  res.json({
    success: true,
    data: template,
  });
});
/* =========================
   LIST
========================= */
export const listEmailTemplates = asyncHandler(async (req, res) => {
  const templates = await listTemplates(req.user.id, req.query);

  res.json({
    success: true,
    data: templates,
  });
});

/* =========================
   DELETE
========================= */
export const deleteEmailTemplate = asyncHandler(async (req, res) => {
  await deleteTemplate(req.params.templateId, req.user.id);

  res.json({
    success: true,
    message: "Template deleted successfully",
  });
});
