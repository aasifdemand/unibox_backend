import https from "https";
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

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 25, // Max concurrent connections
  maxFreeSockets: 10,
  timeout: 60000,
});

// Cache TTLs
const CACHE_TTL = {
  MESSAGES: 1200, // 20 minutes
  FOLDERS: 1800, // 30 minutes
  SINGLE_MESSAGE: 3600, // 60 minutes
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
    timeout: 30000,
    httpsAgent,
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

// GET OUTLOOK MESSAGES - INTERNAL CORE
const getOutlookMessagesInternal = async (req, res, explicitFolderId = null) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { skipToken, top = 10, folderId: queryFolderId = "inbox", search = "" } = req.query;

  // Prioritize explicitFolderId from specialized handlers
  const folderId = explicitFolderId || queryFolderId || "inbox";

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
    // Ensure top is respected
    let pageSize = Math.min(parseInt(top) || 10, 100);

    // Normalize folderId for consistent caching and mapping
    const normalizedFolderId = folderId.toLowerCase();

    // Generate cache key
    const cacheKey = generateCacheKey(
      "outlook",
      mailboxId,
      "messages",
      normalizedFolderId,
      skipToken || "first",
      pageSize,
      search || "nosearch",
    );

    // Try cache first (only for first page)
    if (!skipToken && !search) {
      const cached = await getCachedData(cacheKey);
      if (cached) {
        return res.json({
          success: true,
          data: {
            messages: cached.messages,
            nextSkipToken: cached.nextSkipToken,
            nextLink: cached.nextLink,
            count: cached.count,
            folderId,
            folderType: cached.folderType,
            hasMore: !!cached.nextSkipToken,
            top: pageSize,
          },
          fromCache: true,
        });
      }
    }

    const client = await getOutlookClient(sender);

    // Build endpoint
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
      folderMap[normalizedFolderId] ||
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

    if (skipToken && skipToken !== "first") {
      if (!isNaN(skipToken)) {
        params.$skip = skipToken;
      } else {
        params.$skiptoken = skipToken;
      }
    }

    const response = await client.get(endpoint, { params });

    let nextSkipToken = null;
    if (response.data["@odata.nextLink"]) {
      const url = new URL(response.data["@odata.nextLink"]);
      nextSkipToken = url.searchParams.get("$skiptoken") || url.searchParams.get("$skip");
    }

    const messages = (response.data.value || []).map((msg) => ({
      ...msg,
      folder: folderId,
      folderType: mapOutlookFolderToType(normalizedFolderId),
    }));

    const result = {
      messages,
      nextSkipToken,
      nextLink: response.data["@odata.nextLink"] || null,
      count: response.data["@odata.count"] || 0,
      folderId,
      folderType: mapOutlookFolderToType(normalizedFolderId),
      hasMore: !!nextSkipToken,
      top: pageSize,
    };

    // Update last used timestamp
    sender.update({ lastUsedAt: new Date() }).catch(console.error);

    // Cache only first page
    if (!skipToken && !search) {
      await setCachedData(cacheKey, result, CACHE_TTL.MESSAGES);
    }

    res.json({ success: true, data: result });
  });
};

// GET OUTLOOK MESSAGES (Public Handler)
export const getOutlookMessages = asyncHandler(async (req, res) => {
  return getOutlookMessagesInternal(req, res);
});

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

    if (skipToken && skipToken !== "first") {
      if (!isNaN(skipToken)) {
        params.$skip = skipToken;
      } else {
        params.$skiptoken = skipToken;
      }
    }

    const response = await client.get("/me/messages", { params });

    let nextSkipToken = null;
    if (response.data["@odata.nextLink"]) {
      const url = new URL(response.data["@odata.nextLink"]);
      nextSkipToken = url.searchParams.get("$skiptoken") || url.searchParams.get("$skip");
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
    sent: "sent",
    drafts: "drafts",
    deleteditems: "trash",
    trash: "trash",
    junkemail: "spam",
    junk: "spam",
    spam: "spam",
    archive: "archive",
    outbox: "outbox",
  };

  const id = folderId?.toLowerCase();
  const name = folderName?.toLowerCase().replace(/\s+/g, "");

  return (
    folderMap[id] ||
    folderMap[name] ||
    (id?.includes("sent") || name?.includes("sent") ? "sent" :
      id?.includes("trash") || id?.includes("deleted") || name?.includes("trash") || name?.includes("deleted") ? "trash" :
        "custom")
  );
};

