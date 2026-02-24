import { Op } from "sequelize";
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignSend from "../models/campaign-send.model.js";
import sequelize from "../config/db.js";

export async function checkAllCampaignsCompletion() {
  console.log(
    `[${new Date().toISOString()}] 🔍 Checking for campaigns that can be completed...`,
  );

  // Find all running campaigns
  const runningCampaigns = await Campaign.findAll({
    where: {
      status: {
        [Op.in]: ["running", "sending"],
      },
    },
  });

  console.log(`Found ${runningCampaigns.length} running campaigns to check`);

  let completedCount = 0;

  for (const campaign of runningCampaigns) {
    const completed = await tryCompleteCampaign(campaign.id);
    if (completed) {
      completedCount++;
    }
  }

  console.log(
    `[${new Date().toISOString()}] ✅ Campaign check complete. ${completedCount} campaigns marked as completed.`,
  );

  return completedCount;
}

export async function tryCompleteCampaign(campaignId) {
  // Check if there are any queued emails left to send
  const queuedSends = await CampaignSend.count({
    where: {
      campaignId,
      status: "queued", // Only check for queued status
    },
  });

  if (queuedSends > 0) {
    console.log(
      `[Campaign ${campaignId}] Has ${queuedSends} queued sends - not completing`,
    );
    return false;
  }

  // Check if there are any recipients still in non-terminal states
  // Terminal states: replied, bounced, completed, stopped
  // Non-terminal: pending, sent
  const activeRecipients = await CampaignRecipient.count({
    where: {
      campaignId,
      status: {
        [Op.in]: ["pending", "sent"], // Non-terminal states
      },
    },
  });

  if (activeRecipients > 0) {
    console.log(
      `[Campaign ${campaignId}] Has ${activeRecipients} active recipients - not completing`,
    );
    return false;
  }

  // Check if there are recipients who completed their sequence recently (within 7 days).
  // We keep the campaign 'running' to collect replies for these recipients.
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentlyCompletedRecipients = await CampaignRecipient.count({
    where: {
      campaignId,
      status: "completed",
      lastSentAt: {
        [Op.gte]: sevenDaysAgo,
      },
    },
  });

  if (recentlyCompletedRecipients > 0) {
    console.log(
      `[Campaign ${campaignId}] Has ${recentlyCompletedRecipients} recently completed recipients (waiting for replies) - not completing`,
    );
    return false;
  }

  // Get final stats for logging
  const recipientStats = await CampaignRecipient.findAll({
    where: { campaignId },
    attributes: [
      "status",
      [sequelize.fn("COUNT", sequelize.col("status")), "count"],
    ],
    group: ["status"],
  });

  const sendStats = await CampaignSend.findAll({
    where: { campaignId },
    attributes: [
      "status",
      [sequelize.fn("COUNT", sequelize.col("status")), "count"],
    ],
    group: ["status"],
  });

  // Check if there are any bounced recipients
  const bouncedCount =
    recipientStats.find((s) => s.status === "bounced")?.dataValues?.count || 0;

  const repliedCount =
    recipientStats.find((s) => s.status === "replied")?.dataValues?.count || 0;

  const completedCount =
    recipientStats.find((s) => s.status === "completed")?.dataValues?.count ||
    0;

  const stoppedCount =
    recipientStats.find((s) => s.status === "stopped")?.dataValues?.count || 0;

  const totalRecipients =
    bouncedCount + repliedCount + completedCount + stoppedCount;

  // Check if all emails have failed (bounced)
  const failedSends = await CampaignSend.count({
    where: {
      campaignId,
      status: "failed",
    },
  });

  const sentSends = await CampaignSend.count({
    where: {
      campaignId,
      status: "sent",
    },
  });

  // If all sends have failed and no active recipients, mark as completed
  const allSendsFailed =
    failedSends > 0 && sentSends === 0 && queuedSends === 0;

  // All emails sent and all recipients in terminal states
  const [updated] = await Campaign.update(
    {
      status: "completed",
      completedAt: new Date(),
    },
    {
      where: {
        id: campaignId,
        status: { [Op.ne]: "completed" },
      },
    },
  );

  if (updated > 0) {
    const summary = {
      total: totalRecipients,
      replied: repliedCount,
      bounced: bouncedCount,
      completed: completedCount,
      stopped: stoppedCount,
      allBounced: sentSends === 0 && bouncedCount > 0 && repliedCount === 0,
    };

    console.log(`[Campaign ${campaignId}] ✅ Campaign marked as completed`);

    // Log final stats
    console.log(
      `[Campaign ${campaignId}] Recipient final stats:`,
      recipientStats.reduce(
        (acc, s) => ({ ...acc, [s.status]: parseInt(s.dataValues.count) }),
        {},
      ),
    );

    console.log(
      `[Campaign ${campaignId}] Send final stats:`,
      sendStats.reduce(
        (acc, s) => ({ ...acc, [s.status]: parseInt(s.dataValues.count) }),
        {},
      ),
    );

    if (summary.allBounced) {
      console.log(
        `[Campaign ${campaignId}] ⚠️ All emails bounced - no successful deliveries`,
      );
    }
  }

  return updated > 0;
}
