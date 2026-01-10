import { Sequelize, Op } from "sequelize";
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import Email from "../models/email.model.js";
import ReplyEvent from "../models/reply-event.model.js";

/* ======================================================
   CAMPAIGN OVERVIEW
====================================================== */
export const campaignOverview = async (req, res) => {
  const { campaignId } = req.params;

  const campaign = await Campaign.findByPk(campaignId);
  if (!campaign) {
    return res.status(404).json({
      success: false,
      message: "Campaign not found",
    });
  }

  const [
    sentCount,
    repliedCount,
    recipientStats,
    sendStats,
  ] = await Promise.all([
    CampaignSend.count({
      where: { campaignId, status: "sent" },
    }),
    ReplyEvent.count({
      include: [
        {
          model: Email,
          where: { campaignId },
          attributes: [],
        },
      ],
    }),
    CampaignRecipient.findAll({
      where: { campaignId },
      attributes: [
        "status",
        [Sequelize.fn("COUNT", "*"), "count"],
      ],
      group: ["status"],
    }),
    CampaignSend.findAll({
      where: { campaignId },
      attributes: [
        "status",
        [Sequelize.fn("COUNT", "*"), "count"],
      ],
      group: ["status"],
    }),
  ]);

  res.json({
    success: true,
    data: {
      campaignId,
      name: campaign.name,
      status: campaign.status,
      scheduledAt: campaign.scheduledAt,
      completedAt: campaign.completedAt,
      totals: {
        sent: sentCount,
        replied: repliedCount,
      },
      recipients: recipientStats,
      sends: sendStats,
    },
  });
};

/* ======================================================
   STEP-WISE ANALYTICS
====================================================== */
export const campaignStepAnalytics = async (req, res) => {
  const { campaignId } = req.params;

  const steps = await CampaignSend.findAll({
    where: { campaignId },
    attributes: [
      "step",
      [Sequelize.fn("COUNT", Sequelize.col("CampaignSend.id")), "sent"],
      [
        Sequelize.fn("COUNT", Sequelize.col("Email.id")),
        "replied",
      ],
    ],
    include: [
      {
        model: Email,
        required: false,
        where: { status: "replied" },
        attributes: [],
      },
    ],
    group: ["step"],
    order: [["step", "ASC"]],
  });

  res.json({
    success: true,
    data: steps,
  });
};

/* ======================================================
   RECIPIENT-LEVEL ANALYTICS
====================================================== */
export const campaignRecipientsAnalytics = async (req, res) => {
  const { campaignId } = req.params;

  const recipients = await CampaignRecipient.findAll({
    where: { campaignId },
    attributes: [
      "id",
      "email",
      "status",
      "currentStep",
      "lastSentAt",
      "repliedAt",
      
    ],
    order: [["createdAt", "ASC"]],
  });

  res.json({
    success: true,
    data: recipients,
  });
};

/* ======================================================
   REPLIES LIST
====================================================== */
export const campaignReplies = async (req, res) => {
  const { campaignId } = req.params;

  const replies = await ReplyEvent.findAll({
    include: [
      {
        model: Email,
        where: { campaignId },
        attributes: ["recipientEmail", "sentAt"],
      },
    ],
    order: [["receivedAt", "DESC"]],
  });

  res.json({
    success: true,
    data: replies,
  });
};

/* ======================================================
   TIME-TO-REPLY ANALYTICS
====================================================== */
export const campaignReplyTime = async (req, res) => {
  const { campaignId } = req.params;

  const results = await Email.findAll({
    where: {
      campaignId,
      repliedAt: { [Op.ne]: null },
      sentAt: { [Op.ne]: null },
    },
    attributes: [
      [
        Sequelize.literal(
          "EXTRACT(EPOCH FROM (repliedAt - sentAt))"
        ),
        "replySeconds",
      ],
    ],
  });

  res.json({
    success: true,
    data: results,
  });
};