// Export all folder-specific functions
export const getOutlookSentMessages = asyncHandler(async (req, res) => {
  return getOutlookMessagesInternal(req, res, "sentitems");
});

export const getOutlookTrashMessages = asyncHandler(async (req, res) => {
  return getOutlookMessagesInternal(req, res, "deleteditems");
});

export const getOutlookSpamMessages = asyncHandler(async (req, res) => {
  return getOutlookMessagesInternal(req, res, "junkemail");
});

export const getOutlookArchiveMessages = asyncHandler(async (req, res) => {
  return getOutlookMessagesInternal(req, res, "archive");
});

export const getOutlookOutboxMessages = asyncHandler(async (req, res) => {
  return getOutlookMessagesInternal(req, res, "outbox");
});

export const getOutlookDrafts = asyncHandler(async (req, res) => {
  return getOutlookMessagesInternal(req, res, "drafts");
});

// =========================
// SEND OUTLOOK MESSAGE (COMPOSE) - FIXED
// =========================
export const sendOutlookMessage = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const {
    to,
    cc,
    bcc,
    subject,
    body,
    html,
    attachments = [],
    saveToSent = true,
  } = req.body;

  if (!to || !subject || (!body && !html)) {
    throw new AppError("To, subject, and message body are required", 400);
  }

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    // Helper function to parse recipients - handles both string and array
    const parseRecipients = (recipientField) => {
      if (!recipientField) return [];

      // If it's already an array, format it directly
      if (Array.isArray(recipientField)) {
        return recipientField.map((email) => ({
          emailAddress: {
            address:
              typeof email === "string" ? email.trim() : email.address || email,
          },
        }));
      }

      // If it's a string, split by comma
      if (typeof recipientField === "string") {
        return recipientField.split(",").map((email) => ({
          emailAddress: { address: email.trim() },
        }));
      }

      return [];
    };

    // Format recipients
    const toRecipients = parseRecipients(to);
    const ccRecipients = parseRecipients(cc);
    const bccRecipients = parseRecipients(bcc);

    // Build message
    const message = {
      subject,
      toRecipients,
      ccRecipients,
      bccRecipients,
      body: {
        contentType: html ? "html" : "text",
        content: html || body,
      },
    };

    // Add attachments if any
    if (attachments && attachments.length > 0) {
      message.attachments = attachments.map((att) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: att.filename || att.name,
        contentType: att.mimeType || att.contentType,
        contentBytes: att.content, // base64 encoded content
      }));
    }

    // Microsoft Graph expects a different structure for sendMail
    const response = await client.post("/me/sendMail", {
      message,
      saveToSentItems: saveToSent,
    });

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(
        generateCacheKey("outlook", mailboxId, "messages", "sentitems", "*"),
      ),
      deleteCachedData(generateCacheKey("outlook", mailboxId, "sent", "*")),
      deleteCachedData(generateCacheKey("outlook", mailboxId, "outbox", "*")),
    ]);

    res.json({
      success: true,
      message: "Email sent successfully",
      data: response.data,
    });
  });
});

