// controllers/gmail.controller.js
import { google } from "googleapis";
import GmailSender from "../models/gmail-sender.model.js";
import { asyncHandler } from "../helpers/async-handler.js";
import AppError from "../utils/app-error.js";
import { refreshGoogleToken } from "../utils/refresh-google-token.js";
import {
  getCachedData,
  setCachedData,
  deleteCachedData,
  generateCacheKey,
} from "../utils/redis-client.js";
import { withRateLimit, clearMailboxLimiter } from "../utils/rate-limiter.js";

// Cache TTLs (in seconds)
const CACHE_TTL = {
  MESSAGES: 120, // 2 minutes
  LABELS: 300, // 5 minutes
  SINGLE_MESSAGE: 600, // 10 minutes
  DRAFTS: 120, // 2 minutes
  THREADS: 300, // 5 minutes
  PROFILE: 3600, // 1 hour
};

// =========================
// HELPER: Get Gmail client
// =========================
const getGmailClient = async (sender) => {
  const validToken = await refreshGoogleToken(sender);
  if (!validToken) throw new AppError("Failed to refresh Gmail token", 401);

  const oauth2Client = new google.auth.OAuth2({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_CALLBACK_URL_SENDER,
  });

  oauth2Client.setCredentials({
    access_token: validToken.accessToken,
    refresh_token: sender.refreshToken,
  });

  return google.gmail({ version: "v1", auth: oauth2Client });
};

// GET GMAIL MESSAGES - FIXED WITH SUBJECT AS DIRECT PROPERTY
export const getGmailMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { pageToken, maxResults = 10, labelIds = ["INBOX"] } = req.query;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    let max = parseInt(maxResults);
    if (isNaN(max) || max < 1) max = 10;
    if (max > 50) max = 50;

    const labelKey = Array.isArray(labelIds)
      ? labelIds.sort().join(",")
      : labelIds;
    const cacheKey = generateCacheKey(
      "gmail",
      mailboxId,
      "messages",
      labelKey,
      pageToken || "first",
      max,
    );

    // Try cache only for first page
    if (!pageToken) {
      const cached = await getCachedData(cacheKey);
      if (cached) {
        return res.json({
          success: true,
          data: {
            messages: cached.messages,
            nextPageToken: cached.nextPageToken,
            resultSizeEstimate: cached.resultSizeEstimate,
            pageToken: pageToken,
            maxResults: max,
          },
          fromCache: true,
        });
      }
    }

    const gmail = await getGmailClient(sender);

    const response = await gmail.users.messages.list({
      userId: "me",
      maxResults: max,
      labelIds: Array.isArray(labelIds) ? labelIds : [labelIds],
      pageToken: pageToken || undefined,
    });

    const messages = [];
    if (response.data.messages) {
      const fetchPromises = response.data.messages.map(async (msg) => {
        try {
          const message = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date", "Cc", "Bcc"],
          });

          // Extract headers
          const headers = message.data.payload?.headers || [];

          // Helper to find header value
          const getHeader = (name) => {
            const header = headers.find(
              (h) => h.name.toLowerCase() === name.toLowerCase(),
            );
            return header ? header.value : "";
          };

          // Extract values
          const from = getHeader("From");
          const to = getHeader("To");
          const subject = getHeader("Subject") || "(no subject)";
          const date = getHeader("Date");
          const cc = getHeader("Cc");
          const bcc = getHeader("Bcc");

          // Return message with subject as direct property
          return {
            id: message.data.id,
            threadId: message.data.threadId,
            labelIds: message.data.labelIds,
            snippet: message.data.snippet,
            subject: subject, // Subject as direct property
            from: from, // From as direct property
            to: to, // To as direct property
            date: date, // Date as direct property
            cc: cc, // Cc as direct property
            bcc: bcc, // Bcc as direct property
            payload: {
              ...message.data.payload,
              headers: headers, // Keep original headers if needed
            },
            internalDate: message.data.internalDate,
          };
        } catch (err) {
          console.error("Failed to fetch message:", err.message);
          return null;
        }
      });

      const fetchedMessages = await Promise.all(fetchPromises);
      messages.push(...fetchedMessages.filter((m) => m !== null));
    }

    const result = {
      messages,
      nextPageToken: response.data.nextPageToken || null,
      resultSizeEstimate: response.data.resultSizeEstimate || 0,
      pageToken: pageToken || null,
      maxResults: max,
      hasMore: !!response.data.nextPageToken,
    };

    // Update last used timestamp
    sender.update({ lastUsedAt: new Date() }).catch(console.error);

    // Cache only first page
    if (!pageToken) {
      await setCachedData(cacheKey, result, CACHE_TTL.MESSAGES);
    }

    res.json({ success: true, data: result });
  });
});
// =========================
// GET GMAIL SENT MESSAGES
// =========================
export const getGmailSentMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { pageToken, maxResults = 10 } = req.query;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    // Cache for sent messages
    const cacheKey = generateCacheKey(
      "gmail",
      mailboxId,
      "sent",
      pageToken || "first",
      maxResults,
    );

    if (!pageToken) {
      const cached = await getCachedData(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached, fromCache: true });
      }
    }

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

    const result = {
      messages,
      nextPageToken: response.data.nextPageToken || null,
      resultSizeEstimate: response.data.resultSizeEstimate || 0,
    };

    if (!pageToken) {
      await setCachedData(cacheKey, result, CACHE_TTL.MESSAGES);
    }

    res.json({ success: true, data: result });
  });
});

