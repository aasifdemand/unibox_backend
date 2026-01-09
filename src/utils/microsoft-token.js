import axios from "axios";
import Sender from "../models/sender.model.js";


export const getValidMicrosoftToken = async (sender) => {
  if (!sender.oauthAccessToken || !sender.oauthRefreshToken) {
    throw new Error("Microsoft OAuth tokens missing");
  }

  // ⏱ still valid (2 min buffer)
  const bufferMs = 2 * 60 * 1000;
  if (
    sender.oauthExpiresAt &&
    sender.oauthExpiresAt.getTime() - bufferMs > Date.now()
  ) {
    return sender.oauthAccessToken;
  }

  // 🔄 refresh token
  const tokenRes = await axios.post(
    `https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`,
    new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID,
      client_secret: process.env.MS_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: sender.oauthRefreshToken,
      scope: "Mail.Send Mail.Read offline_access",
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  const {
    access_token,
    refresh_token,
    expires_in,
  } = tokenRes.data;

  // 💾 persist new tokens
  await sender.update({
    oauthAccessToken: access_token,
    oauthRefreshToken: refresh_token || sender.oauthRefreshToken,
    oauthExpiresAt: new Date(Date.now() + expires_in * 1000),
  });

  return access_token;
};