// =========================
// REPLY TO OUTLOOK MESSAGE - FIXED
// =========================
export const replyToOutlookMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { body, html, replyAll = false } = req.body;

  if (!body && !html) {
    throw new AppError("Message body is required", 400);
  }

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    // Get original message
    const original = await client.get(`/me/messages/${messageId}`, {
      params: {
        $select:
          "id,subject,from,toRecipients,ccRecipients,conversationId,internetMessageId,parentFolderId",
      },
    });

    // Create reply
    const reply = {
      message: {
        subject: original.data.subject.startsWith("Re:")
          ? original.data.subject
          : `Re: ${original.data.subject}`,
        body: {
          contentType: html ? "html" : "text",
          content: html || body,
        },
        toRecipients: replyAll
          ? [
            original.data.from,
            ...(original.data.toRecipients || []),
            ...(original.data.ccRecipients || []),
          ].filter(
            (r) =>
              r.emailAddress.address.toLowerCase() !==
              sender.email.toLowerCase(),
          )
          : [original.data.from],
      },
      comment: html || body,
    };

    const endpoint = replyAll
      ? `/me/messages/${messageId}/replyAll`
      : `/me/messages/${messageId}/reply`;

    const response = await client.post(endpoint, reply);

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(generateCacheKey("outlook", mailboxId, "messages", "*")),
      deleteCachedData(generateCacheKey("outlook", mailboxId, "sent", "*")),
      deleteCachedData(
        generateCacheKey("outlook", mailboxId, "message", messageId),
      ),
    ]);

    res.json({
      success: true,
      message: "Reply sent successfully",
      data: response.data,
    });
  });
});

// =========================
// FORWARD OUTLOOK MESSAGE - FIXED
// =========================
export const forwardOutlookMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { to, body, html } = req.body;

  if (!to || (!body && !html)) {
    throw new AppError("Recipient and message body are required", 400);
  }

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    // Helper function to parse recipients
    const parseRecipients = (recipientField) => {
      if (!recipientField) return [];

      if (Array.isArray(recipientField)) {
        return recipientField.map((email) => ({
          emailAddress: {
            address:
              typeof email === "string" ? email.trim() : email.address || email,
          },
        }));
      }

      if (typeof recipientField === "string") {
        return recipientField.split(",").map((email) => ({
          emailAddress: { address: email.trim() },
        }));
      }

      return [];
    };

    const forward = {
      message: {
        toRecipients: parseRecipients(to),
        body: {
          contentType: html ? "html" : "text",
          content: html || body,
        },
      },
      comment: html || body,
    };

    const response = await client.post(
      `/me/messages/${messageId}/forward`,
      forward,
    );

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(
        generateCacheKey("outlook", mailboxId, "messages", "sentitems", "*"),
      ),
      deleteCachedData(generateCacheKey("outlook", mailboxId, "sent", "*")),
    ]);

    res.json({
      success: true,
      message: "Message forwarded successfully",
      data: response.data,
    });
  });
});

// =========================
// CREATE OUTLOOK DRAFT
// =========================
export const createOutlookDraft = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { to, cc, bcc, subject, body, html, attachments = [] } = req.body;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    // Format recipients
    const toRecipients = to
      ? to.split(",").map((email) => ({
        emailAddress: { address: email.trim() },
      }))
      : [];

    const ccRecipients = cc
      ? cc.split(",").map((email) => ({
        emailAddress: { address: email.trim() },
      }))
      : [];

    const bccRecipients = bcc
      ? bcc.split(",").map((email) => ({
        emailAddress: { address: email.trim() },
      }))
      : [];

    // Build draft
    const draft = {
      subject: subject || "",
      toRecipients,
      ccRecipients,
      bccRecipients,
      body: {
        contentType: html ? "html" : "text",
        content: html || body || "",
      },
    };

    // Add attachments if any
    if (attachments && attachments.length > 0) {
      draft.attachments = attachments.map((att) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: att.filename,
        contentType: att.mimeType,
        contentBytes: att.content,
      }));
    }

    const response = await client.post("/me/messages", draft);

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate drafts cache
    await deleteCachedData(
      generateCacheKey("outlook", mailboxId, "drafts", "*"),
    );

    res.json({
      success: true,
      message: "Draft created successfully",
      data: response.data,
    });
  });
});

