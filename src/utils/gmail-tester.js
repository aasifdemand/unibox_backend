import { google } from "googleapis";

export const testGmailConnection = async ({ accessToken, email }) => {
  try {
    const oauth2Client = new google.auth.OAuth2();
    oauth2Client.setCredentials({ access_token: accessToken });

    const gmail = google.gmail({ version: "v1", auth: oauth2Client });

    // Test by getting profile
    const response = await gmail.users.getProfile({ userId: "me" });

    return {
      success: true,
      email: response.data.emailAddress,
      message: "Gmail connection successful",
    };
  } catch (error) {
    throw new Error(`Gmail connection failed: ${error.message}`);
  }
};
