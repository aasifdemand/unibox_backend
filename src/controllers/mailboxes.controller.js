import { Op } from "sequelize";
import { google } from "googleapis";
import axios from "axios";

import GmailSender from "../models/gmail-sender.model.js";
import OutlookSender from "../models/outlook-sender.model.js";
import SmtpSender from "../models/smtp-sender.model.js";
import { asyncHandler } from "../helpers/async-handler.js";
import AppError from "../utils/app-error.js";
import { refreshGoogleToken } from "../utils/refresh-google-token.js";
import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";

// =========================
// HELPER: Get Gmail client (Fixed - No hardcoded creds)
// =========================
const getGmailClient = async (sender) => {
  const validToken = await refreshGoogleToken(sender);
  if (!validToken) throw new AppError("Failed to refresh Gmail token", 401);

  // Create OAuth2 client WITHOUT any credentials
  const oauth2Client = new google.auth.OAuth2({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_CALLBACK_URL_SENDER,
  });

  // Only set the tokens we have
  oauth2Client.setCredentials({
    access_token: validToken.accessToken,
    refresh_token: sender.refreshToken,
  });

  return google.gmail({ version: "v1", auth: oauth2Client });
};

// =========================
// DELETE GMAIL MESSAGE (Fixed)
// =========================
export const deleteGmailMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  try {
    const gmail = await getGmailClient(sender);

    // Move to trash first (recommended)
    await gmail.users.messages.trash({
      userId: "me",
      id: messageId,
    });

    await sender.update({ lastUsedAt: new Date() });

    res.json({
      success: true,
      message: "Message moved to trash",
    });
  } catch (error) {
    console.error("Gmail trash error:", {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
    });

    // If trash fails, try permanent delete
    try {
      const gmail = await getGmailClient(sender);
      await gmail.users.messages.delete({
        userId: "me",
        id: messageId,
      });

      await sender.update({ lastUsedAt: new Date() });

      res.json({
        success: true,
        message: "Message deleted permanently",
      });
    } catch (deleteError) {
      console.error("Gmail delete error:", deleteError);

      // Check if token is invalid
      if (deleteError.response?.status === 401) {
        throw new AppError(
          "Gmail authentication failed. Please reconnect your account.",
          401,
        );
      }

      throw new AppError(
        "Failed to delete message: " + (deleteError.message || "Unknown error"),
        500,
      );
    }
  }
});

// =========================
// MARK GMAIL AS READ (Fixed)
// =========================
export const markGmailAsRead = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  try {
    const gmail = await getGmailClient(sender);
    await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: { removeLabelIds: ["UNREAD"] },
    });

    await sender.update({ lastUsedAt: new Date() });

    res.json({ success: true, message: "Message marked as read" });
  } catch (error) {
    console.error("Gmail mark as read error:", error);

    if (error.response?.status === 401) {
      throw new AppError(
        "Gmail authentication failed. Please reconnect your account.",
        401,
      );
    }

    throw new AppError("Failed to mark message as read", 500);
  }
});

// =========================
// GET GMAIL MESSAGES (Fixed with better error handling)
// =========================

export const getGmailMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { pageToken, maxResults = 10, labelIds = ["INBOX"] } = req.query;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  const gmail = await getGmailClient(sender);

  let max = parseInt(maxResults);
  if (isNaN(max) || max < 1) max = 10;
  if (max > 50) max = 50;

  const response = await gmail.users.messages.list({
    userId: "me",
    maxResults: max,
    labelIds: Array.isArray(labelIds) ? labelIds : [labelIds],
    pageToken: pageToken || undefined,
  });

  const messages = [];
  if (response.data.messages) {
    for (const msg of response.data.messages) {
      try {
        const message = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "metadata", // Make sure this is "metadata" or "full"
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });
        messages.push(message.data); // This includes the snippet field
      } catch (err) {
        console.error("Failed to fetch message:", err.message);
      }
    }
  }

  res.json({
    success: true,
    data: {
      messages, // messages array should contain objects with 'snippet' field
      nextPageToken: response.data.nextPageToken || null,
    },
  });
});

