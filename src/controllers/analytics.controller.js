import { Op, Sequelize } from "sequelize";
import dayjs from "dayjs";
import Campaign from "../models/campaign.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import Email from "../models/email.model.js";
import ReplyEvent from "../models/reply-event.model.js";
import BounceEvent from "../models/bounce-event.model.js";
import { asyncHandler } from "../helpers/async-handler.js";
import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import { getCachedData, setCachedData } from "../utils/redis-client.js";

const CACHE_TTL = 900; // 15 minutes

// =========================
// GLOBAL OVERVIEW
// =========================
export const getGlobalOverview = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const cacheKey = `analytics:overview:${userId}`;

  const cached = await getCachedData(cacheKey);
  if (cached) {
    return res.json({ success: true, data: cached });
  }

  const [
    totalCampaigns,
    activeCampaigns,
    totalEmailsSent,
    totalReplies,
    totalBounces,
    avgOpenRate,
    avgReplyRate,
  ] = await Promise.all([
    // Total campaigns
    Campaign.count({ where: { userId } }),

    // Active campaigns
    Campaign.count({
      where: {
        userId,
        status: { [Op.in]: ["running", "sending"] },
      },
    }),

    // Total emails sent
    CampaignSend.count({
      include: [
        {
          model: Campaign,
          where: { userId },
          attributes: [],
        },
      ],
      where: { status: "sent" },
    }),

    // Total replies
    ReplyEvent.count({
      include: [
        {
          model: Email,
          include: [
            {
              model: Campaign,
              where: { userId },
              attributes: [],
            },
          ],
        },
      ],
    }),

    // Total bounces
    BounceEvent.count({
      include: [
        {
          model: Email,
          include: [
            {
              model: Campaign,
              where: { userId },
              attributes: [],
            },
          ],
        },
      ],
    }),

    // Average open rate
    Campaign.findOne({
      where: { userId },
      attributes: [
        [
          Sequelize.fn(
            "AVG",
            Sequelize.literal(
              'CASE WHEN "totalSent" > 0 THEN ("totalOpens"::float / "totalSent") * 100 ELSE 0 END',
            ),
          ),
          "avgOpenRate",
        ],
      ],
      raw: true,
    }),

    // Average reply rate
    Campaign.findOne({
      where: { userId },
      attributes: [
        [
          Sequelize.fn(
            "AVG",
            Sequelize.literal(
              'CASE WHEN "totalSent" > 0 THEN ("totalReplied"::float / "totalSent") * 100 ELSE 0 END',
            ),
          ),
          "avgReplyRate",
        ],
      ],
      raw: true,
    }),
  ]);

  const output = {
    totalCampaigns,
    activeCampaigns,
    totalEmailsSent,
    totalReplies,
    totalBounces,
    avgOpenRate: Math.round(avgOpenRate?.avgOpenRate || 0),
    avgReplyRate: Math.round(avgReplyRate?.avgReplyRate || 0),
  };

  await setCachedData(cacheKey, output, CACHE_TTL);

  res.json({
    success: true,
    data: output,
  });
});

// =========================
// PERFORMANCE METRICS
// =========================
export const getPerformanceMetrics = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const campaigns = await Campaign.findAll({
    where: { userId },
    attributes: [
      "id",
      "name",
      "totalSent",
      "totalOpens",
      "totalClicks",
      "totalReplied",
      [
        Sequelize.literal(
          'CASE WHEN "totalSent" > 0 THEN ("totalOpens"::float / "totalSent") * 100 ELSE 0 END',
        ),
        "openRate",
      ],
      [
        Sequelize.literal(
          'CASE WHEN "totalSent" > 0 THEN ("totalClicks"::float / "totalSent") * 100 ELSE 0 END',
        ),
        "clickRate",
      ],
      [
        Sequelize.literal(
          'CASE WHEN "totalSent" > 0 THEN ("totalReplied"::float / "totalSent") * 100 ELSE 0 END',
        ),
        "replyRate",
      ],
    ],
    order: [["createdAt", "DESC"]],
    limit: 100,
  });

  // Calculate aggregates
  const totals = campaigns.reduce(
    (acc, c) => ({
      totalSent: acc.totalSent + c.totalSent,
      totalOpens: acc.totalOpens + c.totalOpens,
      totalClicks: acc.totalClicks + c.totalClicks,
      totalReplied: acc.totalReplied + c.totalReplied,
    }),
    { totalSent: 0, totalOpens: 0, totalClicks: 0, totalReplied: 0 },
  );

  res.json({
    success: true,
    data: {
      campaigns,
      aggregates: {
        ...totals,
        avgOpenRate:
          totals.totalSent > 0
            ? Math.round((totals.totalOpens / totals.totalSent) * 100)
            : 0,
        avgClickRate:
          totals.totalSent > 0
            ? Math.round((totals.totalClicks / totals.totalSent) * 100)
            : 0,
        avgReplyRate:
          totals.totalSent > 0
            ? Math.round((totals.totalReplied / totals.totalSent) * 100)
            : 0,
      },
    },
  });
});

