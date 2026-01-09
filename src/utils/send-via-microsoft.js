import axios from "axios";
import { getValidMicrosoftToken } from "./microsoft-token.js";

export const sendViaMicrosoftGraph = async (sender, email) => {
  const token = await getValidMicrosoftToken(sender);

  const res = await axios.post(
    "https://graph.microsoft.com/v1.0/me/sendMail",
    {
      message: {
        subject: email.metadata.subject,
        body: {
          contentType: "HTML",
          content: email.metadata.htmlBody,
        },
        toRecipients: [
          {
            emailAddress: {
              address: email.recipientEmail,
            },
          },
        ],
      },
      saveToSentItems: true,
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    }
  );

  return {
    providerMessageId:
      res.headers["request-id"] ||
      res.headers["client-request-id"] ||
      null,
  };
};
