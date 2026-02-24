import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import ListUploadRecord from "../models/list-upload-record.model.js";
import { asyncHandler } from "../helpers/async-handler.js";
import { assertCampaignTransition } from "../utils/campaign-guards.js";
import AppError from "../utils/app-error.js";
import ListUploadBatch from "../models/list-upload-batch.model.js";
import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import ReplyEvent from "../models/reply-event.model.js";
import Email from "../models/email.model.js";
import { Op } from "sequelize";
import sequelize from "../config/db.js";

export const getCampaigns = asyncHandler(async (req, res) => {
  const campaigns = await Campaign.findAll({
    where: { userId: req.user.id },
    order: [["createdAt", "DESC"]],
    include: [
      {
        model: ListUploadBatch,
        as: "ListUploadBatch",
        attributes: [
          "id",
          "originalFilename",
          "validRecords",
          "totalRecords",
          "status",
        ],
      },
    ],
  });

  const batchIds = campaigns.map((c) => c.listBatchId).filter(Boolean);

  // 🚀 OPTIMIZATION: Get counts directly from DB via GROUP BY
  // Avoids loading 100k+ records into Node memory
  const recordCounts = await ListUploadRecord.findAll({
    where: { batchId: batchIds },
    attributes: [
      "batchId",
      [sequelize.fn("COUNT", sequelize.col("id")), "totalCount"],
    ],
    group: ["batchId"],
    raw: true,
  });

  // Map total counts for quick lookup
  const totalCountsMap = recordCounts.reduce((acc, curr) => {
    acc[curr.batchId] = parseInt(curr.totalCount);
    return acc;
  }, {});

  // 🚀 OPTIMIZATION: Get valid counts from GlobalEmailRegistry
  // We join with the registry to count only verified valid emails
  const validCounts = await ListUploadRecord.findAll({
    where: {
      batchId: batchIds,
    },
    include: [
      {
        model: GlobalEmailRegistry,
        where: { verificationStatus: "valid" },
        attributes: [],
        required: true,
      },
    ],
    attributes: [
      "batchId",
      [
        sequelize.fn("COUNT", sequelize.col("ListUploadRecord.id")),
        "validCount",
      ],
    ],
    group: ["batchId"],
    raw: true,
  });

  const validCountsMap = validCounts.reduce((acc, curr) => {
    acc[curr.batchId] = parseInt(curr.validCount);
    return acc;
  }, {});

  // Transform the response
  const campaignsWithData = campaigns.map((campaign) => {
    const campaignData = campaign.toJSON();
    const batchId = campaignData.listBatchId;

    const validRecipientsCount = validCountsMap[batchId] || 0;

    return {
      ...campaignData,
      totalRecipients: validRecipientsCount,
      batchValidCount: validRecipientsCount,
      batchTotalCount: totalCountsMap[batchId] || 0,
      batchName: campaignData.ListUploadBatch?.originalFilename || "Unknown",
    };
  });

  res.json({
    success: true,
    data: campaignsWithData,
    count: campaigns.length,
  });
});
/**
 * GET SINGLE CAMPAIGN
 */
export const getCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findOne({
    where: {
      id: req.params.id,
      userId: req.user.id,
    },
    include: [
      {
        model: ListUploadBatch,
        as: "ListUploadBatch", // ✅ Changed from "batch" to "ListUploadBatch"
        attributes: [
          "id",
          "originalFilename",
          "validRecords",
          "status",
          "totalRecords",
        ],
      },
      {
        model: CampaignRecipient,
        as: "CampaignRecipients",
        attributes: [
          "id",
          "email",
          "name",
          "status",
          "lastSentAt",
          "repliedAt",
        ],
        limit: 50,
        required: false, // Make it optional
      },
    ],
  });

  if (!campaign) {
    throw new AppError("Campaign not found", 404);
  }

  res.json({
    success: true,
    data: campaign,
  });
});

/**
 * CREATE CAMPAIGN - Always create as DRAFT
 */
