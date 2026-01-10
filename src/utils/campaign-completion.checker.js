import { Op } from "sequelize";
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import CampaignStep from "../models/campaign-step.model.js";
import sequelize from "../config/db.js";

/* =========================
   LOGGER
========================= */
const log = (level, message, meta = {}) => {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      service: "campaign-completion",
      level,
      message,
      ...meta,
    })
  );
};

/* =========================
   CHECK IF CAMPAIGN SHOULD END
========================= */
export async function checkAndCompleteCampaign(campaignId) {
  try {
    const campaign = await Campaign.findByPk(campaignId);
    
    if (!campaign || campaign.status !== "running") {
      log("DEBUG", "Campaign not running or not found", { campaignId });
      return false;
    }

    log("DEBUG", "Checking campaign completion", { 
      campaignId, 
      campaignName: campaign.name 
    });

    /* =========================
       CHECK 1: ALL RECIPIENTS PROCESSED
    ========================= */
    const recipientStats = await CampaignRecipient.findAll({
      where: { campaignId },
      attributes: [
        "status",
        [sequelize.fn("COUNT", sequelize.col("id")), "count"],
      ],
      group: ["status"],
      raw: true,
    });

    const stats = {
      total: 0,
      pending: 0,
      sent: 0,
      replied: 0,
      bounced: 0,
      completed: 0,
      stopped: 0,
    };

    recipientStats.forEach(stat => {
      stats.total += parseInt(stat.count);
      stats[stat.status] = parseInt(stat.count);
    });

    log("DEBUG", "Campaign recipient statistics", {
      campaignId,
      stats
    });

    /* =========================
       CHECK 2: NO MORE PENDING RECIPIENTS
    ========================= */
    if (stats.pending === 0) {
      log("INFO", "🎉 Campaign completed - no pending recipients", {
        campaignId,
        campaignName: campaign.name,
        totalRecipients: stats.total,
        sent: stats.sent,
        replied: stats.replied,
        bounced: stats.bounced
      });

      await completeCampaign(campaign, "completed", {
        stats,
        reason: "All recipients processed"
      });
      return true;
    }

    /* =========================
       CHECK 3: HIGH BOUNCE RATE (>20%)
    ========================= */
    const bounceRate = (stats.bounced / stats.total) * 100;
    if (stats.total > 10 && bounceRate > 20) {
      log("WARN", "🛑 Campaign auto-stopped - high bounce rate", {
        campaignId,
        campaignName: campaign.name,
        bounceRate: bounceRate.toFixed(2),
        bounced: stats.bounced,
        total: stats.total
      });

      await completeCampaign(campaign, "completed", {
        stats,
        reason: `High bounce rate: ${bounceRate.toFixed(2)}%`
      });
      return true;
    }

    /* =========================
       CHECK 4: CAMPAIGN EXPIRED (30 days max)
    ========================= */
    const campaignAgeDays = (Date.now() - new Date(campaign.createdAt).getTime()) / (1000 * 60 * 60 * 24);
    if (campaignAgeDays > 30) {
      log("INFO", "⏰ Campaign expired - 30 day limit reached", {
        campaignId,
        campaignName: campaign.name,
        ageDays: campaignAgeDays.toFixed(1),
        createdAt: campaign.createdAt
      });

      await completeCampaign(campaign, "completed", {
        stats,
        reason: `Campaign expired after ${campaignAgeDays.toFixed(1)} days`
      });
      return true;
    }

    /* =========================
       CHECK 5: ALL STEPS SENT FOR ACTIVE RECIPIENTS
    ========================= */
    const campaignSteps = await CampaignStep.findAll({
      where: { campaignId },
      order: [["stepOrder", "ASC"]],
    });

    if (campaignSteps.length > 0) {
      const maxStep = Math.max(...campaignSteps.map(s => s.stepOrder));
      
      // Check if any recipient needs more steps
      const recipientsNeedingSteps = await CampaignRecipient.count({
        where: {
          campaignId,
          status: { [Op.in]: ["pending", "sent"] },
          currentStep: { [Op.lt]: maxStep + 1 }
        }
      });

      if (recipientsNeedingSteps === 0) {
        log("INFO", "✅ Campaign completed - all steps sent", {
          campaignId,
          campaignName: campaign.name,
          totalSteps: campaignSteps.length,
          maxStep,
          recipientsAtFinalStep: stats.total - recipientsNeedingSteps
        });

        await completeCampaign(campaign, "completed", {
          stats,
          reason: "All campaign steps completed"
        });
        return true;
      }
    }

    // Update campaign progress
    const progress = calculateCampaignProgress(stats, campaignSteps.length);
    await campaign.update({
      progress,
      lastCheckedAt: new Date()
    });

    log("DEBUG", "Campaign still in progress", {
      campaignId,
      progress,
      pending: stats.pending,
      total: stats.total
    });

    return false;

  } catch (err) {
    log("ERROR", "Failed to check campaign completion", {
      campaignId,
      error: err.message,
      stack: err.stack
    });
    return false;
  }
}

