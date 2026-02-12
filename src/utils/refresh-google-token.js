import { google } from "googleapis";

export const refreshGoogleToken = async (sender) => {
  try {
    if (!sender.refreshToken) {
      throw new Error("No refresh token available");
    }

    // ✅ ALWAYS use client credentials - this is REQUIRED
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_CALLBACK_URL_SENDER,
    );

    oauth2Client.setCredentials({
      refresh_token: sender.refreshToken,
    });

    const { credentials } = await oauth2Client.refreshAccessToken();

    await sender.update({
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token || sender.refreshToken,
      expiresAt: new Date(
        Date.now() + (credentials.expiry_date || 3600 * 1000),
      ),
      lastUsedAt: new Date(),
    });

    return {
      accessToken: credentials.access_token,
      expiresAt: new Date(
        Date.now() + (credentials.expiry_date || 3600 * 1000),
      ),
    };
  } catch (error) {
    console.error("Token refresh error:", {
      message: error.message,
      response: error.response?.data,
    });
    return null;
  }
};