// =========================
// GET GMAIL SENT MESSAGES (Fixed)
// =========================
export const getGmailSentMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { pageToken, maxResults = 10 } = req.query;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  try {
    const gmail = await getGmailClient(sender);

    let max = parseInt(maxResults);
    if (isNaN(max) || max < 1) max = 10;
    if (max > 50) max = 50;

    const response = await gmail.users.messages.list({
      userId: "me",
      maxResults: max,
      labelIds: ["SENT"],
      pageToken: pageToken || undefined,
    });

    const messages = [];
    if (response.data.messages) {
      for (const msg of response.data.messages) {
        try {
          const message = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date", "Cc", "Bcc"],
          });
          messages.push(message.data);
        } catch (err) {
          console.error("Failed to fetch sent message:", err.message);
        }
      }
    }

    res.json({
      success: true,
      data: {
        messages,
        nextPageToken: response.data.nextPageToken || null,
      },
    });
  } catch (error) {
    console.error("Gmail get sent messages error:", error);

    if (error.response?.status === 401) {
      throw new AppError(
        "Gmail authentication failed. Please reconnect your account.",
        401,
      );
    }

    throw new AppError("Failed to fetch sent messages", 500);
  }
});

// =========================
// HELPER: Get Outlook token
// =========================
const getOutlookToken = async (sender) => {
  const token = await getValidMicrosoftToken(sender);
  if (!token) throw new AppError("Failed to refresh Outlook token", 401);
  return token;
};

// =========================
// HELPER: Map Gmail label to folder name
// =========================
const mapGmailLabelToFolder = (labelId, labelName) => {
  const folderMap = {
    INBOX: "inbox",
    SENT: "sent",
    DRAFT: "drafts",
    TRASH: "trash",
    SPAM: "spam",
    STARRED: "starred",
    IMPORTANT: "important",
    CHAT: "chats",
    UNREAD: "unread",
    CATEGORY_PERSONAL: "personal",
    CATEGORY_SOCIAL: "social",
    CATEGORY_PROMOTIONS: "promotions",
    CATEGORY_UPDATES: "updates",
    CATEGORY_FORUMS: "forums",
  };

  return (
    folderMap[labelId] ||
    labelName?.toLowerCase().replace(/\s+/g, "-") ||
    labelId
  );
};

// =========================
// HELPER: Map Outlook folder ID to folder type
// =========================
const mapOutlookFolderToType = (folderId, folderName) => {
  const folderMap = {
    inbox: "inbox",
    sentitems: "sent",
    drafts: "drafts",
    deleteditems: "trash",
    junkemail: "spam",
    archive: "archive",
    outbox: "outbox",
  };

  return (
    folderMap[folderId?.toLowerCase()] ||
    folderMap[folderName?.toLowerCase().replace(/\s+/g, "")] ||
    "custom"
  );
};

export const getMailboxes = asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const [gmailSenders, outlookSenders, smtpSenders] = await Promise.all([
    GmailSender.findAll({
      where: { userId },
      attributes: {
        exclude: ["accessToken", "refreshToken", "googleProfile"],
        include: ["googleId"], // ✅ Include googleId for type detection
      },
    }),
    OutlookSender.findAll({
      where: { userId },
      attributes: {
        exclude: ["accessToken", "refreshToken", "microsoftProfile"],
        include: ["microsoftId"], // ✅ Include microsoftId for type detection
      },
    }),
    SmtpSender.findAll({
      where: { userId },
      attributes: {
        exclude: ["smtpPassword", "imapPassword"],
        include: ["smtpHost"], // ✅ Include smtpHost for type detection
      },
    }),
  ]);

  const mailboxes = [
    ...gmailSenders.map((s) => ({
      id: s.id,
      type: "gmail",
      email: s.email,
      displayName: s.displayName,
      domain: s.domain,
      isVerified: s.isVerified,
      isActive: true,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      lastSyncAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
      stats: { dailySent: s.dailySentCount || 0 },
      // Include detection fields
      googleId: s.googleId,
      microsoftId: null,
      smtpHost: null,
    })),
    ...outlookSenders.map((s) => ({
      id: s.id,
      type: "outlook",
      email: s.email,
      displayName: s.displayName,
      domain: s.domain,
      isVerified: s.isVerified,
      isActive: true,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      lastSyncAt: s.lastUsedAt,
      expiresAt: s.expiresAt,
      stats: { dailySent: s.dailySentCount || 0 },
      // Include detection fields
      googleId: null,
      microsoftId: s.microsoftId,
      smtpHost: null,
    })),
    ...smtpSenders.map((s) => ({
      id: s.id,
      type: "smtp",
      email: s.email,
      displayName: s.displayName,
      domain: s.domain,
      isVerified: s.isVerified,
      isActive: s.isActive,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      lastSyncAt: s.lastInboxSyncAt || s.lastUsedAt,
      stats: { dailySent: s.dailySentCount || 0 },
      // Include detection fields
      googleId: null,
      microsoftId: null,
      smtpHost: s.smtpHost,
    })),
  ];

  mailboxes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  res.json({ success: true, data: mailboxes });
});