/* =========================
   COMPLETE CAMPAIGN
========================= */
async function completeCampaign(campaign, status, metadata = {}) {
  try {
    // Update all pending recipients to "completed"
    await CampaignRecipient.update(
      {
        status: "completed",
        completedAt: new Date()
      },
      {
        where: {
          campaignId: campaign.id,
          status: { [Op.in]: ["pending", "sent"] }
        }
      }
    );

    // Update campaign
    await campaign.update({
      status: "completed",
      endedAt: new Date(),
      endReason: metadata.reason || "auto_completed",
      metadata: {
        ...(campaign.metadata || {}),
        completionStats: metadata.stats,
        completedAt: new Date().toISOString()
      }
    });

    log("INFO", "🏁 Campaign marked as completed", {
      campaignId: campaign.id,
      campaignName: campaign.name,
      status: "completed",
      endReason: metadata.reason,
      totalRecipients: metadata.stats?.total,
      repliedCount: metadata.stats?.replied
    });

  } catch (err) {
    log("ERROR", "Failed to complete campaign", {
      campaignId: campaign.id,
      error: err.message
    });
    throw err;
  }
}

/* =========================
   CALCULATE CAMPAIGN PROGRESS
========================= */
function calculateCampaignProgress(stats, totalSteps = 1) {
  if (stats.total === 0) return 0;

  // Weight factors
  const weights = {
    sent: 0.4,
    replied: 0.3,
    bounced: 0.1,
    completed: 0.2
  };

  let progress = 0;
  
  // Base progress from sent emails
  progress += (stats.sent / stats.total) * weights.sent * 100;
  
  // Additional progress from replies
  progress += (stats.replied / stats.total) * weights.replied * 100;
  
  // Bounced emails count as "processed"
  progress += (stats.bounced / stats.total) * weights.bounced * 100;
  
  // Completed recipients
  progress += (stats.completed / stats.total) * weights.completed * 100;

  // Cap at 100%
  return Math.min(Math.round(progress), 100);
}

/* =========================
   PERIODIC CAMPAIGN CHECKER WORKER
========================= */
export async function runCampaignCompletionCycle() {
  const cycleId = Date.now();
  log("INFO", "🔄 Campaign completion check cycle started", { cycleId });

  try {
    // Find all running campaigns
    const runningCampaigns = await Campaign.findAll({
      where: { 
        status: "running",
        scheduledAt: { [Op.lte]: new Date() } // Only campaigns that should have started
      },
      attributes: ["id", "name", "createdAt"]
    });

    log("DEBUG", "Found running campaigns to check", {
      cycleId,
      count: runningCampaigns.length
    });

    let completedCount = 0;

    for (const campaign of runningCampaigns) {
      try {
        const completed = await checkAndCompleteCampaign(campaign.id);
        if (completed) completedCount++;
      } catch (campaignErr) {
        log("ERROR", "Failed to check specific campaign", {
          campaignId: campaign.id,
          error: campaignErr.message
        });
      }
    }

    log("INFO", "✅ Campaign completion cycle completed", {
      cycleId,
      totalChecked: runningCampaigns.length,
      completedCount,
      durationMs: Date.now() - cycleId
    });

    return { checked: runningCampaigns.length, completed: completedCount };

  } catch (err) {
    log("ERROR", "❌ Campaign completion cycle failed", {
      cycleId,
      error: err.message,
      stack: err.stack
    });
    throw err;
  }
}