import Email from "../models/email.model.js";
import { Op } from "sequelize";
import dayjs from "dayjs";

/**
 * DeliveryGuard helps manage sender health by enforcing:
 * 1. Warm-up limits (starting low and increasing over time)
 * 2. Hard daily caps to prevent domain burning
 * 3. Throttling checks
 */
export class DeliveryGuard {
  // Configurable limits
  static LIMITS = {
    GMAIL: { initial: 30, max: 500, dailyIncrement: 20 },
    OUTLOOK: { initial: 50, max: 1000, dailyIncrement: 30 },
    SMTP: { initial: 100, max: 5000, dailyIncrement: 50 },
  };

  /**
   * Calculates the allowed daily volume for a sender based on age.
   */
  static async getAllowedVolume(sender) {
    const providerKey = sender.provider?.toUpperCase() || "SMTP";
    const config = this.LIMITS[providerKey] || this.LIMITS.SMTP;

    // Calculate account age in days
    const createdDate = dayjs(sender.createdAt);
    const ageInDays = dayjs().diff(createdDate, "day");

    // Volume = Initial + (Age * Increment)
    const calculatedLimit = config.initial + ageInDays * config.dailyIncrement;

    // Cap at provider max
    return Math.min(calculatedLimit, config.max);
  }

  /**
   * Checks if a sender can send more emails today.
   */
  static async canSendToday(sender) {
    const allowedLimit = await this.getAllowedVolume(sender);

    // Count emails sent by this sender in the last 24 hours (UTC)
    const sentTodayCount = await Email.count({
      where: {
        senderId: sender.id,
        createdAt: {
          [Op.gte]: dayjs.utc().startOf("day").toDate(),
        },
        status: ["sent", "delivered", "pending", "queued"], // Include pending to avoid bursts
      },
    });

    return {
      allowed: sentTodayCount < allowedLimit,
      currentCount: sentTodayCount,
      limit: allowedLimit,
      remaining: Math.max(0, allowedLimit - sentTodayCount),
    };
  }
}