// =========================
// GET MAILBOX BY ID
// =========================
export const getMailboxById = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const [gmail, outlook, smtp] = await Promise.all([
    GmailSender.findOne({ where: { id: mailboxId, userId } }),
    OutlookSender.findOne({ where: { id: mailboxId, userId } }),
    SmtpSender.findOne({ where: { id: mailboxId, userId } }),
  ]);

  const sender = gmail || outlook || smtp;
  if (!sender) throw new AppError("Mailbox not found", 404);

  const mailbox = {
    id: sender.id,
    type: gmail ? "gmail" : outlook ? "outlook" : "smtp",
    email: sender.email,
    displayName: sender.displayName,
    domain: sender.domain,
    isVerified: sender.isVerified,
    isActive: sender.isActive !== undefined ? sender.isActive : true,
    createdAt: sender.createdAt,
    updatedAt: sender.updatedAt,
    lastSyncAt: sender.lastInboxSyncAt || sender.lastUsedAt,
    expiresAt: sender.expiresAt,
    stats: { dailySent: sender.dailySentCount || 0 },
  };

  res.json({ success: true, data: mailbox });
});
// =========================
// GET OUTLOOK MESSAGES - WITH HTML CONTENT
// =========================
export const getOutlookMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { skipToken, top = 10, folderId = "inbox", search = "" } = req.query;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  const token = await getOutlookToken(sender);

  let pageSize = parseInt(top);
  if (isNaN(pageSize) || pageSize < 1) pageSize = 10;
  if (pageSize > 1000) pageSize = 1000;

  let endpoint;
  if (folderId === "inbox") {
    endpoint = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages";
  } else if (folderId === "sent" || folderId === "sentitems") {
    endpoint =
      "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages";
  } else if (folderId === "drafts") {
    endpoint =
      "https://graph.microsoft.com/v1.0/me/mailFolders/drafts/messages";
  } else if (folderId === "trash" || folderId === "deleteditems") {
    endpoint =
      "https://graph.microsoft.com/v1.0/me/mailFolders/deleteditems/messages";
  } else if (folderId === "spam" || folderId === "junkemail") {
    endpoint =
      "https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages";
  } else if (folderId === "archive") {
    endpoint =
      "https://graph.microsoft.com/v1.0/me/mailFolders/archive/messages";
  } else if (folderId === "outbox") {
    endpoint =
      "https://graph.microsoft.com/v1.0/me/mailFolders/outbox/messages";
  } else {
    endpoint = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages`;
  }

  const params = {
    $top: pageSize,
    $orderby: "receivedDateTime desc",
    $select:
      "id,subject,from,toRecipients,ccRecipients,bccRecipients,body,bodyPreview,conversationId,internetMessageId,receivedDateTime,isRead,parentFolderId,hasAttachments",
    $count: "true",
  };

  if (search) {
    params.$search = `"${search}"`;
  }

  if (skipToken) {
    params.$skiptoken = skipToken;
  }

  try {
    const response = await axios.get(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        // ✅ CHANGE THIS - Request HTML format
        Prefer: 'outlook.body-content-type="html"',
      },
      params,
    });

    let nextSkipToken = null;
    if (response.data["@odata.nextLink"]) {
      const url = new URL(response.data["@odata.nextLink"]);
      nextSkipToken = url.searchParams.get("$skiptoken");
    }

    const messages = (response.data.value || []).map((msg) => ({
      ...msg,
      folder: folderId,
      folderType: mapOutlookFolderToType(folderId),
    }));

    res.json({
      success: true,
      data: {
        messages,
        nextSkipToken,
        nextLink: response.data["@odata.nextLink"] || null,
        count: response.data["@odata.count"] || 0,
        folderId,
        folderType: mapOutlookFolderToType(folderId),
      },
    });
  } catch (error) {
    console.error(
      "Outlook messages fetch error:",
      error.response?.data || error.message,
    );
    throw new AppError("Failed to fetch Outlook messages", 500);
  }
});
// =========================
// GET GMAIL FOLDERS (LABELS WITH COUNTS)
// =========================
export const getGmailLabels = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  const gmail = await getGmailClient(sender);
  const response = await gmail.users.labels.list({ userId: "me" });

  const labels = await Promise.all(
    response.data.labels.map(async (label) => {
      try {
        // Get total count
        const total = await gmail.users.messages.list({
          userId: "me",
          labelIds: [label.id],
          maxResults: 0,
        });

        // Get unread count
        const unread = await gmail.users.messages.list({
          userId: "me",
          labelIds: [label.id],
          q: "is:unread",
          maxResults: 0,
        });

        // Get count for SENT special handling
        let sentCount = 0;
        if (label.id === "SENT") {
          const sent = await gmail.users.messages.list({
            userId: "me",
            labelIds: ["SENT"],
            maxResults: 0,
          });
          sentCount = sent.data.resultSizeEstimate || 0;
        }

        return {
          id: label.id,
          name: label.name,
          type: label.type,
          messageListVisibility: label.messageListVisibility,
          labelListVisibility: label.labelListVisibility,
          folderType: mapGmailLabelToFolder(label.id, label.name),
          totalCount: total.data.resultSizeEstimate || 0,
          unreadCount: unread.data.resultSizeEstimate || 0,
          sentCount: sentCount,
        };
      } catch (error) {
        return {
          id: label.id,
          name: label.name,
          type: label.type,
          folderType: mapGmailLabelToFolder(label.id, label.name),
          totalCount: 0,
          unreadCount: 0,
        };
      }
    }),
  );

  // Sort folders: INBOX first, then SENT, DRAFTS, then others alphabetically
  labels.sort((a, b) => {
    const order = { INBOX: 1, SENT: 2, DRAFTS: 3, TRASH: 4, SPAM: 5 };
    const aOrder = order[a.id] || 6;
    const bOrder = order[b.id] || 6;

    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.name.localeCompare(b.name);
  });

  res.json({ success: true, data: labels });
});

// =========================
// GET OUTLOOK FOLDERS (WITH COUNTS)
// =========================
export const getOutlookFolders = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  const token = await getOutlookToken(sender);

  // Get all mail folders
  const response = await axios.get(
    "https://graph.microsoft.com/v1.0/me/mailFolders",
    {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        $select:
          "id,displayName,unreadItemCount,totalItemCount,childFolderCount,parentFolderId",
        $top: 200,
        $expand:
          "childFolders($select=id,displayName,unreadItemCount,totalItemCount)",
      },
    },
  );

  const processFolder = (folder, parentId = null) => {
    // Get special folder type
    const folderType = mapOutlookFolderToType(folder.id, folder.displayName);

    // Determine if it's a system folder
    const isSystemFolder = [
      "inbox",
      "sentitems",
      "drafts",
      "deleteditems",
      "junkemail",
      "archive",
      "outbox",
    ].includes(folder.id?.toLowerCase());

    return {
      id: folder.id,
      name: folder.displayName,
      folderType: folderType,
      isSystemFolder,
      unreadCount: folder.unreadItemCount || 0,
      totalCount: folder.totalItemCount || 0,
      childFolderCount: folder.childFolderCount || 0,
      parentFolderId: parentId || folder.parentFolderId || null,
      childFolders: folder.childFolders
        ? folder.childFolders.map((child) => processFolder(child, folder.id))
        : [],
    };
  };

  const folders = response.data.value.map((folder) => processFolder(folder));

  // Sort folders: Inbox first, then Sent, Drafts, Deleted, Junk, then others
  folders.sort((a, b) => {
    const order = {
      inbox: 1,
      sentitems: 2,
      drafts: 3,
      deleteditems: 4,
      junkemail: 5,
      archive: 6,
      outbox: 7,
    };

    const aOrder = order[a.id?.toLowerCase()] || 8;
    const bOrder = order[b.id?.toLowerCase()] || 8;

    if (aOrder !== bOrder) return aOrder - bOrder;
    return a.name.localeCompare(b.name);
  });

  res.json({
    success: true,
    data: {
      folders,
      flatList: folders.flatMap((f) => [f, ...(f.childFolders || [])]),
    },
  });
});

// =========================
// GET SINGLE GMAIL MESSAGE
// =========================
export const getGmailMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  const gmail = await getGmailClient(sender);
  const message = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  res.json({ success: true, data: message.data });
});

export const getOutlookMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  const token = await getOutlookToken(sender);
  const response = await axios.get(
    `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        // ✅ CHANGE THIS - Request HTML format instead of text
        Prefer: 'outlook.body-content-type="html"',
      },
      params: {
        // ✅ Also explicitly request HTML
        $select:
          "id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,body,bodyPreview,conversationId,internetMessageId,parentFolderId,hasAttachments",
      },
    },
  );

  res.json({ success: true, data: response.data });
});
// =========================
// GET DRAFT MESSAGES (GMAIL)
// =========================
export const getGmailDrafts = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { pageToken, maxResults = 10 } = req.query;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  const gmail = await getGmailClient(sender);

  let max = parseInt(maxResults);
  if (isNaN(max) || max < 1) max = 10;
  if (max > 50) max = 50;

  const response = await gmail.users.drafts.list({
    userId: "me",
    maxResults: max,
    pageToken: pageToken || undefined,
  });

  const drafts = [];
  if (response.data.drafts) {
    for (const draft of response.data.drafts) {
      try {
        const message = await gmail.users.drafts.get({
          userId: "me",
          id: draft.id,
          format: "full",
        });
        drafts.push({
          id: message.data.id,
          messageId: message.data.message?.id,
          subject:
            message.data.message?.payload?.headers?.find(
              (h) => h.name === "Subject",
            )?.value || "(No Subject)",
          from: message.data.message?.payload?.headers?.find(
            (h) => h.name === "From",
          )?.value,
          to: message.data.message?.payload?.headers?.find(
            (h) => h.name === "To",
          )?.value,
          date: message.data.message?.internalDate,
          snippet: message.data.message?.snippet,
        });
      } catch (err) {
        console.error("Failed to fetch draft:", err.message);
      }
    }
  }

  res.json({
    success: true,
    data: {
      drafts,
      nextPageToken: response.data.nextPageToken || null,
    },
  });
});