// =========================
// UPDATE OUTLOOK DRAFT
// =========================
export const updateOutlookDraft = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { to, cc, bcc, subject, body, html } = req.body;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    const updateData = {};

    if (to) {
      updateData.toRecipients = to.split(",").map((email) => ({
        emailAddress: { address: email.trim() },
      }));
    }
    if (cc) {
      updateData.ccRecipients = cc.split(",").map((email) => ({
        emailAddress: { address: email.trim() },
      }));
    }
    if (bcc) {
      updateData.bccRecipients = bcc.split(",").map((email) => ({
        emailAddress: { address: email.trim() },
      }));
    }
    if (subject !== undefined) updateData.subject = subject;
    if (body !== undefined || html !== undefined) {
      updateData.body = {
        contentType: html ? "html" : "text",
        content: html || body || "",
      };
    }

    const response = await client.patch(
      `/me/messages/${messageId}`,
      updateData,
    );

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(generateCacheKey("outlook", mailboxId, "drafts", "*")),
      deleteCachedData(
        generateCacheKey("outlook", mailboxId, "message", messageId),
      ),
    ]);

    res.json({
      success: true,
      message: "Draft updated successfully",
      data: response.data,
    });
  });
});

// =========================
// DELETE OUTLOOK DRAFT
// =========================
export const deleteOutlookDraft = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    await client.delete(`/me/messages/${messageId}`);

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(generateCacheKey("outlook", mailboxId, "drafts", "*")),
      deleteCachedData(
        generateCacheKey("outlook", mailboxId, "message", messageId),
      ),
    ]);

    res.json({
      success: true,
      message: "Draft deleted successfully",
    });
  });
});

// =========================
// SEND OUTLOOK DRAFT
// =========================
export const sendOutlookDraft = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    await client.post(`/me/messages/${messageId}/send`);

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(generateCacheKey("outlook", mailboxId, "drafts", "*")),
      deleteCachedData(
        generateCacheKey("outlook", mailboxId, "messages", "sentitems", "*"),
      ),
      deleteCachedData(generateCacheKey("outlook", mailboxId, "sent", "*")),
      deleteCachedData(
        generateCacheKey("outlook", mailboxId, "message", messageId),
      ),
    ]);

    res.json({
      success: true,
      message: "Draft sent successfully",
    });
  });
});

// =========================
// TOGGLE OUTLOOK FLAG (STAR/IMPORTANT)
// =========================
export const toggleOutlookFlag = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { flagStatus } = req.body; // "flagged" or "normal"

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    const flag = {
      flag: {
        flagStatus: flagStatus || "flagged",
      },
    };

    const response = await client.patch(`/me/messages/${messageId}`, flag);

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(generateCacheKey("outlook", mailboxId, "messages", "*")),
      deleteCachedData(
        generateCacheKey("outlook", mailboxId, "message", messageId),
      ),
    ]);

    res.json({
      success: true,
      message:
        flagStatus === "flagged" ? "Message flagged" : "Message unflagged",
      data: response.data,
    });
  });
});

// =========================
// GET OUTLOOK ATTACHMENTS
// =========================
export const getOutlookAttachments = asyncHandler(async (req, res) => {
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
      "attachments",
      messageId,
    );

    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const client = await getOutlookClient(sender);

    const response = await client.get(`/me/messages/${messageId}/attachments`, {
      params: {
        $select: "id,name,contentType,size,lastModifiedDateTime",
      },
    });

    await setCachedData(
      cacheKey,
      response.data.value,
      CACHE_TTL.SINGLE_MESSAGE,
    );

    res.json({ success: true, data: response.data.value });
  });
});

// =========================
// DOWNLOAD OUTLOOK ATTACHMENT
// =========================
export const downloadOutlookAttachment = asyncHandler(async (req, res) => {
  const { mailboxId, messageId, attachmentId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    const response = await client.get(
      `/me/messages/${messageId}/attachments/${attachmentId}`,
      {
        responseType: "arraybuffer",
      },
    );

    const attachment = response.data;
    const contentType =
      response.headers["content-type"] || "application/octet-stream";
    const contentDisposition =
      response.headers["content-disposition"] ||
      `attachment; filename="${attachmentId}"`;

    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Disposition", contentDisposition);
    res.setHeader("Content-Length", Buffer.byteLength(attachment));

    res.send(attachment);
  });
});

