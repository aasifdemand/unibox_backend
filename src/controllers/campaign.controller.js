import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import ListUploadRecord from "../models/list-upload-record.model.js";
import { asyncHandler } from "../helpers/async-handler.js";
import { assertCampaignTransition } from "../utils/campaign-guards.js";
import { publishCampaignTick } from "../queues/campaign.queue.js";
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

  if (!batch || batch.status !== "completed") {
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
    scheduledAt,
    timezone,
    throttlePerMinute: throttlePerMinute || 10,
    status: "draft",
  });

  res.status(201).json({
    success: true,
    data: campaign,
  });
});

export const activateCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findByPk(req.params.id);

  if (!campaign) {
    throw new AppError("Campaign not found", 404);
  }

  assertCampaignTransition(campaign.status, "scheduled");

  // 🔥 materialize recipients from list batch WITH METADATA
  const records = await ListUploadRecord.findAll({
    where: {
      batchId: campaign.listBatchId,
      status: ["parsed", "duplicate"],
    },
  });

  const recipients = records.map((r) => ({
    campaignId: campaign.id,
    email: r.normalizedEmail,
    name: r.name || null,
    // Extract all metadata from the record
    metadata: {
      name: r.name,
      firstName: r.firstName,
      lastName: r.lastName,
      company: r.company,
      industry: r.industry,
      title: r.title,
      location: r.location,
      phone: r.phone,
      tags: r.tags,
      customFields: r.customFields || {},
      // Include all parsed data
      ...(r.metadata || {}),
    },
    // Track source
    sourceRecordId: r.id,
    sourceBatchId: campaign.listBatchId,
  }));

  await CampaignRecipient.bulkCreate(recipients, {
    ignoreDuplicates: true,
    validate: true,
  });

  // Update counts
  await campaign.update({
    status: "scheduled",
    scheduledAt: new Date(),
    totalRecipients: recipients.length,
    pendingRecipients: recipients.length,
  });

  // Log the materialization
  console.log(`📊 Materialized ${recipients.length} recipients for campaign ${campaign.id}`);

  // kick scheduler
  await publishCampaignTick(campaign.id);

  res.json({ 
    success: true, 
    message: "Campaign activated",
    data: {
      campaignId: campaign.id,
      recipientsCount: recipients.length,
      materializedAt: new Date().toISOString()
    }
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

  await publishCampaignTick(campaign.id);

  res.json({ success: true, message: "Campaign resumed" });
});