// =========================
// GET GMAIL DRAFT MESSAGES
// =========================
export const getGmailDraftMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { pageToken, maxResults = 10 } = req.query;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    const cacheKey = generateCacheKey(
      "gmail",
      mailboxId,
      "drafts",
      pageToken || "first",
      maxResults,
    );

    if (!pageToken) {
      const cached = await getCachedData(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached, fromCache: true });
      }
    }

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

    const result = {
      drafts,
      nextPageToken: response.data.nextPageToken || null,
      resultSizeEstimate: response.data.resultSizeEstimate || 0,
    };

    if (!pageToken) {
      await setCachedData(cacheKey, result, CACHE_TTL.DRAFTS);
    }

    res.json({ success: true, data: result });
  });
});

// =========================
// GET GMAIL TRASH MESSAGES
// =========================
export const getGmailTrashMessages = asyncHandler(async (req, res) => {
  req.query.labelIds = ["TRASH"];
  return getGmailMessages(req, res);
});

// =========================
// GET GMAIL SPAM MESSAGES
// =========================
export const getGmailSpamMessages = asyncHandler(async (req, res) => {
  req.query.labelIds = ["SPAM"];
  return getGmailMessages(req, res);
});

// =========================
// GET GMAIL STARRED MESSAGES
// =========================
export const getGmailStarredMessages = asyncHandler(async (req, res) => {
  req.query.labelIds = ["STARRED"];
  return getGmailMessages(req, res);
});

// =========================
// GET GMAIL IMPORTANT MESSAGES
// =========================
export const getGmailImportantMessages = asyncHandler(async (req, res) => {
  req.query.labelIds = ["IMPORTANT"];
  return getGmailMessages(req, res);
});

// =========================
// GET GMAIL THREADS
// =========================
export const getGmailThreads = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { pageToken, maxResults = 10, labelIds = ["INBOX"] } = req.query;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    const cacheKey = generateCacheKey(
      "gmail",
      mailboxId,
      "threads",
      pageToken || "first",
      maxResults,
      Array.isArray(labelIds) ? labelIds.sort().join(",") : labelIds,
    );

    if (!pageToken) {
      const cached = await getCachedData(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached, fromCache: true });
      }
    }

    const gmail = await getGmailClient(sender);

    let max = parseInt(maxResults);
    if (isNaN(max) || max < 1) max = 10;
    if (max > 50) max = 50;

    const response = await gmail.users.threads.list({
      userId: "me",
      maxResults: max,
      labelIds: Array.isArray(labelIds) ? labelIds : [labelIds],
      pageToken: pageToken || undefined,
    });

    const threads = [];
    if (response.data.threads) {
      for (const thread of response.data.threads) {
        try {
          const threadData = await gmail.users.threads.get({
            userId: "me",
            id: thread.id,
            format: "metadata",
            metadataHeaders: ["From", "To", "Subject", "Date"],
          });
          threads.push(threadData.data);
        } catch (err) {
          console.error("Failed to fetch thread:", err.message);
        }
      }
    }

    const result = {
      threads,
      nextPageToken: response.data.nextPageToken || null,
      resultSizeEstimate: response.data.resultSizeEstimate || 0,
    };

    if (!pageToken) {
      await setCachedData(cacheKey, result, CACHE_TTL.THREADS);
    }

    res.json({ success: true, data: result });
  });
});

// =========================
// GET GMAIL LABELS (with caching)
// =========================
export const getGmailLabels = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    const cacheKey = generateCacheKey("gmail", mailboxId, "labels");

    // Try cache first
    const cached = await getCachedData(cacheKey);
    if (cached) {
      console.log(`[CACHE HIT] Gmail labels for ${mailboxId}`);
      return res.json({ success: true, data: cached, fromCache: true });
    }

    console.log(`[CACHE MISS] Fetching Gmail labels for ${mailboxId}`);

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

    // Cache the labels
    await setCachedData(cacheKey, labels, CACHE_TTL.LABELS);

    res.json({ success: true, data: labels });
  });
});