// =========================
// TIMELINE DATA - ONLY ACTUAL DATA
// =========================
export const getTimelineData = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { period = "week" } = req.query;
  const cacheKey = `analytics:timeline:${userId}:${period}`;

  const cached = await getCachedData(cacheKey);
  if (cached) {
    return res.json({ success: true, data: cached });
  }

  let truncateBy;
  let startDate;
  let unit;
  let format;
  let count;

  const now = dayjs(); // Using dayjs for easier date manipulation

  switch (period) {
    case "day":
      truncateBy = "hour";
      startDate = now.subtract(23, "hour").startOf("hour");
      unit = "hour";
      format = "YYYY-MM-DD HH:00";
      count = 24;
      break;
    case "week":
      truncateBy = "day";
      startDate = now.subtract(6, "day").startOf("day");
      unit = "day";
      format = "YYYY-MM-DD";
      count = 7;
      break;
    case "month":
      truncateBy = "day";
      startDate = now.subtract(29, "day").startOf("day");
      unit = "day";
      format = "YYYY-MM-DD";
      count = 30;
      break;
    case "year":
      truncateBy = "month";
      startDate = now.subtract(11, "month").startOf("month");
      unit = "month";
      format = "YYYY-MM";
      count = 12;
      break;
    default:
      truncateBy = "day";
      startDate = now.subtract(6, "day").startOf("day");
      unit = "day";
      format = "YYYY-MM-DD";
      count = 7;
  }

  const timeline = await CampaignSend.findAll({
    where: {
      sentAt: {
        [Op.ne]: null,
        [Op.gte]: startDate.toDate(),
      },
    },
    include: [
      {
        model: Campaign,
        where: { userId },
        attributes: [],
        required: true,
      },
      {
        model: Email,
        attributes: [],
        required: false,
        include: [
          {
            model: ReplyEvent,
            attributes: [],
            required: false,
          },
        ],
      },
    ],
    attributes: [
      [
        Sequelize.fn(
          "date_trunc",
          truncateBy,
          Sequelize.col("CampaignSend.sentAt"),
        ),
        "date",
      ],
      [
        Sequelize.fn(
          "COUNT",
          Sequelize.fn("DISTINCT", Sequelize.col("CampaignSend.id")),
        ),
        "sent",
      ],
      [
        Sequelize.literal(
          'COUNT(DISTINCT CASE WHEN "Email"."openedAt" IS NOT NULL THEN "Email"."id" END)',
        ),
        "opens",
      ],
      [
        Sequelize.literal(
          'COUNT(DISTINCT CASE WHEN "Email->ReplyEvents"."id" IS NOT NULL THEN "Email->ReplyEvents"."id" END)',
        ),
        "replies",
      ],
    ],
    group: [
      Sequelize.fn(
        "date_trunc",
        truncateBy,
        Sequelize.col("CampaignSend.sentAt"),
      ),
    ],
    order: [
      [
        Sequelize.fn(
          "date_trunc",
          truncateBy,
          Sequelize.col("CampaignSend.sentAt"),
        ),
        "ASC",
      ],
    ],
    raw: true,
  });

  // Zero-padding logic
  const result = [];
  const dbDataMap = timeline.reduce((acc, item) => {
    const key = dayjs(item.date).format(format);
    acc[key] = item;
    return acc;
  }, {});

  for (let i = 0; i < count; i++) {
    const d = startDate.add(i, unit);
    const key = d.format(format);
    const dbItem = dbDataMap[key];

    result.push({
      date: d.toISOString(),
      sent: dbItem ? parseInt(dbItem.sent) : 0,
      opens: dbItem ? parseInt(dbItem.opens) : 0,
      replies: dbItem ? parseInt(dbItem.replies) : 0,
    });
  }

  await setCachedData(cacheKey, result, CACHE_TTL);

  res.json({
    success: true,
    data: result,
    meta: {
      period,
      startDate: startDate.toISOString(),
      endDate: now.toISOString(),
      totalPoints: result.length,
    },
  });
});

// =========================
// TOP CAMPAIGNS
// =========================
export const getTopCampaigns = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { limit = 5 } = req.query;

  const topCampaigns = await Campaign.findAll({
    where: { userId },
    attributes: [
      "id",
      "name",
      "totalSent",
      "totalOpens",
      "totalClicks",
      "totalReplied",
      [
        Sequelize.literal(
          'CASE WHEN "totalSent" > 0 THEN ("totalReplied"::float / "totalSent") * 100 ELSE 0 END',
        ),
        "replyRate",
      ],
    ],
    order: [["totalReplied", "DESC"]],
    limit: parseInt(limit),
  });

  res.json({
    success: true,
    data: topCampaigns,
  });
});

