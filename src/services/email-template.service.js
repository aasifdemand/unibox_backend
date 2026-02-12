import EmailTemplate from "../models/email-template.model.js";
import { Op } from "sequelize";

/* =========================
   CREATE TEMPLATE
========================= */
export const createTemplate = async (userId, payload) => {
  const template = await EmailTemplate.create({
    userId,
    name: payload.name,
    subject: payload.subject,
    htmlContent: payload.htmlContent,
    textContent: payload.textContent || null,
    variables: payload.variables || [],
    status: payload.status || "draft",
    isDefault: payload.isDefault || false,
  });

  return template;
};

/* =========================
   UPDATE TEMPLATE
========================= */
export const updateTemplate = async (templateId, userId, payload) => {
  const template = await EmailTemplate.findOne({
    where: { id: templateId, userId },
  });

  if (!template) {
    throw new Error("Template not found");
  }

  await template.update({
    name: payload.name ?? template.name,
    subject: payload.subject ?? template.subject,
    htmlContent: payload.htmlContent ?? template.htmlContent,
    textContent: payload.textContent ?? template.textContent,
    variables: payload.variables ?? template.variables,
    status: payload.status ?? template.status,
    isDefault: payload.isDefault ?? template.isDefault,
  });

  return template;
};

/* =========================
   GET SINGLE TEMPLATE
========================= */
export const getTemplateById = async (templateId, userId) => {
  const template = await EmailTemplate.findOne({
    where: { id: templateId, userId },
  });

  if (!template) {
    throw new Error("Template not found");
  }

  return template;
};

/* =========================
   LIST TEMPLATES
========================= */
export const listTemplates = async (userId, filters = {}) => {
  const where = { userId };

  if (filters.status) {
    where.status = filters.status;
  }

  if (filters.search) {
    where.name = { [Op.iLike]: `%${filters.search}%` };
  }

  return EmailTemplate.findAll({
    where,
    order: [["updatedAt", "DESC"]],
  });
};

/* =========================
   DELETE TEMPLATE
========================= */
export const deleteTemplate = async (templateId, userId) => {
  const deleted = await EmailTemplate.destroy({
    where: { id: templateId, userId },
  });

  if (!deleted) {
    throw new Error("Template not found");
  }

  return true;
};