// =========================
// GET DRAFT MESSAGES (OUTLOOK)
// =========================
export const getOutlookDrafts = asyncHandler(async (req, res) => {
  req.query.folderId = "drafts";
  return getOutlookMessages(req, res);
});

// =========================
// SYNC GMAIL MAILBOX (WITH SPECIFIC FOLDER)
// =========================
export const syncGmailMailbox = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const { folderId = "INBOX" } = req.query;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  const gmail = await getGmailClient(sender);

  // Test connection by fetching one message from the specified folder
  await gmail.users.messages.list({
    userId: "me",
    maxResults: 1,
    labelIds: [folderId],
  });

  // Update last sync timestamp for the specific folder
  const updateData = { lastInboxSyncAt: new Date() };
  if (folderId === "SENT") updateData.lastSentSyncAt = new Date();
  if (folderId === "DRAFT") updateData.lastDraftsSyncAt = new Date();

  await sender.update(updateData);

  res.json({
    success: true,
    message: `Mailbox synced successfully (${folderId})`,
    data: { syncedAt: new Date(), folderId },
  });
});

// =========================
// SYNC OUTLOOK MAILBOX (WITH SPECIFIC FOLDER)
// =========================
export const syncOutlookMailbox = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const { folderId = "inbox" } = req.query;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  const token = await getOutlookToken(sender);

  // Build endpoint for the specific folder
  let endpoint;
  if (folderId === "inbox") {
    endpoint = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages";
  } else if (folderId === "sentitems") {
    endpoint =
      "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages";
  } else if (folderId === "drafts") {
    endpoint =
      "https://graph.microsoft.com/v1.0/me/mailFolders/drafts/messages";
  } else {
    endpoint = `https://graph.microsoft.com/v1.0/me/mailFolders/${folderId}/messages`;
  }

  await axios.get(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    params: { $top: 1 },
  });

  // Update last sync timestamp
  const updateData = { lastInboxSyncAt: new Date() };
  if (folderId === "sentitems") updateData.lastSentSyncAt = new Date();
  if (folderId === "drafts") updateData.lastDraftsSyncAt = new Date();

  await sender.update(updateData);

  res.json({
    success: true,
    message: `Mailbox synced successfully (${folderId})`,
    data: { syncedAt: new Date(), folderId },
  });
});

