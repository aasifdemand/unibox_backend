import axios from "axios";


export const getValidMicrosoftToken = async (sender) => {
  const now = Date.now();

  // token still valid (5 min buffer)
  if (
    sender.oauthAccessToken &&
    sender.oauthExpiresAt &&
    new Date(sender.oauthExpiresAt).getTime() > now + 5 * 60 * 1000
  ) {
    return sender.oauthAccessToken;
  }

  // refresh required
  if (!sender.oauthRefreshToken) {
    throw new Error("Missing refresh token for Outlook sender");
  }

  const res = await axios.post(
    `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: sender.oauthRefreshToken,
      scope: "https://graph.microsoft.com/.default",
    })
  );

  const {
    access_token,
    refresh_token,
    expires_in,
  } = res.data;

  await sender.update({
    oauthAccessToken: access_token,
    oauthRefreshToken: refresh_token || sender.oauthRefreshToken,
    oauthExpiresAt: new Date(Date.now() + expires_in * 1000),
  });

  return access_token;
};
