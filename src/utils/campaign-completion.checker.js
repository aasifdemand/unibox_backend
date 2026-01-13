import { Op } from "sequelize";
import Campaign from "../models/campaign.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";

export async function tryCompleteCampaign(campaignId) {
  const remaining = await CampaignRecipient.count({
    where: {
      campaignId,
      status: {
        [Op.in]: ["pending", "active"],
      },
    },
  });

  if (remaining > 0) {
    return false;
  }

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
    }
  );

  return updated > 0;
}
