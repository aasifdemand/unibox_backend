// controllers/outlook.controller.js
import axios from "axios";
import OutlookSender from "../models/outlook-sender.model.js";
import { asyncHandler } from "../helpers/async-handler.js";
import AppError from "../utils/app-error.js";
import { getValidMicrosoftToken } from "../utils/get-valid-microsoft-token.js";
import {
  getCachedData,
  setCachedData,
  deleteCachedData,
  generateCacheKey,
} from "../utils/redis-client.js";
import { withRateLimit, clearMailboxLimiter } from "../utils/rate-limiter.js";

// Cache TTLs
const CACHE_TTL = {
  MESSAGES: 300, // 5 minutes (increased from 2)
  FOLDERS: 600, // 10 minutes (increased from 5)
  SINGLE_MESSAGE: 1800, // 30 minutes (increased from 10)
};

// =========================
// OUTLOOK CLIENT CACHE (for connection pooling)
// =========================
const outlookClients = new Map();

/**
 * Get or create Outlook client with token caching
 */
const getOutlookClient = async (sender) => {
  const cacheKey = `outlook_client_${sender.id}`;

  // Check for cached client
  if (outlookClients.has(cacheKey)) {
    const { client, expiry } = outlookClients.get(cacheKey);
    if (Date.now() < expiry) {
      return client;
    }
  }

  const token = await getValidMicrosoftToken(sender);
  if (!token) throw new AppError("Failed to refresh Outlook token", 401);

  // Create axios instance with default headers
  const client = axios.create({
    baseURL: "https://graph.microsoft.com/v1.0",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 30000, // 30 second timeout
  });

  // Add response interceptor for error handling
  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      if (error.response?.status === 401) {
        // Token expired - clear from cache
        outlookClients.delete(cacheKey);
      }
      return Promise.reject(error);
    },
  );

  // Cache client for 50 minutes (tokens usually last 60 min)
  outlookClients.set(cacheKey, {
    client,
    expiry: Date.now() + 50 * 60 * 1000,
  });

  return client;
};

// =========================
// BATCH MESSAGE FETCHER
// =========================
const batchFetchMessages = async (
  client,
  messageIds,
  fields = "id,subject,from,toRecipients,receivedDateTime,isRead,bodyPreview",
) => {
  if (!messageIds?.length) return [];

  // Microsoft Graph doesn't have batch get for messages, so we fetch in parallel
  const batchSize = 10;
  const results = [];

  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);
    const promises = batch.map((msg) =>
      client
        .get(`/me/messages/${msg.id}`, {
          params: { $select: fields },
        })
        .catch((err) => {
          console.error(`Failed to fetch message ${msg.id}:`, err.message);
          return null;
        }),
    );

    const batchResults = await Promise.all(promises);
    results.push(...batchResults.filter((r) => r !== null).map((r) => r.data));
  }

  return results;
};