// =========================
// MARK OUTLOOK MESSAGE AS READ
// =========================
export const markOutlookAsRead = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  const token = await getOutlookToken(sender);
  await axios.patch(
    `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
    { isRead: true },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    },
  );

  res.json({ success: true, message: "Message marked as read" });
});

// =========================
// DELETE OUTLOOK MESSAGE
// =========================
export const deleteOutlookMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  const token = await getOutlookToken(sender);
  await axios.delete(
    `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    },
  );

  res.json({ success: true, message: "Message deleted successfully" });
});

// =========================
// REFRESH GMAIL TOKEN
// =========================
// =========================
// REFRESH GMAIL TOKEN - FIXED
// =========================
export const refreshGmailToken = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);
  if (!sender.refreshToken)
    throw new AppError("No refresh token available", 400);

  const tokenData = await refreshGoogleToken(sender);

  // ✅ FIX: Check if tokenData is null
  if (!tokenData) {
    throw new AppError(
      "Failed to refresh token - please reconnect your account",
      401,
    );
  }

  res.json({
    success: true,
    message: "Token refreshed",
    data: { expiresAt: tokenData.expiresAt },
  });
});

// =========================
// REFRESH OUTLOOK TOKEN
// =========================
export const refreshOutlookToken = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId },
  });
  if (!sender) throw new AppError("Outlook mailbox not found", 404);
  if (!sender.refreshToken)
    throw new AppError("No refresh token available", 400);

  await getValidMicrosoftToken(sender);
  const updated = await OutlookSender.findByPk(sender.id);
  res.json({
    success: true,
    message: "Token refreshed",
    data: { expiresAt: updated.expiresAt },
  });
});