// =========================
// RECENT REPLIES
// =========================
export const getRecentReplies = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { limit = 10 } = req.query;

  const replies = await ReplyEvent.findAll({
    include: [
      {
        model: Email,
        required: true,
        include: [
          {
            model: Campaign,
            where: { userId },
            attributes: ["id", "name"],
          },
        ],
        attributes: ["recipientEmail"],
      },
    ],
    order: [["receivedAt", "DESC"]],
    limit: parseInt(limit),
  });

  const formattedReplies = replies.map((reply) => ({
    id: reply.id,
    from: reply.replyFrom,
    subject: reply.subject,
    receivedAt: reply.receivedAt,
    campaignId: reply.Email?.Campaign?.id,
    campaignName: reply.Email?.Campaign?.name,
    recipientEmail: reply.Email?.recipientEmail,
  }));

  res.json({
    success: true,
    data: formattedReplies,
  });
});
// =========================
// SENDER STATS - FINAL FIX
// =========================
export const getSenderStats = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // Get all senders count by type
  const [gmailCount, outlookCount, smtpCount] = await Promise.all([
    GmailSender.count({
      where: {
        userId,
        isVerified: true,
      },
    }),
    OutlookSender.count({
      where: {
        userId,
        isVerified: true,
      },
    }),
    SmtpSender.count({
      where: {
        userId,
        isVerified: true,
        isActive: true,
      },
    }),
  ]);

  // Get email send counts by sender type from CampaignSend
  // FIX: Use Campaign.senderType instead of CampaignSend.senderType
  const sendStats = await CampaignSend.findAll({
    where: {
      status: "sent",
    },
    include: [
      {
        model: Campaign,
        where: { userId },
        attributes: ["senderType"], // Include senderType from Campaign
        required: true,
      },
    ],
    attributes: [
      [Sequelize.col("Campaign.senderType"), "senderType"], // Get senderType from Campaign
      [Sequelize.fn("COUNT", Sequelize.col("CampaignSend.id")), "count"],
    ],
    group: ["Campaign.senderType"], // Group by Campaign.senderType
    raw: true,
  });

  console.log("Send Stats:", sendStats); // Debug log

  // Format the stats
  const stats = {
    gmail: {
      type: "gmail",
      name: "Gmail",
      count: gmailCount,
      sent: 0,
      percentage: 0,
    },
    outlook: {
      type: "outlook",
      name: "Outlook",
      count: outlookCount,
      sent: 0,
      percentage: 0,
    },
    smtp: {
      type: "smtp",
      name: "SMTP",
      count: smtpCount,
      sent: 0,
      percentage: 0,
    },
  };

  // Add send counts from CampaignSend
  if (sendStats && sendStats.length > 0) {
    sendStats.forEach((stat) => {
      const type = stat.senderType;
      if (type && stats[type]) {
        stats[type].sent = parseInt(stat.count) || 0;
      }
    });
  }

  // Calculate total sends
  const totalSends = Object.values(stats).reduce(
    (sum, item) => sum + item.sent,
    0,
  );

  // Calculate percentages
  Object.values(stats).forEach((item) => {
    item.percentage =
      totalSends > 0 ? Math.round((item.sent / totalSends) * 100) : 0;
  });

  // Convert to array format for frontend
  const pieData = Object.values(stats);

  console.log("Final Pie Data:", pieData); // Debug log

  res.json({
    success: true,
    data: pieData,
  });
});

// =========================
// HOURLY STATS
// =========================
export const getHourlyStats = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const hourly = await CampaignSend.findAll({
    where: {
      sentAt: { [Op.ne]: null },
    },
    include: [
      {
        model: Campaign,
        where: { userId },
        attributes: [],
      },
    ],
    attributes: [
      [
        Sequelize.fn("EXTRACT", Sequelize.literal('HOUR FROM "sentAt"')),
        "hour",
      ],
      [Sequelize.fn("COUNT", Sequelize.col("CampaignSend.id")), "count"],
    ],
    group: [Sequelize.fn("EXTRACT", Sequelize.literal('HOUR FROM "sentAt"'))],
    order: [
      [Sequelize.fn("EXTRACT", Sequelize.literal('HOUR FROM "sentAt"')), "ASC"],
    ],
  });

  // Fill in missing hours
  const fullDay = Array.from({ length: 24 }, (_, i) => {
    const existing = hourly.find((h) => parseInt(h.dataValues.hour) === i);
    return {
      hour: i,
      count: existing ? parseInt(existing.dataValues.count) : 0,
      label: `${i}:00 ${i < 12 ? "AM" : "PM"}`,
    };
  });

  res.json({
    success: true,
    data: fullDay,
  });
});