// =========================
// GET OUTLOOK MESSAGES (with caching)
// =========================
export const getOutlookMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { skipToken, top = 10, folderId = "inbox", search = "" } = req.query;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: [
      "id",
      "email",
      "refreshToken",
      "accessToken",
      "expiresAt",
      "lastUsedAt",
    ],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    // Generate cache key
    const cacheKey = generateCacheKey(
      "outlook",
      mailboxId,
      "messages",
      folderId,
      skipToken || "first",
      top,
      search || "nosearch",
    );

    // Try cache first with stale-while-revalidate pattern
    if (!skipToken && !search) {
      const cached = await getCachedData(cacheKey);
      if (cached) {
        // Check for stale cache to return immediately while refreshing
        const staleKey = `${cacheKey}:stale`;
        const staleCache = await getCachedData(staleKey);

        if (staleCache) {
          // Trigger background refresh
          setTimeout(() => {
            refreshOutlookMessagesInBackground(
              mailboxId,
              userId,
              folderId,
              skipToken,
              top,
              search,
              cacheKey,
              staleKey,
            );
          }, 0);

          return res.json({
            success: true,
            data: staleCache,
            fromCache: true,
            stale: true,
          });
        }

        return res.json({ success: true, data: cached, fromCache: true });
      }
    }

    const client = await getOutlookClient(sender);

    let pageSize = Math.min(parseInt(top) || 10, 100);

    // Build endpoint
    let endpoint;
    const folderMap = {
      inbox: "/me/mailFolders/inbox/messages",
      sent: "/me/mailFolders/sentitems/messages",
      sentitems: "/me/mailFolders/sentitems/messages",
      drafts: "/me/mailFolders/drafts/messages",
      trash: "/me/mailFolders/deleteditems/messages",
      deleteditems: "/me/mailFolders/deleteditems/messages",
      spam: "/me/mailFolders/junkemail/messages",
      junkemail: "/me/mailFolders/junkemail/messages",
      archive: "/me/mailFolders/archive/messages",
      outbox: "/me/mailFolders/outbox/messages",
    };

    endpoint =
      folderMap[folderId.toLowerCase()] ||
      `/me/mailFolders/${folderId}/messages`;

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

    const response = await client.get(endpoint, { params });

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

    const result = {
      messages,
      nextSkipToken,
      nextLink: response.data["@odata.nextLink"] || null,
      count: response.data["@odata.count"] || 0,
      folderId,
      folderType: mapOutlookFolderToType(folderId),
    };

    // Update last used timestamp (non-blocking)
    sender.update({ lastUsedAt: new Date() }).catch(console.error);

    // Cache if it's first page and no search
    if (!skipToken && !search) {
      await Promise.all([
        setCachedData(cacheKey, result, CACHE_TTL.MESSAGES),
        setCachedData(`${cacheKey}:stale`, result, CACHE_TTL.MESSAGES * 2),
      ]);
    }

    res.json({ success: true, data: result });
  });
});

// =========================
// BACKGROUND REFRESH HELPER
// =========================
const refreshOutlookMessagesInBackground = async (
  mailboxId,
  userId,
  folderId,
  skipToken,
  top,
  search,
  cacheKey,
  staleKey,
) => {
  try {
    const sender = await OutlookSender.findOne({
      where: { id: mailboxId, userId, isVerified: true },
      attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
    });

    if (!sender) return;

    const client = await getOutlookClient(sender);

    let pageSize = Math.min(parseInt(top) || 10, 100);

    const folderMap = {
      inbox: "/me/mailFolders/inbox/messages",
      sent: "/me/mailFolders/sentitems/messages",
      sentitems: "/me/mailFolders/sentitems/messages",
      drafts: "/me/mailFolders/drafts/messages",
      trash: "/me/mailFolders/deleteditems/messages",
      deleteditems: "/me/mailFolders/deleteditems/messages",
      spam: "/me/mailFolders/junkemail/messages",
      junkemail: "/me/mailFolders/junkemail/messages",
      archive: "/me/mailFolders/archive/messages",
      outbox: "/me/mailFolders/outbox/messages",
    };

    const endpoint =
      folderMap[folderId.toLowerCase()] ||
      `/me/mailFolders/${folderId}/messages`;

    const params = {
      $top: pageSize,
      $orderby: "receivedDateTime desc",
      $select:
        "id,subject,from,toRecipients,bodyPreview,receivedDateTime,isRead,parentFolderId,hasAttachments",
      $count: "true",
    };

    if (skipToken) {
      params.$skiptoken = skipToken;
    }

    const response = await client.get(endpoint, { params });

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

    const result = {
      messages,
      nextSkipToken,
      nextLink: response.data["@odata.nextLink"] || null,
      count: response.data["@odata.count"] || 0,
      folderId,
      folderType: mapOutlookFolderToType(folderId),
    };

    await Promise.all([
      setCachedData(cacheKey, result, CACHE_TTL.MESSAGES),
      setCachedData(staleKey, result, CACHE_TTL.MESSAGES * 2),
    ]);
  } catch (err) {
    console.error("Background refresh failed:", err);
  }
};

