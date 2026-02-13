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

// =========================
// GET GMAIL MESSAGES (with caching)
// =========================
export const getGmailMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { pageToken, maxResults = 10, labelIds = ["INBOX"] } = req.query;

  const sender = await GmailSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
  });
  if (!sender) throw new AppError("Gmail mailbox not found", 404);

  return withRateLimit(mailboxId, "gmail", async () => {
    // Generate cache key
    const labelKey = Array.isArray(labelIds)
      ? labelIds.sort().join(",")
      : labelIds;
    const cacheKey = generateCacheKey(
      "gmail",
      mailboxId,
      "messages",
      labelKey,
      pageToken || "first",
      maxResults,
    );

    // Try to get from cache (only for first page)
    if (!pageToken) {
      const cached = await getCachedData(cacheKey);
      if (cached) {
        console.log(
          `[CACHE HIT] Gmail messages for ${mailboxId} - ${labelKey}`,
        );
        return res.json({ success: true, data: cached, fromCache: true });
      }
    }

    console.log(
      `[CACHE MISS] Fetching Gmail messages for ${mailboxId} - ${labelKey}`,
    );

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

    // Update last used timestamp (don't await)
    sender.update({ lastUsedAt: new Date() }).catch(console.error);

    // Cache if it's first page
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
// MARK GMAIL AS READ (invalidate cache)
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
// DELETE GMAIL MESSAGE (invalidate cache)
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
      const gmail = await getGmailClient(sender);

      // Move to trash first (recommended)
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

        // Invalidate all caches for this mailbox
        await deleteCachedData(generateCacheKey("gmail", mailboxId, "*"));

        res.json({
          success: true,
          message: "Message deleted permanently",
        });
      } catch (deleteError) {
        console.error("Gmail delete error:", deleteError);

        if (deleteError.response?.status === 401) {
          throw new AppError(
            "Gmail authentication failed. Please reconnect your account.",
            401,
          );
        }

        throw new AppError(
          "Failed to delete message: " +
            (deleteError.message || "Unknown error"),
          500,
        );
      }
    }
  });
});

// =========================
// PERMANENTLY DELETE GMAIL MESSAGE
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
