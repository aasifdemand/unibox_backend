import { asyncHandler } from "../helpers/async-handler.js";
import Email from "../models/email.model.js";
import Campaign from "../models/campaign.model.js"; // ✅ Make sure this is imported
import sequelize from "../config/db.js"; // ✅ Add this if not present

export const trackOpen = asyncHandler(async (req, res) => {
  const { emailId } = req.params;

  try {
    // Find the email and update openedAt
    const email = await Email.findByPk(emailId);

    if (email && !email.openedAt) {
      await email.update({
        openedAt: new Date(), // ✅ This sets openedAt
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      });

      // Also update campaign stats
      await Campaign.increment("totalOpens", {
        by: 1,
        where: { id: email.campaignId },
      });

      console.log(`✅ Open tracked for email ${emailId}`);
    }

    // Return 1x1 transparent GIF
    res.writeHead(200, {
      "Content-Type": "image/gif",
      "Content-Length": "43",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
    res.end(
      Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      ),
    );
  } catch (error) {
    console.error("Error tracking open:", error);
    // Still return the pixel even if tracking fails
    res.writeHead(200, {
      "Content-Type": "image/gif",
      "Content-Length": "43",
    });
    res.end(
      Buffer.from(
        "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
        "base64",
      ),
    );
  }
});
export const trackClick = asyncHandler(async (req, res) => {
  const { emailId } = req.params;
  const { url } = req.query;

  if (!url) return res.redirect("/");

  const decodedUrl = decodeURIComponent(url);

  try {
    // Find the email and update clickedAt
    const email = await Email.findByPk(emailId);

    if (email) {
      await email.update({
        clickedAt: email.clickedAt || new Date(), // ✅ This sets clickedAt
        clickCount: sequelize.literal("clickCount + 1"),
        userAgent: req.headers["user-agent"],
        ipAddress: req.ip,
      });

      // Also update campaign stats
      await Campaign.increment("totalClicks", {
        by: 1,
        where: { id: email.campaignId },
      });

      console.log(`✅ Click tracked for email ${emailId} to ${decodedUrl}`);
    }
  } catch (error) {
    console.error("Error tracking click:", error);
    // Still redirect even if tracking fails
  }

  // Redirect to original URL
  res.redirect(302, decodedUrl);
});
