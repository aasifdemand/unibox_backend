import axios from "axios";

export const getValidMicrosoftToken = async (sender) => {
  const now = Date.now();

  console.log("🔍 Getting Microsoft token for:", {
    id: sender.id,
    email: sender.email,
    hasAccessToken: !!sender.accessToken,
    hasRefreshToken: !!sender.refreshToken,
    expiresAt: sender.expiresAt,
  });

  // token still valid (5 min buffer)
  if (
    sender.accessToken && // ✅ FIXED: was oauthAccessToken
    sender.expiresAt && // ✅ FIXED: was oauthExpiresAt
    new Date(sender.expiresAt).getTime() > now + 5 * 60 * 1000
  ) {
    console.log("✅ Using existing valid token");
    return sender.accessToken; // ✅ FIXED: was oauthAccessToken
  }

  // refresh required
  if (!sender.refreshToken) {
    // ✅ FIXED: was oauthRefreshToken
    console.error("❌ Missing refresh token for Outlook sender:", {
      id: sender.id,
      email: sender.email,
    });
    throw new Error("Missing refresh token for Outlook sender");
  }

  console.log("🔄 Refreshing Microsoft token...");

  const res = await axios.post(
    `https://login.microsoftonline.com/${process.env.MS_TENANT_ID || "common"}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: sender.refreshToken, // ✅ FIXED: was oauthRefreshToken
      scope: "https://graph.microsoft.com/.default",
    }),
  );

  const { access_token, refresh_token, expires_in } = res.data;

  console.log("✅ Token refresh successful:", {
    hasNewAccessToken: !!access_token,
    hasNewRefreshToken: !!refresh_token,
    expires_in,
  });

  await sender.update({
    accessToken: access_token, // ✅ FIXED: was oauthAccessToken
    refreshToken: refresh_token || sender.refreshToken, // ✅ FIXED: was oauthRefreshToken
    expiresAt: new Date(Date.now() + expires_in * 1000), // ✅ FIXED: was oauthExpiresAt
  });

  return access_token;
};