// =========================
// GET SINGLE GMAIL MESSAGE (with caching)
// =========================
export const getGmailMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    const cacheKey = generateCacheKey("gmail", mailboxId, "message", messageId);

    // Try cache first
    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const gmail = await getGmailClient(sender);
    const message = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });

    // Cache single message (longer TTL)
    await setCachedData(cacheKey, message.data, CACHE_TTL.SINGLE_MESSAGE);

    res.json({ success: true, data: message.data });
  });
});

// =========================
// GET GMAIL PROFILE
// =========================
export const getGmailProfile = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    const cacheKey = generateCacheKey("gmail", mailboxId, "profile");

    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const gmail = await getGmailClient(sender);
    const profile = await gmail.users.getProfile({
      userId: "me",
    });

    await setCachedData(cacheKey, profile.data, CACHE_TTL.PROFILE);

    res.json({ success: true, data: profile.data });
  });
});

// =========================
// MARK GMAIL AS READ - FIXED WITH VALIDATION
// =========================
export const markGmailAsRead = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      // Validate message ID
      if (!messageId || messageId.startsWith("r")) {
        throw new AppError(
          `Invalid Gmail message ID format: ${messageId}`,
          400,
        );
      }

      const gmail = await getGmailClient(sender);
      await gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: { removeLabelIds: ["UNREAD"] },
      });

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate relevant caches
      await Promise.all([
        deleteCachedData(generateCacheKey("gmail", mailboxId, "messages", "*")),
        deleteCachedData(
          generateCacheKey("gmail", mailboxId, "message", messageId),
        ),
        deleteCachedData(generateCacheKey("gmail", mailboxId, "labels")),
      ]);

      res.json({ success: true, message: "Message marked as read" });
    } catch (error) {
      console.error("Gmail mark as read error:", error);

      if (error.response?.status === 401) {
        throw new AppError(
          "Gmail authentication failed. Please reconnect your account.",
          401,
        );
      }

      if (error.response?.status === 404) {
        throw new AppError("Message not found. It may have been deleted.", 404);
      }

      throw new AppError("Failed to mark message as read", 500);
    }
  });
});

// =========================
// MARK GMAIL AS UNREAD
// =========================
export const markGmailAsUnread = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);
      await gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: { addLabelIds: ["UNREAD"] },
      });

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate relevant caches
      await Promise.all([
        deleteCachedData(generateCacheKey("gmail", mailboxId, "messages", "*")),
        deleteCachedData(
          generateCacheKey("gmail", mailboxId, "message", messageId),
        ),
        deleteCachedData(generateCacheKey("gmail", mailboxId, "labels")),
      ]);

      res.json({ success: true, message: "Message marked as unread" });
    } catch (error) {
      console.error("Gmail mark as unread error:", error);
      throw new AppError("Failed to mark message as unread", 500);
    }
  });
});

// =========================
// DELETE GMAIL MESSAGE (invalidate cache) - FIXED
// =========================
export const deleteGmailMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      // Validate message ID
      if (!messageId || messageId.startsWith("r")) {
        throw new AppError(
          `Invalid Gmail message ID format: ${messageId}`,
          400,
        );
      }

      const gmail = await getGmailClient(sender);

      // First try to move to trash (requires modify scope)
      try {
        await gmail.users.messages.trash({
          userId: "me",
          id: messageId,
        });

        await sender.update({ lastUsedAt: new Date() });

        // Invalidate all caches for this mailbox
        await deleteCachedData(generateCacheKey("gmail", mailboxId, "*"));

        res.json({
          success: true,
          message: "Message moved to trash",
        });
      } catch (trashError) {
        console.error("Gmail trash error:", trashError);

        // If trash fails due to insufficient scopes, return helpful error
        if (
          trashError.code === 403 &&
          trashError.message.includes("insufficient authentication scopes")
        ) {
          throw new AppError(
            "Cannot delete message: Missing required Gmail delete permission. Please reconnect your account with the 'gmail.delete' scope.",
            403,
          );
        }

        throw trashError;
      }
    } catch (error) {
      console.error("Gmail delete error:", {
        message: error.message,
        response: error.response?.data,
        status: error.response?.status,
      });

      // Handle specific error cases
      if (error.code === 403) {
        if (error.message.includes("insufficient authentication scopes")) {
          throw new AppError(
            "Cannot delete message: Insufficient permissions. Please reconnect your Gmail account with full access.",
            403,
          );
        }
        throw new AppError(
          "Access forbidden. Please check your Gmail permissions.",
          403,
        );
      }

      if (error.response?.status === 401) {
        throw new AppError(
          "Gmail authentication failed. Please reconnect your account.",
          401,
        );
      }

      if (error.response?.status === 404) {
        throw new AppError(
          "Message not found. It may have been already deleted.",
          404,
        );
      }

      throw new AppError(
        "Failed to delete message: " + (error.message || "Unknown error"),
        500,
      );
    }
  });
});

