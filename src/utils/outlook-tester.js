export const testOutlookConnection = async ({ accessToken, email }) => {
  try {
    // Test Outlook connection using Microsoft Graph API
    const response = await fetch("https://graph.microsoft.com/v1.0/me", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Outlook API error: ${response.statusText}`);
    }

    const data = await response.json();

    return {
      success: true,
      email: data.mail || data.userPrincipalName,
      message: "Outlook connection successful",
    };
  } catch (error) {
    throw new Error(`Outlook connection failed: ${error.message}`);
  }
};