// =========================
// GET OUTLOOK FOLDERS (with caching)
// =========================
export const getOutlookFolders = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const cacheKey = generateCacheKey("outlook", mailboxId, "folders");

    // Try cache first
    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const client = await getOutlookClient(sender);

    const response = await client.get("/me/mailFolders", {
      params: {
        $select:
          "id,displayName,unreadItemCount,totalItemCount,childFolderCount,parentFolderId",
        $top: 200,
        $expand:
          "childFolders($select=id,displayName,unreadItemCount,totalItemCount)",
      },
    });

    const processFolder = (folder, parentId = null) => {
      const folderType = mapOutlookFolderToType(folder.id, folder.displayName);
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

    // Sort folders
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

    const result = {
      folders,
      flatList: folders.flatMap((f) => [f, ...(f.childFolders || [])]),
    };

    // Cache the folders
    await setCachedData(cacheKey, result, CACHE_TTL.FOLDERS);

    res.json({ success: true, data: result });
  });
});

// =========================
// GET SINGLE OUTLOOK MESSAGE (with caching)
// =========================
export const getOutlookMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const cacheKey = generateCacheKey(
      "outlook",
      mailboxId,
      "message",
      messageId,
    );

    // Try cache first
    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const client = await getOutlookClient(sender);

    const response = await client.get(`/me/messages/${messageId}`, {
      headers: {
        Prefer: 'outlook.body-content-type="html"',
      },
      params: {
        $select:
          "id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,isRead,body,bodyPreview,conversationId,internetMessageId,parentFolderId,hasAttachments",
      },
    });

    // Cache single message
    await setCachedData(cacheKey, response.data, CACHE_TTL.SINGLE_MESSAGE);

    res.json({ success: true, data: response.data });
  });
});

// =========================
// MARK OUTLOOK AS READ (invalidate cache)
// =========================
export const markOutlookAsRead = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    await client.patch(`/me/messages/${messageId}`, { isRead: true });

    // Invalidate relevant caches
    await Promise.all([
      deleteCachedData(generateCacheKey("outlook", mailboxId, "messages", "*")),
      deleteCachedData(
        generateCacheKey("outlook", mailboxId, "message", messageId),
      ),
      deleteCachedData(generateCacheKey("outlook", mailboxId, "folders")),
    ]);

    res.json({ success: true, message: "Message marked as read" });
  });
});

// =========================
// MARK OUTLOOK AS UNREAD
// =========================
export const markOutlookAsUnread = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    await client.patch(`/me/messages/${messageId}`, { isRead: false });

    // Invalidate relevant caches
    await Promise.all([
      deleteCachedData(generateCacheKey("outlook", mailboxId, "messages", "*")),
      deleteCachedData(
        generateCacheKey("outlook", mailboxId, "message", messageId),
      ),
      deleteCachedData(generateCacheKey("outlook", mailboxId, "folders")),
    ]);

    res.json({ success: true, message: "Message marked as unread" });
  });
});

// =========================
// DELETE OUTLOOK MESSAGE (invalidate cache)
// =========================
export const deleteOutlookMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    await client.delete(`/me/messages/${messageId}`);

    // Invalidate all caches for this mailbox
    await deleteCachedData(generateCacheKey("outlook", mailboxId, "*"));

    res.json({ success: true, message: "Message deleted successfully" });
  });
});

// =========================
// MOVE OUTLOOK MESSAGE
// =========================
export const moveOutlookMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { destinationFolderId } = req.body;

  if (!destinationFolderId) {
    throw new AppError("Destination folder ID is required", 400);
  }

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    await client.post(`/me/messages/${messageId}/move`, {
      destinationId: destinationFolderId,
    });

    // Invalidate relevant caches
    await Promise.all([
      deleteCachedData(generateCacheKey("outlook", mailboxId, "messages", "*")),
      deleteCachedData(
        generateCacheKey("outlook", mailboxId, "message", messageId),
      ),
      deleteCachedData(generateCacheKey("outlook", mailboxId, "folders")),
    ]);

    res.json({ success: true, message: "Message moved successfully" });
  });
});