// =========================
// PERMANENTLY DELETE GMAIL MESSAGE - FIXED
// =========================
export const permanentlyDeleteGmailMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      // Validate message ID
      if (!messageId || messageId.startsWith("r")) {
        throw new AppError(
          `Invalid Gmail message ID format: ${messageId}`,
          400,
        );
      }

      const gmail = await getGmailClient(sender);

      await gmail.users.messages.delete({
        userId: "me",
        id: messageId,
      });

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate all caches for this mailbox
      await deleteCachedData(generateCacheKey("gmail", mailboxId, "*"));

      res.json({
        success: true,
        message: "Message permanently deleted",
      });
    } catch (error) {
      console.error("Gmail permanent delete error:", error);

      // Check for insufficient scopes
      if (
        error.code === 403 &&
        error.message.includes("insufficient authentication scopes")
      ) {
        throw new AppError(
          "Cannot permanently delete: Missing required 'gmail.delete' scope. Please reconnect your account.",
          403,
        );
      }

      if (error.response?.status === 401) {
        throw new AppError(
          "Gmail authentication failed. Please reconnect your account.",
          401,
        );
      }

      throw new AppError("Failed to permanently delete message", 500);
    }
  });
});

// =========================
// SYNC GMAIL MAILBOX (invalidate cache)
// =========================
export const syncGmailMailbox = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const { folderId = "INBOX" } = req.query;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
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

    // Invalidate cache for this folder
    await Promise.all([
      deleteCachedData(
        generateCacheKey("gmail", mailboxId, "messages", folderId, "*"),
      ),
      deleteCachedData(generateCacheKey("gmail", mailboxId, "labels")),
    ]);

    res.json({
      success: true,
      message: `Mailbox synced successfully (${folderId})`,
      data: { syncedAt: new Date(), folderId },
    });
  });
});

// =========================
// REFRESH GMAIL TOKEN
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
// DISCONNECT GMAIL MAILBOX (clear all caches)
// =========================
export const disconnectGmailMailbox = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  // Clear rate limiter
  clearMailboxLimiter(mailboxId, "gmail");

  // Clear all caches for this mailbox before deleting
  await deleteCachedData(generateCacheKey("gmail", mailboxId, "*"));

  await sender.destroy({ force: true });
  res.json({ success: true, message: "Gmail mailbox disconnected" });
});

// =========================
// SEARCH GMAIL MESSAGES
// =========================
export const searchGmailMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { query, pageToken, maxResults = 10 } = req.query;

  if (!query) throw new AppError("Search query is required", 400);

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    const cacheKey = generateCacheKey(
      "gmail",
      mailboxId,
      "search",
      query,
      pageToken || "first",
      maxResults,
    );

    if (!pageToken) {
      const cached = await getCachedData(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached, fromCache: true });
      }
    }

    const gmail = await getGmailClient(sender);

    let max = parseInt(maxResults);
    if (isNaN(max) || max < 1) max = 10;
    if (max > 50) max = 50;

    const response = await gmail.users.messages.list({
      userId: "me",
      maxResults: max,
      q: query,
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
          console.error("Failed to fetch message:", err.message);
        }
      }
    }

    const result = {
      messages,
      nextPageToken: response.data.nextPageToken || null,
      resultSizeEstimate: response.data.resultSizeEstimate || 0,
    };

    if (!pageToken) {
      await setCachedData(cacheKey, result, CACHE_TTL.MESSAGES);
    }

    res.json({ success: true, data: result });
  });
});

// =========================
// MODIFY MESSAGE LABELS
// =========================
export const modifyGmailMessageLabels = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { addLabelIds = [], removeLabelIds = [] } = req.body;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);
      await gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: { addLabelIds, removeLabelIds },
      });

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate relevant caches
      await Promise.all([
        deleteCachedData(generateCacheKey("gmail", mailboxId, "messages", "*")),
        deleteCachedData(
          generateCacheKey("gmail", mailboxId, "message", messageId),
        ),
        deleteCachedData(generateCacheKey("gmail", mailboxId, "labels")),
      ]);

      res.json({
        success: true,
        message: "Message labels updated",
        data: { addLabelIds, removeLabelIds },
      });
    } catch (error) {
      console.error("Gmail modify labels error:", error);
      throw new AppError("Failed to modify message labels", 500);
    }
  });
});

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
// SEND GMAIL MESSAGE (COMPOSE)
// =========================
export const sendGmailMessage = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { to, cc, bcc, subject, body, html, attachments = [] } = req.body;

  if (!to || !subject || (!body && !html)) {
    throw new AppError("To, subject, and message body are required", 400);
  }

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);

      // Build email content
      const emailLines = [];

      // Headers
      emailLines.push(`To: ${to}`);
      if (cc) emailLines.push(`Cc: ${cc}`);
      if (bcc) emailLines.push(`Bcc: ${bcc}`);
      emailLines.push(`Subject: ${subject}`);
      emailLines.push("MIME-Version: 1.0");
      emailLines.push(
        `Content-Type: ${html ? "text/html" : "text/plain"}; charset="UTF-8"`,
      );
      emailLines.push("");
      emailLines.push(html || body);

      const email = emailLines.join("\r\n");

      // Encode email
      const encodedEmail = Buffer.from(email)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      // Send message
      const response = await gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw: encodedEmail,
        },
      });

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate caches
      await Promise.all([
        deleteCachedData(
          generateCacheKey("gmail", mailboxId, "messages", "SENT", "*"),
        ),
        deleteCachedData(generateCacheKey("gmail", mailboxId, "sent", "*")),
      ]);

      res.json({
        success: true,
        message: "Email sent successfully",
        data: {
          id: response.data.id,
          threadId: response.data.threadId,
          labelIds: response.data.labelIds,
        },
      });
    } catch (error) {
      console.error("Gmail send error:", error);
      throw new AppError("Failed to send email: " + error.message, 500);
    }
  });
});