// =========================
// DISCONNECT GMAIL MAILBOX
// =========================
export const disconnectGmailMailbox = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  await sender.destroy({ force: true });
  res.json({ success: true, message: "Gmail mailbox disconnected" });
});

// =========================
// DISCONNECT OUTLOOK MAILBOX
// =========================
export const disconnectOutlookMailbox = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId },
  });
  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  await sender.destroy({ force: true });
  res.json({ success: true, message: "Outlook mailbox disconnected" });
});

// =========================
// DISCONNECT SMTP MAILBOX
// =========================
export const disconnectSmtpMailbox = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await SmtpSender.findOne({ where: { id: mailboxId, userId } });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  await sender.destroy({ force: true });
  res.json({ success: true, message: "SMTP mailbox disconnected" });
});

// =========================
// GET GMAIL TRASH MESSAGES
// =========================
export const getGmailTrashMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { pageToken, maxResults = 10 } = req.query;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  const gmail = await getGmailClient(sender);

  let max = parseInt(maxResults);
  if (isNaN(max) || max < 1) max = 10;
  if (max > 50) max = 50;

  const response = await gmail.users.messages.list({
    userId: "me",
    maxResults: max,
    labelIds: ["TRASH"],
    pageToken: pageToken || undefined,
  });

  const messages = [];
  if (response.data.messages) {
    for (const msg of response.data.messages) {
      try {
        const message = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });
        messages.push(message.data);
      } catch (err) {
        console.error("Failed to fetch trash message:", err.message);
      }
    }
  }

  res.json({
    success: true,
    data: {
      messages,
      nextPageToken: response.data.nextPageToken || null,
    },
  });
});