// =========================
// CREATE FOLDER
// =========================
export const createOutlookFolder = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { displayName, parentFolderId } = req.body;

  if (!displayName) {
    throw new AppError("Folder name is required", 400);
  }

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    let endpoint = "/me/mailFolders";
    if (parentFolderId) {
      endpoint = `/me/mailFolders/${parentFolderId}/childFolders`;
    }

    const response = await client.post(endpoint, {
      displayName,
    });

    // Invalidate folders cache
    await deleteCachedData(generateCacheKey("outlook", mailboxId, "folders"));

    res.json({
      success: true,
      message: "Folder created successfully",
      data: response.data,
    });
  });
});

// =========================
// UPDATE FOLDER
// =========================
export const updateOutlookFolder = asyncHandler(async (req, res) => {
  const { mailboxId, folderId } = req.params;
  const userId = req.user.id;
  const { displayName } = req.body;

  if (!displayName) {
    throw new AppError("Folder name is required", 400);
  }

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    await client.patch(`/me/mailFolders/${folderId}`, {
      displayName,
    });

    // Invalidate folders cache
    await deleteCachedData(generateCacheKey("outlook", mailboxId, "folders"));

    res.json({ success: true, message: "Folder updated successfully" });
  });
});

// =========================
// DELETE FOLDER
// =========================
export const deleteOutlookFolder = asyncHandler(async (req, res) => {
  const { mailboxId, folderId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    await client.delete(`/me/mailFolders/${folderId}`);

    // Invalidate folders cache
    await deleteCachedData(generateCacheKey("outlook", mailboxId, "folders"));

    res.json({ success: true, message: "Folder deleted successfully" });
  });
});

// =========================
// GET OUTLOOK PROFILE
// =========================
export const getOutlookProfile = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const cacheKey = generateCacheKey("outlook", mailboxId, "profile");

    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const client = await getOutlookClient(sender);

    const response = await client.get("/me");

    await setCachedData(cacheKey, response.data, 3600); // 1 hour cache

    res.json({ success: true, data: response.data });
  });
});

// =========================
// SEARCH OUTLOOK MESSAGES
// =========================
export const searchOutlookMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { query, skipToken, top = 10 } = req.query;

  if (!query) throw new AppError("Search query is required", 400);

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const cacheKey = generateCacheKey(
      "outlook",
      mailboxId,
      "search",
      query,
      skipToken || "first",
      top,
    );

    if (!skipToken) {
      const cached = await getCachedData(cacheKey);
      if (cached) {
        return res.json({ success: true, data: cached, fromCache: true });
      }
    }

    const client = await getOutlookClient(sender);

    let pageSize = Math.min(parseInt(top) || 10, 100);

    const params = {
      $top: pageSize,
      $orderby: "receivedDateTime desc",
      $search: `"${query}"`,
      $select:
        "id,subject,from,toRecipients,bodyPreview,receivedDateTime,isRead,parentFolderId,hasAttachments",
      $count: "true",
    };

    if (skipToken) {
      params.$skiptoken = skipToken;
    }

    const response = await client.get("/me/messages", { params });

    let nextSkipToken = null;
    if (response.data["@odata.nextLink"]) {
      const url = new URL(response.data["@odata.nextLink"]);
      nextSkipToken = url.searchParams.get("$skiptoken");
    }

    const result = {
      messages: response.data.value || [],
      nextSkipToken,
      nextLink: response.data["@odata.nextLink"] || null,
      count: response.data["@odata.count"] || 0,
    };

    if (!skipToken) {
      await setCachedData(cacheKey, result, CACHE_TTL.MESSAGES);
    }

    res.json({ success: true, data: result });
  });
});