// =========================
// REPLY TO GMAIL MESSAGE
// =========================
export const replyToGmailMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { body, html, replyAll = false, attachments = [] } = req.body;

  if (!body && !html) {
    throw new AppError("Message body is required", 400);
  }

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);

      // Get original message
      const original = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      const headers = original.data.payload?.headers || [];
      const getHeader = (name) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
          ?.value || "";

      const from = getHeader("From");
      const to = getHeader("To");
      const cc = getHeader("Cc");
      const subject = getHeader("Subject");
      const messageIdHeader = getHeader("Message-ID");
      const references = getHeader("References");

      // Parse from to get reply-to address
      const fromMatch = from.match(/<([^>]+)>/) || [null, from];
      const replyToAddress = fromMatch[1] || from;

      // Build recipients
      const recipients = [replyToAddress];
      if (replyAll) {
        // Add all To recipients except our own address
        const toAddresses = to.split(",").map((t) => t.trim());
        toAddresses.forEach((addr) => {
          if (!addr.includes(sender.email)) recipients.push(addr);
        });

        // Add CC recipients if replying all
        if (cc) {
          const ccAddresses = cc.split(",").map((c) => c.trim());
          ccAddresses.forEach((addr) => {
            if (!addr.includes(sender.email)) recipients.push(addr);
          });
        }
      }

      // Build email content with proper threading
      const emailLines = [];

      // Headers
      emailLines.push(`To: ${recipients.join(", ")}`);
      if (replyAll && cc && !replyAll) {
        emailLines.push(`Cc: ${cc}`);
      }
      emailLines.push(
        `Subject: ${subject.startsWith("Re:") ? subject : `Re: ${subject}`}`,
      );
      emailLines.push(`In-Reply-To: ${messageIdHeader}`);
      emailLines.push(
        `References: ${references ? references + " " + messageIdHeader : messageIdHeader}`,
      );
      emailLines.push("MIME-Version: 1.0");
      emailLines.push(
        `Content-Type: ${html ? "text/html" : "text/plain"}; charset="UTF-8"`,
      );
      emailLines.push("");

      // Add original message quote
      const quote = html
        ? `<br><br><div class="gmail_quote">On ${new Date(parseInt(original.data.internalDate)).toLocaleString()}, ${from} wrote:<br><blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex">${original.data.snippet}</blockquote></div>`
        : `\n\nOn ${new Date(parseInt(original.data.internalDate)).toLocaleString()}, ${from} wrote:\n> ${original.data.snippet.replace(/\n/g, "\n> ")}`;

      emailLines.push(html || body + quote);

      const email = emailLines.join("\r\n");

      // Encode email
      const encodedEmail = Buffer.from(email)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      // Send reply
      const response = await gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw: encodedEmail,
          threadId: original.data.threadId,
        },
      });

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate caches
      await Promise.all([
        deleteCachedData(generateCacheKey("gmail", mailboxId, "messages", "*")),
        deleteCachedData(generateCacheKey("gmail", mailboxId, "sent", "*")),
        deleteCachedData(generateCacheKey("gmail", mailboxId, "threads", "*")),
        deleteCachedData(
          generateCacheKey("gmail", mailboxId, "message", messageId),
        ),
      ]);

      res.json({
        success: true,
        message: "Reply sent successfully",
        data: {
          id: response.data.id,
          threadId: response.data.threadId,
        },
      });
    } catch (error) {
      console.error("Gmail reply error:", error);
      throw new AppError("Failed to send reply: " + error.message, 500);
    }
  });
});