// =========================
// GET GMAIL SPAM MESSAGES
// =========================
export const getGmailSpamMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { pageToken, maxResults = 10 } = req.query;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  const gmail = await getGmailClient(sender);

  let max = parseInt(maxResults);
  if (isNaN(max) || max < 1) max = 10;
  if (max > 50) max = 50;

  const response = await gmail.users.messages.list({
    userId: "me",
    maxResults: max,
    labelIds: ["SPAM"],
    pageToken: pageToken || undefined,
  });

  const messages = [];
  if (response.data.messages) {
    for (const msg of response.data.messages) {
      try {
        const message = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });
        messages.push(message.data);
      } catch (err) {
        console.error("Failed to fetch spam message:", err.message);
      }
    }
  }

  res.json({
    success: true,
    data: {
      messages,
      nextPageToken: response.data.nextPageToken || null,
    },
  });
});

// =========================
// GET GMAIL STARRED MESSAGES
// =========================
export const getGmailStarredMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { pageToken, maxResults = 10 } = req.query;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  const gmail = await getGmailClient(sender);

  let max = parseInt(maxResults);
  if (isNaN(max) || max < 1) max = 10;
  if (max > 50) max = 50;

  const response = await gmail.users.messages.list({
    userId: "me",
    maxResults: max,
    labelIds: ["STARRED"],
    pageToken: pageToken || undefined,
  });

  const messages = [];
  if (response.data.messages) {
    for (const msg of response.data.messages) {
      try {
        const message = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });
        messages.push(message.data);
      } catch (err) {
        console.error("Failed to fetch starred message:", err.message);
      }
    }
  }

  res.json({
    success: true,
    data: {
      messages,
      nextPageToken: response.data.nextPageToken || null,
    },
  });
});

// =========================
// GET GMAIL IMPORTANT MESSAGES
// =========================
export const getGmailImportantMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { pageToken, maxResults = 10 } = req.query;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  const gmail = await getGmailClient(sender);

  let max = parseInt(maxResults);
  if (isNaN(max) || max < 1) max = 10;
  if (max > 50) max = 50;

  const response = await gmail.users.messages.list({
    userId: "me",
    maxResults: max,
    labelIds: ["IMPORTANT"],
    pageToken: pageToken || undefined,
  });

  const messages = [];
  if (response.data.messages) {
    for (const msg of response.data.messages) {
      try {
        const message = await gmail.users.messages.get({
          userId: "me",
          id: msg.id,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        });
        messages.push(message.data);
      } catch (err) {
        console.error("Failed to fetch important message:", err.message);
      }
    }
  }

  res.json({
    success: true,
    data: {
      messages,
      nextPageToken: response.data.nextPageToken || null,
    },
  });
});

