import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import ListUploadRecord from "../models/list-upload-record.model.js";
import { asyncHandler } from "../helpers/async-handler.js";
import { assertCampaignTransition } from "../utils/campaign-guards.js";
import AppError from "../utils/app-error.js";
import ListUploadBatch from "../models/list-upload-batch.model.js";

export const createCampaign = asyncHandler(async (req, res) => {
  const {
    name,
    subject,
    htmlBody,
    textBody,
    senderId,
    listBatchId,
    scheduledAt,
    timezone,
    throttlePerMinute,
  } = req.body;

  if (!name || !subject || !senderId || !listBatchId) {
    throw new AppError("Missing required fields", 400);
  }

  const batch = await ListUploadBatch.findOne({
    where: { id: listBatchId, userId: req.user.id },
  });

  if (!batch || batch.status !== "verified") {
    throw new AppError("List batch not ready", 400);
  }

  const campaign = await Campaign.create({
    userId: req.user.id,
    senderId,
    listBatchId,
    name,
    subject,
    htmlBody,
    textBody,
    scheduledAt: scheduledAt || null, // ⬅️ DO NOT auto-set
    timezone,
    throttlePerMinute: throttlePerMinute || 10,
    status: "draft",
  });

  res.status(201).json({ success: true, data: campaign });
});

export const activateCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findByPk(req.params.id);
  if (!campaign) throw new AppError("Campaign not found", 404);

  assertCampaignTransition(campaign.status, "scheduled");

  const records = await ListUploadRecord.findAll({
    where: {
      batchId: campaign.listBatchId,
      status: ["parsed", "duplicate"],
    },
  });

  if (!records.length) {
    throw new AppError("No valid recipients found", 400);
  }

  // ✅ THIS IS THE RULE
  const activationTime = campaign.scheduledAt ?? new Date();

  const recipients = records.map((r) => ({
    campaignId: campaign.id,
    email: r.normalizedEmail,
    name: r.name || null,
    metadata: r.metadata || {},
    sourceRecordId: r.id,
    sourceBatchId: campaign.listBatchId,

    status: "pending",
    currentStep: 0,
    nextRunAt: activationTime,
  }));

  await CampaignRecipient.bulkCreate(recipients, {
    ignoreDuplicates: true,
    validate: true,
  });

  await campaign.update({
    status: "scheduled",
    scheduledAt: activationTime, // ✅ ALWAYS SET ON ACTIVATION
    totalRecipients: recipients.length,
    pendingRecipients: recipients.length,
  });

  res.json({
    success: true,
    message: "Campaign activated",
    data: {
      campaignId: campaign.id,
      scheduledAt: activationTime,
      recipientsCount: recipients.length,
    },
  });
});

/**
 * PAUSE CAMPAIGN
 */
export const pauseCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findByPk(req.params.id);

  assertCampaignTransition(campaign.status, "paused");

  await campaign.update({ status: "paused" });

  res.json({ success: true, message: "Campaign paused" });
});

/**
 * RESUME CAMPAIGN
 */
export const resumeCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findByPk(req.params.id);

  assertCampaignTransition(campaign.status, "running");

  await campaign.update({ status: "running" });

  // ⚠️ Do NOT reset nextRunAt — preserve timeline

  res.json({ success: true, message: "Campaign resumed" });
});