// =========================
// FORWARD GMAIL MESSAGE
// =========================
export const forwardGmailMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { to, body, html, attachments = [] } = req.body;

  if (!to || (!body && !html)) {
    throw new AppError("Recipient and message body are required", 400);
  }

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);

      // Get original message
      const original = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      const headers = original.data.payload?.headers || [];
      const getHeader = (name) =>
        headers.find((h) => h.name.toLowerCase() === name.toLowerCase())
          ?.value || "";

      const from = getHeader("From");
      const subject = getHeader("Subject");
      const date = new Date(
        parseInt(original.data.internalDate),
      ).toLocaleString();

      // Build forwarded content
      const forwardedBody = html
        ? `<br><br><b>Forwarded message</b><br>
           <b>From:</b> ${from}<br>
           <b>Date:</b> ${date}<br>
           <b>Subject:</b> ${subject}<br>
           <b>To:</b> ${to}<br><br>
           ${html}`
        : `\n\n-------- Forwarded message --------\nFrom: ${from}\nDate: ${date}\nSubject: ${subject}\nTo: ${to}\n\n${body || original.data.snippet}`;

      // Build email
      const emailLines = [];
      emailLines.push(`To: ${to}`);
      emailLines.push(`Subject: Fwd: ${subject}`);
      emailLines.push("MIME-Version: 1.0");
      emailLines.push(
        `Content-Type: ${html ? "text/html" : "text/plain"}; charset="UTF-8"`,
      );
      emailLines.push("");
      emailLines.push(html ? forwardedBody : forwardedBody);

      const email = emailLines.join("\r\n");

      // Encode email
      const encodedEmail = Buffer.from(email)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      // Send forward
      const response = await gmail.users.messages.send({
        userId: "me",
        requestBody: {
          raw: encodedEmail,
        },
      });

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate caches
      await Promise.all([
        deleteCachedData(
          generateCacheKey("gmail", mailboxId, "messages", "SENT", "*"),
        ),
        deleteCachedData(generateCacheKey("gmail", mailboxId, "sent", "*")),
      ]);

      res.json({
        success: true,
        message: "Message forwarded successfully",
        data: {
          id: response.data.id,
          threadId: response.data.threadId,
        },
      });
    } catch (error) {
      console.error("Gmail forward error:", error);
      throw new AppError("Failed to forward message: " + error.message, 500);
    }
  });
});

// =========================
// CREATE GMAIL DRAFT
// =========================
export const createGmailDraft = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { to, cc, bcc, subject, body, html, attachments = [] } = req.body;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);

      // Build email content
      const emailLines = [];

      if (to) emailLines.push(`To: ${to}`);
      if (cc) emailLines.push(`Cc: ${cc}`);
      if (bcc) emailLines.push(`Bcc: ${bcc}`);
      if (subject) emailLines.push(`Subject: ${subject}`);
      emailLines.push("MIME-Version: 1.0");
      emailLines.push(
        `Content-Type: ${html ? "text/html" : "text/plain"}; charset="UTF-8"`,
      );
      emailLines.push("");
      emailLines.push(html || body || "");

      const email = emailLines.join("\r\n");

      // Encode email
      const encodedEmail = Buffer.from(email)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      // Create draft
      const response = await gmail.users.drafts.create({
        userId: "me",
        requestBody: {
          message: {
            raw: encodedEmail,
          },
        },
      });

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate drafts cache
      await deleteCachedData(
        generateCacheKey("gmail", mailboxId, "drafts", "*"),
      );

      res.json({
        success: true,
        message: "Draft created successfully",
        data: {
          id: response.data.id,
          messageId: response.data.message?.id,
          threadId: response.data.message?.threadId,
        },
      });
    } catch (error) {
      console.error("Gmail create draft error:", error);
      throw new AppError("Failed to create draft: " + error.message, 500);
    }
  });
});

// =========================
// UPDATE GMAIL DRAFT
// =========================
export const updateGmailDraft = asyncHandler(async (req, res) => {
  const { mailboxId, draftId } = req.params;
  const userId = req.user.id;
  const { to, cc, bcc, subject, body, html, attachments = [] } = req.body;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);

      // Build email content
      const emailLines = [];

      if (to) emailLines.push(`To: ${to}`);
      if (cc) emailLines.push(`Cc: ${cc}`);
      if (bcc) emailLines.push(`Bcc: ${bcc}`);
      if (subject) emailLines.push(`Subject: ${subject}`);
      emailLines.push("MIME-Version: 1.0");
      emailLines.push(
        `Content-Type: ${html ? "text/html" : "text/plain"}; charset="UTF-8"`,
      );
      emailLines.push("");
      emailLines.push(html || body || "");

      const email = emailLines.join("\r\n");

      // Encode email
      const encodedEmail = Buffer.from(email)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");

      // Update draft
      const response = await gmail.users.drafts.update({
        userId: "me",
        id: draftId,
        requestBody: {
          message: {
            raw: encodedEmail,
          },
        },
      });

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate drafts cache
      await deleteCachedData(
        generateCacheKey("gmail", mailboxId, "drafts", "*"),
      );

      res.json({
        success: true,
        message: "Draft updated successfully",
        data: {
          id: response.data.id,
          messageId: response.data.message?.id,
          threadId: response.data.message?.threadId,
        },
      });
    } catch (error) {
      console.error("Gmail update draft error:", error);
      throw new AppError("Failed to update draft: " + error.message, 500);
    }
  });
});