// =========================
// GET OUTLOOK SENT MESSAGES
// =========================
export const getOutlookSentMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { top = 10, pageToken } = req.query;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  const token = await getOutlookToken(sender);

  const endpoint =
    "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems/messages";

  const params = {
    $top: parseInt(top) || 10,
    $orderby: "receivedDateTime desc",
    $select:
      "id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,bodyPreview",
  };

  if (pageToken) {
    if (pageToken.includes("$skiptoken")) {
      const url = new URL(pageToken);
      params.$skiptoken = url.searchParams.get("$skiptoken");
    } else {
      params.$skiptoken = pageToken;
    }
  }

  const response = await axios.get(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });

  res.json({
    success: true,
    data: {
      messages: response.data.value || [],
      nextPageToken: response.data["@odata.nextLink"] || null,
    },
  });
});

// =========================
// GET OUTLOOK TRASH MESSAGES
// =========================
export const getOutlookTrashMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { top = 10, pageToken } = req.query;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  const token = await getOutlookToken(sender);

  const endpoint =
    "https://graph.microsoft.com/v1.0/me/mailFolders/deleteditems/messages";

  const params = {
    $top: parseInt(top) || 10,
    $orderby: "receivedDateTime desc",
    $select: "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview",
  };

  if (pageToken) {
    if (pageToken.includes("$skiptoken")) {
      const url = new URL(pageToken);
      params.$skiptoken = url.searchParams.get("$skiptoken");
    } else {
      params.$skiptoken = pageToken;
    }
  }

  const response = await axios.get(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });

  res.json({
    success: true,
    data: {
      messages: response.data.value || [],
      nextPageToken: response.data["@odata.nextLink"] || null,
    },
  });
});

// =========================
// GET OUTLOOK SPAM MESSAGES
// =========================
export const getOutlookSpamMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { top = 10, pageToken } = req.query;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  const token = await getOutlookToken(sender);

  const endpoint =
    "https://graph.microsoft.com/v1.0/me/mailFolders/junkemail/messages";

  const params = {
    $top: parseInt(top) || 10,
    $orderby: "receivedDateTime desc",
    $select: "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview",
  };

  if (pageToken) {
    if (pageToken.includes("$skiptoken")) {
      const url = new URL(pageToken);
      params.$skiptoken = url.searchParams.get("$skiptoken");
    } else {
      params.$skiptoken = pageToken;
    }
  }

  const response = await axios.get(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });

  res.json({
    success: true,
    data: {
      messages: response.data.value || [],
      nextPageToken: response.data["@odata.nextLink"] || null,
    },
  });
});

// =========================
// GET OUTLOOK ARCHIVE MESSAGES
// =========================
export const getOutlookArchiveMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { top = 10, pageToken } = req.query;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  const token = await getOutlookToken(sender);

  const endpoint =
    "https://graph.microsoft.com/v1.0/me/mailFolders/archive/messages";

  const params = {
    $top: parseInt(top) || 10,
    $orderby: "receivedDateTime desc",
    $select: "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview",
  };

  if (pageToken) {
    if (pageToken.includes("$skiptoken")) {
      const url = new URL(pageToken);
      params.$skiptoken = url.searchParams.get("$skiptoken");
    } else {
      params.$skiptoken = pageToken;
    }
  }

  const response = await axios.get(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });

  res.json({
    success: true,
    data: {
      messages: response.data.value || [],
      nextPageToken: response.data["@odata.nextLink"] || null,
    },
  });
});

// =========================
// GET OUTLOOK OUTBOX MESSAGES
// =========================
export const getOutlookOutboxMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { top = 10, pageToken } = req.query;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  const token = await getOutlookToken(sender);

  const endpoint =
    "https://graph.microsoft.com/v1.0/me/mailFolders/outbox/messages";

  const params = {
    $top: parseInt(top) || 10,
    $orderby: "receivedDateTime desc",
    $select: "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview",
  };

  if (pageToken) {
    if (pageToken.includes("$skiptoken")) {
      const url = new URL(pageToken);
      params.$skiptoken = url.searchParams.get("$skiptoken");
    } else {
      params.$skiptoken = pageToken;
    }
  }

  const response = await axios.get(endpoint, {
    headers: { Authorization: `Bearer ${token}` },
    params,
  });

  res.json({
    success: true,
    data: {
      messages: response.data.value || [],
      nextPageToken: response.data["@odata.nextLink"] || null,
    },
  });
});