// =========================
// SYNC OUTLOOK MAILBOX (invalidate cache)
// =========================
export const syncOutlookMailbox = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const { folderId = "inbox" } = req.query;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    const folderMap = {
      inbox: "/me/mailFolders/inbox/messages",
      sent: "/me/mailFolders/sentitems/messages",
      sentitems: "/me/mailFolders/sentitems/messages",
      drafts: "/me/mailFolders/drafts/messages",
      trash: "/me/mailFolders/deleteditems/messages",
      deleteditems: "/me/mailFolders/deleteditems/messages",
      spam: "/me/mailFolders/junkemail/messages",
      junkemail: "/me/mailFolders/junkemail/messages",
      archive: "/me/mailFolders/archive/messages",
      outbox: "/me/mailFolders/outbox/messages",
    };

    const endpoint =
      folderMap[folderId.toLowerCase()] ||
      `/me/mailFolders/${folderId}/messages`;

    // Test connection
    await client.get(endpoint, { params: { $top: 1 } });

    // Update last sync timestamp
    const updateData = { lastInboxSyncAt: new Date() };
    if (folderId === "sentitems" || folderId === "sent")
      updateData.lastSentSyncAt = new Date();
    if (folderId === "drafts") updateData.lastDraftsSyncAt = new Date();

    await sender.update(updateData);

    // Invalidate cache for this folder
    await Promise.all([
      deleteCachedData(
        generateCacheKey("outlook", mailboxId, "messages", folderId, "*"),
      ),
      deleteCachedData(generateCacheKey("outlook", mailboxId, "folders")),
    ]);

    res.json({
      success: true,
      message: `Mailbox synced successfully (${folderId})`,
      data: { syncedAt: new Date(), folderId },
    });
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
    attributes: ["id", "refreshToken"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);
  if (!sender.refreshToken)
    throw new AppError("No refresh token available", 400);

  // Clear cached client
  outlookClients.delete(`outlook_client_${mailboxId}`);

  await getValidMicrosoftToken(sender);
  const updated = await OutlookSender.findByPk(sender.id, {
    attributes: ["id", "email", "expiresAt"],
  });

  res.json({
    success: true,
    message: "Token refreshed",
    data: { expiresAt: updated.expiresAt },
  });
});

// =========================
// DISCONNECT OUTLOOK MAILBOX (clear all caches)
// =========================
export const disconnectOutlookMailbox = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId },
    attributes: ["id"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  // Clear rate limiter
  clearMailboxLimiter(mailboxId, "outlook");

  // Clear all caches and client
  await Promise.all([
    deleteCachedData(generateCacheKey("outlook", mailboxId, "*")),
    Promise.resolve(outlookClients.delete(`outlook_client_${mailboxId}`)),
    sender.destroy({ force: true }),
  ]);

  res.json({ success: true, message: "Outlook mailbox disconnected" });
});

// =========================
// HELPER: Map Outlook folder to type
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

// Export all folder-specific functions
export const getOutlookSentMessages = asyncHandler(async (req, res) => {
  req.query.folderId = "sentitems";
  return getOutlookMessages(req, res);
});

export const getOutlookTrashMessages = asyncHandler(async (req, res) => {
  req.query.folderId = "deleteditems";
  return getOutlookMessages(req, res);
});

export const getOutlookSpamMessages = asyncHandler(async (req, res) => {
  req.query.folderId = "junkemail";
  return getOutlookMessages(req, res);
});

export const getOutlookArchiveMessages = asyncHandler(async (req, res) => {
  req.query.folderId = "archive";
  return getOutlookMessages(req, res);
});

export const getOutlookOutboxMessages = asyncHandler(async (req, res) => {
  req.query.folderId = "outbox";
  return getOutlookMessages(req, res);
});

export const getOutlookDrafts = asyncHandler(async (req, res) => {
  req.query.folderId = "drafts";
  return getOutlookMessages(req, res);
});