// =========================
// DELETE GMAIL DRAFT
// =========================
export const deleteGmailDraft = asyncHandler(async (req, res) => {
  const { mailboxId, draftId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);

      await gmail.users.drafts.delete({
        userId: "me",
        id: draftId,
      });

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate drafts cache
      await deleteCachedData(
        generateCacheKey("gmail", mailboxId, "drafts", "*"),
      );

      res.json({
        success: true,
        message: "Draft deleted successfully",
      });
    } catch (error) {
      console.error("Gmail delete draft error:", error);
      throw new AppError("Failed to delete draft: " + error.message, 500);
    }
  });
});

// =========================
// SEND GMAIL DRAFT
// =========================
export const sendGmailDraft = asyncHandler(async (req, res) => {
  const { mailboxId, draftId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);

      const response = await gmail.users.drafts.send({
        userId: "me",
        requestBody: {
          id: draftId,
        },
      });

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate caches
      await Promise.all([
        deleteCachedData(generateCacheKey("gmail", mailboxId, "drafts", "*")),
        deleteCachedData(
          generateCacheKey("gmail", mailboxId, "messages", "SENT", "*"),
        ),
        deleteCachedData(generateCacheKey("gmail", mailboxId, "sent", "*")),
      ]);

      res.json({
        success: true,
        message: "Draft sent successfully",
        data: {
          id: response.data.id,
          threadId: response.data.threadId,
        },
      });
    } catch (error) {
      console.error("Gmail send draft error:", error);
      throw new AppError("Failed to send draft: " + error.message, 500);
    }
  });
});

// =========================
// TOGGLE GMAIL STARRED
// =========================
export const toggleGmailStarred = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { starred } = req.body;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);

      await gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: {
          addLabelIds: starred ? ["STARRED"] : [],
          removeLabelIds: starred ? [] : ["STARRED"],
        },
      });

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate caches
      await Promise.all([
        deleteCachedData(generateCacheKey("gmail", mailboxId, "messages", "*")),
        deleteCachedData(
          generateCacheKey("gmail", mailboxId, "message", messageId),
        ),
      ]);

      res.json({
        success: true,
        message: starred ? "Message starred" : "Message unstarred",
        data: { starred },
      });
    } catch (error) {
      console.error("Gmail toggle star error:", error);
      throw new AppError("Failed to toggle star: " + error.message, 500);
    }
  });
});

// =========================
// TOGGLE GMAIL IMPORTANT
// =========================
export const toggleGmailImportant = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { important } = req.body;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);

      await gmail.users.messages.modify({
        userId: "me",
        id: messageId,
        requestBody: {
          addLabelIds: important ? ["IMPORTANT"] : [],
          removeLabelIds: important ? [] : ["IMPORTANT"],
        },
      });

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate caches
      await Promise.all([
        deleteCachedData(generateCacheKey("gmail", mailboxId, "messages", "*")),
        deleteCachedData(
          generateCacheKey("gmail", mailboxId, "message", messageId),
        ),
      ]);

      res.json({
        success: true,
        message: important
          ? "Message marked important"
          : "Message unmarked important",
        data: { important },
      });
    } catch (error) {
      console.error("Gmail toggle important error:", error);
      throw new AppError("Failed to toggle important: " + error.message, 500);
    }
  });
});

// =========================
// GET GMAIL ATTACHMENT
// =========================
export const getGmailAttachment = asyncHandler(async (req, res) => {
  const { mailboxId, messageId, attachmentId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);

      const attachment = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: messageId,
        id: attachmentId,
      });

      // Decode attachment data
      const data = attachment.data.data;
      const buffer = Buffer.from(data, "base64");

      // Set appropriate headers
      res.setHeader("Content-Type", attachment.data.mimeType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${attachment.data.filename}"`,
      );
      res.setHeader("Content-Length", buffer.length);

      res.send(buffer);
    } catch (error) {
      console.error("Gmail get attachment error:", error);
      throw new AppError("Failed to get attachment: " + error.message, 500);
    }
  });
});