// =========================
// CREATE OUTLOOK REPLY DRAFT
// =========================
export const createOutlookReplyDraft = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { replyAll = false } = req.body;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    const endpoint = replyAll
      ? `/me/messages/${messageId}/createReplyAll`
      : `/me/messages/${messageId}/createReply`;

    const response = await client.post(endpoint);

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate drafts cache
    await deleteCachedData(
      generateCacheKey("outlook", mailboxId, "drafts", "*"),
    );

    res.json({
      success: true,
      message: "Reply draft created successfully",
      data: response.data,
    });
  });
});

// =========================
// CREATE OUTLOOK FORWARD DRAFT
// =========================
export const createOutlookForwardDraft = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    const response = await client.post(
      `/me/messages/${messageId}/createForward`,
    );

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate drafts cache
    await deleteCachedData(
      generateCacheKey("outlook", mailboxId, "drafts", "*"),
    );

    res.json({
      success: true,
      message: "Forward draft created successfully",
      data: response.data,
    });
  });
});

// =========================
// BATCH OUTLOOK OPERATIONS
// =========================
export const batchOutlookOperations = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { messageIds, operation, destinationFolderId } = req.body;

  if (!messageIds || !messageIds.length || !operation) {
    throw new AppError("Message IDs and operation are required", 400);
  }

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);
    const results = [];

    // Microsoft Graph supports batch requests
    const batchRequests = messageIds.map((messageId, index) => ({
      id: index.toString(),
      method: operation === "delete" ? "DELETE" : "PATCH",
      url: `/me/messages/${messageId}`,
      ...(operation !== "delete" && {
        body: getOperationBody(operation, destinationFolderId),
        headers: {
          "Content-Type": "application/json",
        },
      }),
    }));

    // Send batch request
    const batchResponse = await client.post("/$batch", {
      requests: batchRequests,
    });

    // Process batch responses
    batchResponse.data.responses.forEach((resp) => {
      results.push({
        messageId: messageIds[parseInt(resp.id)],
        status:
          resp.status === 200 || resp.status === 204 ? "success" : "failed",
        error:
          resp.status !== 200 && resp.status !== 204 ? resp.body?.error : null,
      });
    });

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(generateCacheKey("outlook", mailboxId, "messages", "*")),
      deleteCachedData(generateCacheKey("outlook", mailboxId, "folders")),
    ]);

    res.json({
      success: true,
      message: `Batch operation '${operation}' completed`,
      data: { results },
    });
  });
});

// =========================
// HELPER: Get operation body for batch requests
// =========================
const getOperationBody = (operation, destinationFolderId) => {
  switch (operation) {
    case "mark-read":
      return { isRead: true };
    case "mark-unread":
      return { isRead: false };
    case "flag":
      return { flag: { flagStatus: "flagged" } };
    case "unflag":
      return { flag: { flagStatus: "normal" } };
    case "move":
      return { destinationId: destinationFolderId };
    default:
      return {};
  }
};

// =========================
// COPY OUTLOOK MESSAGE
// =========================
export const copyOutlookMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { destinationFolderId } = req.body;

  if (!destinationFolderId) {
    throw new AppError("Destination folder ID is required", 400);
  }

  const sender = await OutlookSender.findOne({
    where: { id: mailboxId, userId, isVerified: true },
    attributes: ["id", "email", "refreshToken", "accessToken", "expiresAt"],
  });

  if (!sender) throw new AppError("Outlook mailbox not found", 404);

  return withRateLimit(mailboxId, "outlook", async () => {
    const client = await getOutlookClient(sender);

    const response = await client.post(`/me/messages/${messageId}/copy`, {
      destinationId: destinationFolderId,
    });

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(generateCacheKey("outlook", mailboxId, "messages", "*")),
      deleteCachedData(generateCacheKey("outlook", mailboxId, "folders")),
    ]);

    res.json({
      success: true,
      message: "Message copied successfully",
      data: response.data,
    });
  });
});