export const createCampaign = asyncHandler(async (req, res) => {
  const {
    name,
    subject,
    htmlBody,
    textBody,
    previewText,
    senderId,
    senderType,
    listBatchId,
    scheduledAt,
    timezone,
    throttlePerMinute,
    trackOpens,
    trackClicks,
    unsubscribeLink,
  } = req.body;

  if (!name || !subject || !senderId || !listBatchId) {
    throw new AppError("Missing required fields", 400);
  }

  // Validate senderType
  if (!senderType || !["gmail", "outlook", "smtp"].includes(senderType)) {
    throw new AppError("Invalid sender type", 400);
  }

  const batch = await ListUploadBatch.findOne({
    where: { id: listBatchId, userId: req.user.id },
  });

  if (!batch || batch.status !== "verified") {
    throw new AppError("List batch not ready", 400);
  }

  let sender;

  if (senderType === "gmail") {
    sender = await GmailSender.findOne({
      where: { id: senderId, userId: req.user.id, isVerified: true },
    });
  } else if (senderType === "outlook") {
    sender = await OutlookSender.findOne({
      where: { id: senderId, userId: req.user.id, isVerified: true },
    });
  } else if (senderType === "smtp") {
    sender = await SmtpSender.findOne({
      where: { id: senderId, userId: req.user.id, isVerified: true },
    });
  }

  console.log(sender);

  if (!sender) {
    throw new AppError(`Sender not found for type ${senderType}`, 400);
  }

  // ALWAYS create as DRAFT - activation happens separately
  const campaign = await Campaign.create({
    userId: req.user.id,
    senderId,
    senderType,
    listBatchId,
    name,
    subject,
    htmlBody: htmlBody || "",
    textBody: textBody || "",
    previewText: previewText || "",
    scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
    timezone: timezone || "UTC",
    throttlePerMinute: throttlePerMinute || 10,
    trackOpens: trackOpens !== undefined ? trackOpens : true,
    trackClicks: trackClicks !== undefined ? trackClicks : true,
    unsubscribeLink: unsubscribeLink !== undefined ? unsubscribeLink : true,
    status: "draft", // ALWAYS draft initially
    totalSent: 0,
    totalReplied: 0,
  });

  // DO NOT create recipients here - they are created during activation

  res.status(201).json({
    success: true,
    data: campaign,
    message: "Campaign created as draft. Activate it when ready to send.",
  });
});

/**
 * UPDATE CAMPAIGN
 */
export const updateCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findOne({
    where: {
      id: req.params.id,
      userId: req.user.id,
    },
  });

  if (!campaign) {
    throw new AppError("Campaign not found", 404);
  }

  // Only allow updates to campaigns in draft or paused state
  if (!["draft", "paused"].includes(campaign.status)) {
    throw new AppError("Cannot update campaign in current state", 400);
  }

  const {
    name,
    subject,
    htmlBody,
    textBody,
    previewText,
    scheduledAt,
    timezone,
    throttlePerMinute,
    trackOpens,
    trackClicks,
    unsubscribeLink,
  } = req.body;

  // Update only provided fields
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (subject !== undefined) updates.subject = subject;
  if (htmlBody !== undefined) updates.htmlBody = htmlBody;
  if (textBody !== undefined) updates.textBody = textBody;
  if (previewText !== undefined) updates.previewText = previewText;
  if (scheduledAt !== undefined)
    updates.scheduledAt = scheduledAt ? new Date(scheduledAt) : null;
  if (timezone !== undefined) updates.timezone = timezone;
  if (throttlePerMinute !== undefined)
    updates.throttlePerMinute = throttlePerMinute;
  if (trackOpens !== undefined) updates.trackOpens = trackOpens;
  if (trackClicks !== undefined) updates.trackClicks = trackClicks;
  if (unsubscribeLink !== undefined) updates.unsubscribeLink = unsubscribeLink;

  await campaign.update(updates);

  res.json({
    success: true,
    data: campaign,
    message: "Campaign updated successfully",
  });
});

/**
 * DELETE CAMPAIGN
 */