// =========================
// GET GMAIL MESSAGE ATTACHMENTS - FIXED
// =========================
export const getGmailMessageAttachments = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);

      // LOG THE MESSAGE ID TO DEBUG
      console.log("Fetching attachments for message ID:", messageId);

      // Validate message ID format (should not have 'r' prefix)
      if (!messageId || messageId.startsWith("r")) {
        throw new AppError(
          `Invalid Gmail message ID format: ${messageId}`,
          400,
        );
      }

      const message = await gmail.users.messages.get({
        userId: "me",
        id: messageId,
        format: "full",
      });

      const attachments = [];

      // Helper to extract attachments from parts
      const extractAttachments = (parts) => {
        if (!parts) return;

        for (const part of parts) {
          if (part.filename && part.filename.length > 0) {
            if (part.body && part.body.attachmentId) {
              attachments.push({
                filename: part.filename,
                mimeType: part.mimeType,
                size: part.body.size,
                attachmentId: part.body.attachmentId,
                messageId: messageId,
              });
            }
          }

          if (part.parts) {
            extractAttachments(part.parts);
          }
        }
      };

      if (message.data.payload) {
        if (message.data.payload.parts) {
          extractAttachments(message.data.payload.parts);
        } else if (message.data.payload.filename) {
          // Single part attachment
          attachments.push({
            filename: message.data.payload.filename,
            mimeType: message.data.payload.mimeType,
            size: message.data.payload.body?.size,
            attachmentId: message.data.payload.body?.attachmentId,
            messageId: messageId,
          });
        }
      }

      res.json({
        success: true,
        data: attachments,
      });
    } catch (error) {
      console.error("Gmail get attachments error:", error);

      // More specific error message
      if (error.code === 400 || error.response?.status === 400) {
        throw new AppError(
          `Invalid Gmail message ID: ${messageId}. Please use the correct Gmail message ID format.`,
          400,
        );
      }

      throw new AppError("Failed to get attachments: " + error.message, 500);
    }
  });
});

// =========================
// BATCH GMAIL OPERATIONS
// =========================
export const batchGmailOperations = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { messageIds, operation, labelIds = [] } = req.body;

  if (!messageIds || !messageIds.length || !operation) {
    throw new AppError("Message IDs and operation are required", 400);
  }

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    try {
      const gmail = await getGmailClient(sender);
      const results = [];

      for (const messageId of messageIds) {
        try {
          let result;

          switch (operation) {
            case "delete":
              await gmail.users.messages.trash({
                userId: "me",
                id: messageId,
              });
              result = { messageId, status: "deleted" };
              break;

            case "mark-read":
              await gmail.users.messages.modify({
                userId: "me",
                id: messageId,
                requestBody: { removeLabelIds: ["UNREAD"] },
              });
              result = { messageId, status: "marked-read" };
              break;

            case "mark-unread":
              await gmail.users.messages.modify({
                userId: "me",
                id: messageId,
                requestBody: { addLabelIds: ["UNREAD"] },
              });
              result = { messageId, status: "marked-unread" };
              break;

            case "star":
              await gmail.users.messages.modify({
                userId: "me",
                id: messageId,
                requestBody: { addLabelIds: ["STARRED"] },
              });
              result = { messageId, status: "starred" };
              break;

            case "unstar":
              await gmail.users.messages.modify({
                userId: "me",
                id: messageId,
                requestBody: { removeLabelIds: ["STARRED"] },
              });
              result = { messageId, status: "unstarred" };
              break;

            case "add-labels":
              if (labelIds.length) {
                await gmail.users.messages.modify({
                  userId: "me",
                  id: messageId,
                  requestBody: { addLabelIds: labelIds },
                });
              }
              result = { messageId, status: "labels-added", labelIds };
              break;

            case "remove-labels":
              if (labelIds.length) {
                await gmail.users.messages.modify({
                  userId: "me",
                  id: messageId,
                  requestBody: { removeLabelIds: labelIds },
                });
              }
              result = { messageId, status: "labels-removed", labelIds };
              break;

            case "move-to-trash":
              await gmail.users.messages.trash({
                userId: "me",
                id: messageId,
              });
              result = { messageId, status: "moved-to-trash" };
              break;

            case "move-to-inbox":
              await gmail.users.messages.modify({
                userId: "me",
                id: messageId,
                requestBody: {
                  addLabelIds: ["INBOX"],
                  removeLabelIds: ["TRASH", "SPAM"],
                },
              });
              result = { messageId, status: "moved-to-inbox" };
              break;

            default:
              throw new AppError(`Unknown operation: ${operation}`, 400);
          }

          results.push(result);
        } catch (err) {
          results.push({
            messageId,
            status: "failed",
            error: err.message,
          });
        }
      }

      await sender.update({ lastUsedAt: new Date() });

      // Invalidate caches
      await Promise.all([
        deleteCachedData(generateCacheKey("gmail", mailboxId, "messages", "*")),
        deleteCachedData(generateCacheKey("gmail", mailboxId, "labels")),
      ]);

      res.json({
        success: true,
        message: `Batch operation '${operation}' completed`,
        data: { results },
      });
    } catch (error) {
      console.error("Gmail batch operation error:", error);
      throw new AppError(
        "Failed to perform batch operation: " + error.message,
        500,
      );
    }
  });
});
