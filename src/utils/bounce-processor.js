import Email from "../models/email.model.js";
import CampaignRecipient from "../models/campaign-recipient.model.js";
import GlobalEmailRegistry from "../models/global-email-registry.model.js";
import { Campaign } from "../models/index.js";

/**
 * BounceProcessor handles incoming bounce notifications from providers (SES, SendGrid, Mailgun).
 */
export class BounceProcessor {
  /**
   * Processes a bounce for a specific email.
   * @param {string} emailId - Internal Email UUID
   * @param {string} type - 'hard' or 'soft'
   * @param {string} reason - Diagnostic code
   */
  static async handleBounce(emailId, type = "hard", reason = "") {
    try {
      const email = await Email.findByPk(emailId);
      if (!email) return;

      // 1. Update Email status
      await email.update({
        status: "bounced",
        bouncedAt: new Date(),
        bounceType: type,
        bounceReason: reason,
      });

      // 2. Stop Recipient in current campaign
      if (email.recipientId) {
        await CampaignRecipient.update(
          { status: "stopped", nextRunAt: null },
          { where: { id: email.recipientId } }
        );
      }

      // 3. Global Blacklist (Hard Bounce)
      if (type === "hard" && email.recipientEmail) {
        await GlobalEmailRegistry.upsert({
          normalizedEmail: email.recipientEmail.toLowerCase(),
          verificationStatus: "invalid", // Treat as dead
          lastSeenAt: new Date(),
        });
      }

      // 4. Update Campaign Stats
      if (email.campaignId) {
        await Campaign.increment("totalBounces", {
          by: 1,
          where: { id: email.campaignId },
        });
      }

      console.log(`❌ Bounce processed: ${email.recipientEmail} (${type})`);
    } catch (err) {
      console.error("🔥 Bounce processing failed:", err.message);
    }
  }
}