export const deleteCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findOne({
    where: {
      id: req.params.id,
      userId: req.user.id,
    },
  });

  if (!campaign) {
    throw new AppError("Campaign not found", 404);
  }

  // Only allow deletion of campaigns in draft, completed, or paused state
  if (!["draft", "completed", "paused"].includes(campaign.status)) {
    throw new AppError("Cannot delete campaign in current state", 400);
  }

  // Soft delete the campaign
  await campaign.destroy();

  res.json({
    success: true,
    message: "Campaign deleted successfully",
  });
});

/**
 * ACTIVATE CAMPAIGN
 */
export const activateCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findByPk(req.params.id);
  if (!campaign) throw new AppError("Campaign not found", 404);

  // Check if campaign belongs to user
  if (campaign.userId !== req.user.id) {
    throw new AppError("Unauthorized", 403);
  }

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
    scheduledAt: activationTime,
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

  if (!campaign) throw new AppError("Campaign not found", 404);

  // Check if campaign belongs to user
  if (campaign.userId !== req.user.id) {
    throw new AppError("Unauthorized", 403);
  }

  assertCampaignTransition(campaign.status, "paused");

  await campaign.update({ status: "paused" });

  res.json({ success: true, message: "Campaign paused" });
});

/**
 * RESUME CAMPAIGN
 */
export const resumeCampaign = asyncHandler(async (req, res) => {
  const campaign = await Campaign.findByPk(req.params.id);

  if (!campaign) throw new AppError("Campaign not found", 404);

  // Check if campaign belongs to user
  if (campaign.userId !== req.user.id) {
    throw new AppError("Unauthorized", 403);
  }

  assertCampaignTransition(campaign.status, "running");

  await campaign.update({ status: "running" });

  res.json({ success: true, message: "Campaign resumed" });
});

// =========================
// GET CAMPAIGN REPLIES - FIXED
// =========================
export const getCampaignReplies = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { page = 1, limit = 20 } = req.query;

  const campaign = await Campaign.findOne({
    where: { id, userId: req.user.id },
  });

  if (!campaign) {
    throw new AppError("Campaign not found", 404);
  }

  const offset = (page - 1) * limit;

  const { count, rows: replies } = await ReplyEvent.findAndCountAll({
    where: { campaignId: id },
    include: [
      {
        model: Email,
        as: "email",
        attributes: [
          "id",
          "subject",
          "sentAt",
          "recipientId",
          "recipientEmail",
        ],
        include: [
          {
            model: CampaignRecipient,
            as: "recipient",
            attributes: ["id", "email", "name", "status"],
          },
        ],
      },
    ],
    order: [["receivedAt", "DESC"]],
    limit: parseInt(limit),
    offset: parseInt(offset),
  });

  // Transform the data to match the expected structure
  const transformedReplies = replies.map((reply) => {
    const replyJson = reply.toJSON();
    return {
      ...replyJson,
      recipient: replyJson.email?.recipient || null,
      // Remove the nested structure if needed
      email: replyJson.email
        ? {
            id: replyJson.email.id,
            subject: replyJson.email.subject,
            sentAt: replyJson.email.sentAt,
          }
        : null,
    };
  });

  // Get unique thread count
  const uniqueThreads = await ReplyEvent.count({
    where: { campaignId: id },
    distinct: true,
    col: "providerThreadId",
  });

  // Get total sent count for rate calculation
  const totalSent = await Email.count({
    where: { campaignId: id },
  });

  // Get reply statistics by date (last 30 days)
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const dailyStats = await ReplyEvent.findAll({
    where: {
      campaignId: id,
      receivedAt: { [Op.gte]: thirtyDaysAgo },
    },
    attributes: [
      [sequelize.fn("DATE", sequelize.col("receivedAt")), "date"],
      [sequelize.fn("COUNT", sequelize.col("id")), "count"],
    ],
    group: [sequelize.fn("DATE", sequelize.col("receivedAt"))],
    order: [[sequelize.fn("DATE", sequelize.col("receivedAt")), "ASC"]],
    raw: true,
  });

  res.json({
    success: true,
    data: {
      replies: transformedReplies,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit),
      },
      stats: {
        totalReplies: count,
        uniqueThreads,
        dailyStats,
        replyRate: totalSent > 0 ? ((count / totalSent) * 100).toFixed(2) : 0,
      },
    },
  });
});
