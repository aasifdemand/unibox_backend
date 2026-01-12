import { Op } from "sequelize";
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";

export async function tryCompleteCampaign(campaignId) {
  const remaining = await CampaignRecipient.count({
    where: {
      campaignId,
      status: {
        [Op.notIn]: ["completed", "replied", "bounced", "stopped"],
      },
    },
  });

  if (remaining > 0) return false;

  await Campaign.update(
    {
      status: "completed",
      completedAt: new Date(),
    },
    { where: { id: campaignId, status: { [Op.ne]: "completed" } } }
  );

  return true;
}
