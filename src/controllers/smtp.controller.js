// controllers/smtp.controller.js
import Imap from "imap";
import { simpleParser } from "mailparser";
import SmtpSender from "../models/smtp-sender.model.js";
import { asyncHandler } from "../helpers/async-handler.js";
import AppError from "../utils/app-error.js";
import {
  getCachedData,
  setCachedData,
  deleteCachedData,
  generateCacheKey,
} from "../utils/redis-client.js";
import { withRateLimit, clearMailboxLimiter } from "../utils/rate-limiter.js";
import util from "util";

// Cache TTLs
const CACHE_TTL = {
  MESSAGES: 300, // 5 minutes
  FOLDERS: 600, // 10 minutes
  SINGLE_MESSAGE: 1800, // 30 minutes
};

// =========================
// PROPER IMAP CONNECTION POOL
// =========================
class ImapConnectionPool {
  constructor() {
    this.pools = new Map();
  }

  async getConnection(sender) {
    const poolKey = `imap_${sender.id}`;
    const now = Date.now();

    // Check for existing valid connection
    if (this.pools.has(poolKey)) {
      const conn = this.pools.get(poolKey);

      // Check if connection is still alive (less than 10 minutes old and not stale)
      if (
        now - conn.lastUsed < 10 * 60 * 1000 &&
        conn.connection.state === "authenticated"
      ) {
        conn.lastUsed = now;
        return conn.connection;
      }

      // Close stale connection
      try {
        conn.connection.end();
      } catch (e) {}
      this.pools.delete(poolKey);
    }

    // Create new connection
    const connection = await this.createConnection(sender);

    // Store in pool
    this.pools.set(poolKey, {
      connection,
      lastUsed: now,
      folderStates: new Map(), // Track which folders are selected
    });

    return connection;
  }

  createConnection(sender) {
    const imap = new Imap({
      user: sender.email,
      password: sender.imapPassword,
      host: sender.imapHost,
      port: sender.imapPort,
      tls: sender.imapSecure,
      tlsOptions: { rejectUnauthorized: false },
      authTimeout: 10000,
      keepalive: true,
    });

    return new Promise((resolve, reject) => {
      imap.once("ready", () => resolve(imap));
      imap.once("error", (err) =>
        reject(new AppError(`IMAP connection failed: ${err.message}`, 500)),
      );
      imap.connect();
    });
  }

  async ensureSelectedFolder(connection, folderName, poolKey) {
    const pool = this.pools.get(poolKey);
    if (!pool) return null;

    // If already selected this folder, get current box info
    if (pool.folderStates.get("current") === folderName) {
      return connection._box; // Return current box
    }

    // Open the folder and get box info
    const box = await util.promisify(connection.openBox).bind(connection)(
      folderName,
      false,
    );
    pool.folderStates.set("current", folderName);

    return box; // Return the box info
  }

  async getFolderStatus(connection, folderPath) {
    return util.promisify(connection.status).bind(connection)(folderPath);
  }

  async getFolders(connection) {
    return util.promisify(connection.getBoxes).bind(connection)();
  }

  async search(connection, criteria) {
    return util.promisify(connection.search).bind(connection)(criteria);
  }

  async fetch(connection, uids, options) {
    return new Promise((resolve, reject) => {
      const fetch = connection.fetch(uids, options);
      const messages = [];

      fetch.on("message", (msg) => {
        const message = { parts: [], attributes: null };

        msg.on("body", (stream, info) => {
          let buffer = "";
          stream.on("data", (chunk) => (buffer += chunk.toString("utf8")));
          stream.on("end", () => {
            message.parts.push({ which: info.which, data: buffer });
          });
        });

        msg.once("attributes", (attrs) => {
          message.attributes = attrs;
        });
        msg.once("end", () => {
          messages.push(message);
        });
      });

      fetch.once("error", reject);
      fetch.once("end", () => resolve(messages));
    });
  }

  async addFlags(connection, uid, flags) {
    return util.promisify(connection.addFlags).bind(connection)(uid, flags);
  }

  async delFlags(connection, uid, flags) {
    return util.promisify(connection.delFlags).bind(connection)(uid, flags);
  }

  async move(connection, uid, targetFolder) {
    return util.promisify(connection.move).bind(connection)(uid, targetFolder);
  }

  async expunge(connection) {
    return util.promisify(connection.expunge).bind(connection)();
  }

  closeConnection(mailboxId) {
    const poolKey = `imap_${mailboxId}`;
    if (this.pools.has(poolKey)) {
      try {
        this.pools.get(poolKey).connection.end();
      } catch (e) {}
      this.pools.delete(poolKey);
    }
  }
}

const imapPool = new ImapConnectionPool();

// =========================
// BATCH MESSAGE PARSER
// =========================
const parseMessagesInParallel = async (messages) => {
  const parsePromises = messages.map(async (msg) => {
    try {
      const fullEmail = msg.parts.map((p) => p.data).join("");
      const parsed = await simpleParser(fullEmail);

      return {
        id: msg.attributes?.uid || msg.seqno,
        uid: msg.attributes?.uid,
        seqno: msg.seqno,
        subject: parsed.subject || "(No Subject)",
        from: parsed.from?.text || "",
        to: parsed.to?.text || "",
        date: parsed.date || new Date(),
        text: parsed.text,
        html: parsed.html,
        attachments: parsed.attachments?.map((a) => ({
          filename: a.filename,
          contentType: a.contentType,
          size: a.size,
        })),
        flags: msg.attributes?.flags || [],
        isRead: msg.attributes?.flags?.includes("\\Seen") || false,
        isStarred: msg.attributes?.flags?.includes("\\Flagged") || false,
      };
    } catch (err) {
      console.error("Failed to parse message:", err);
      return null;
    }
  });

  const results = await Promise.all(parsePromises);
  return results.filter((r) => r !== null);
};

// GET SMTP MESSAGES - FIXED TO SHOW NEWEST FIRST
export const getSmtpMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { page = 1, limit = 10, folder = "INBOX" } = req.query;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    // Ensure limit is respected
    let pageSize = Math.min(parseInt(limit) || 10, 50);
    let currentPage = Math.max(parseInt(page) || 1, 1);

    const cacheKey = generateCacheKey(
      "smtp",
      mailboxId,
      "messages",
      folder,
      currentPage,
      pageSize,
    );

    // Check cache first
    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({
        success: true,
        data: {
          messages: cached.messages,
          totalCount: cached.totalCount,
          currentPage: cached.currentPage,
          totalPages: cached.totalPages,
          folder: cached.folder,
          limit: pageSize,
          hasMore: cached.currentPage < cached.totalPages,
        },
        fromCache: true,
      });
    }

    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    // Ensure correct folder is selected
    await imapPool.ensureSelectedFolder(connection, folder, poolKey);

    // Get box info safely
    const box = connection._box;

    // If the folder doesn't exist or IMAP didn't return box info,
    // return an empty, well-shaped response instead of crashing.
    if (!box || !box.messages) {
      return res.json({
        success: true,
        data: {
          messages: [],
          totalCount: 0,
          currentPage,
          totalPages: 0,
          folder,
          limit: pageSize,
          hasMore: false,
        },
      });
    }

    const totalMessages = box.messages.total;
    const totalPages = Math.ceil(totalMessages / pageSize);

    // Check if page is valid
    if (currentPage > totalPages) {
      return res.json({
        success: true,
        data: {
          messages: [],
          totalCount: totalMessages,
          currentPage,
          totalPages,
          folder,
          limit: pageSize,
          hasMore: false,
        },
      });
    }

    // Calculate range from the END (newest) backwards
    const startSeq = Math.max(1, totalMessages - currentPage * pageSize + 1);
    const endSeq = totalMessages - (currentPage - 1) * pageSize;

    // Ensure we have valid range
    const rangeStart = Math.min(startSeq, endSeq);
    const rangeEnd = Math.max(startSeq, endSeq);

    console.log("DEBUG", "Message range calculation", {
      totalMessages,
      currentPage,
      pageSize,
      rangeStart,
      rangeEnd,
      direction: "newest first",
    });

    if (rangeStart > rangeEnd || rangeStart < 1) {
      return res.json({
        success: true,
        data: {
          messages: [],
          totalCount: totalMessages,
          currentPage,
          totalPages,
          folder,
          limit: pageSize,
          hasMore: currentPage < totalPages,
        },
      });
    }

    // Get UIDs for the specific range
    const fetch = connection.seq.fetch(`${rangeStart}:${rangeEnd}`, {
      bodies: "",
      struct: true,
    });

    const uids = await new Promise((resolve, reject) => {
      const uidList = [];
      fetch.on("message", (msg) => {
        msg.once("attributes", (attrs) => {
          if (attrs.uid) uidList.push(attrs.uid);
        });
      });
      fetch.once("error", reject);
      fetch.once("end", () => resolve(uidList));
    });

    // Reverse the UIDs to show newest first (highest UID = newest)
    uids.sort((a, b) => b - a);

    // Batch fetch messages
    const messages = await imapPool.fetch(connection, uids, {
      bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", "TEXT"],
      struct: true,
    });

    // Parse in parallel
    const parsedMessages = await parseMessagesInParallel(messages);

    // Sort by date descending (newest first)
    parsedMessages.sort((a, b) => new Date(b.date) - new Date(a.date));

    const result = {
      messages: parsedMessages,
      totalCount: totalMessages,
      currentPage,
      totalPages,
      folder,
      limit: pageSize,
      hasMore: currentPage < totalPages,
    };

    // Update last sync
    sender.update({ lastInboxSyncAt: new Date() }).catch(console.error);

    // Cache the result
    await setCachedData(cacheKey, result, CACHE_TTL.MESSAGES);

    res.json({ success: true, data: result });
  });
});

// =========================
// GET SMTP FOLDERS (BATCH OPTIMIZED)
// =========================
export const getSmtpFolders = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const cacheKey = generateCacheKey("smtp", mailboxId, "folders");

    // Try cache first
    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const connection = await imapPool.getConnection(sender);
    const boxes = await imapPool.getFolders(connection);

    const processFolders = (boxObj, parentPath = "") => {
      let folders = [];
      for (const [name, box] of Object.entries(boxObj)) {
        const fullPath = parentPath
          ? `${parentPath}${connection.delimiter}${name}`
          : name;
        folders.push({
          id: fullPath,
          name: name,
          fullPath: fullPath,
          delimiter: connection.delimiter,
          hasChildren: box.children
            ? Object.keys(box.children).length > 0
            : false,
          folderType: mapFolderType(fullPath),
        });
        if (box.children) {
          folders = folders.concat(processFolders(box.children, fullPath));
        }
      }
      return folders;
    };

    let folders = processFolders(boxes);

    // Batch get folder statuses - use a single connection for all
    const statusPromises = folders.map(async (folder) => {
      try {
        const status = await imapPool.getFolderStatus(
          connection,
          folder.fullPath,
        );
        return {
          ...folder,
          totalCount: status.messages?.total || 0,
          unreadCount: status.messages?.unseen || 0,
        };
      } catch (err) {
        return { ...folder, totalCount: 0, unreadCount: 0 };
      }
    });

    const foldersWithCounts = await Promise.all(statusPromises);

    // Sort folders
    foldersWithCounts.sort((a, b) => {
      const order = { INBOX: 1, SENT: 2, DRAFTS: 3, TRASH: 4, SPAM: 5 };
      const aOrder = order[a.name.toUpperCase()] || 6;
      const bOrder = order[b.name.toUpperCase()] || 6;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.name.localeCompare(b.name);
    });

    const result = { folders: foldersWithCounts, flatList: foldersWithCounts };

    // Cache the folders
    await setCachedData(cacheKey, result, CACHE_TTL.FOLDERS);

    res.json({ success: true, data: result });
  });
});

// =========================
// GET SINGLE SMTP MESSAGE
// =========================
export const getSmtpMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { folder = "INBOX" } = req.query;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const cacheKey = generateCacheKey(
      "smtp",
      mailboxId,
      "message",
      messageId,
      folder,
    );

    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    await imapPool.ensureSelectedFolder(connection, folder, poolKey);

    const uid = parseInt(messageId);
    const messages = await imapPool.fetch(connection, [uid], {
      bodies: "",
      struct: true,
    });

    if (messages.length === 0) {
      throw new AppError("Message not found", 404);
    }

    const parsedMessages = await parseMessagesInParallel(messages);

    if (parsedMessages.length === 0) {
      throw new AppError("Message not found", 404);
    }

    const message = parsedMessages[0];
    message.folder = folder;

    await setCachedData(cacheKey, message, CACHE_TTL.SINGLE_MESSAGE);

    res.json({ success: true, data: message });
  });
});

// =========================
// MARK SMTP MESSAGE AS READ
// =========================
export const markSmtpAsRead = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { folder = "INBOX" } = req.query;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    await imapPool.ensureSelectedFolder(connection, folder, poolKey);
    await imapPool.addFlags(connection, parseInt(messageId), ["\\Seen"]);

    // Invalidate caches
    Promise.all([
      deleteCachedData(generateCacheKey("smtp", mailboxId, "messages", "*")),
      deleteCachedData(
        generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
      ),
      deleteCachedData(generateCacheKey("smtp", mailboxId, "folders")),
    ]).catch(console.error);

    res.json({ success: true, message: "Message marked as read" });
  });
});

// =========================
// MARK SMTP MESSAGE AS UNREAD
// =========================
export const markSmtpAsUnread = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { folder = "INBOX" } = req.query;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    await imapPool.ensureSelectedFolder(connection, folder, poolKey);
    await imapPool.delFlags(connection, parseInt(messageId), ["\\Seen"]);

    // Invalidate caches
    Promise.all([
      deleteCachedData(generateCacheKey("smtp", mailboxId, "messages", "*")),
      deleteCachedData(
        generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
      ),
      deleteCachedData(generateCacheKey("smtp", mailboxId, "folders")),
    ]).catch(console.error);

    res.json({ success: true, message: "Message marked as unread" });
  });
});

// =========================
// DELETE SMTP MESSAGE
// =========================
export const deleteSmtpMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { folder = "INBOX" } = req.query;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    await imapPool.ensureSelectedFolder(connection, folder, poolKey);
    await imapPool.addFlags(connection, parseInt(messageId), ["\\Deleted"]);
    await imapPool.expunge(connection);

    // Invalidate all caches
    await deleteCachedData(generateCacheKey("smtp", mailboxId, "*"));

    res.json({ success: true, message: "Message deleted successfully" });
  });
});

// =========================
// MOVE SMTP MESSAGE
// =========================
export const moveSmtpMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { sourceFolder = "INBOX", targetFolder } = req.body;

  if (!targetFolder) throw new AppError("Target folder is required", 400);

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    await imapPool.ensureSelectedFolder(connection, sourceFolder, poolKey);
    await imapPool.move(connection, parseInt(messageId), targetFolder);

    // Invalidate caches
    Promise.all([
      deleteCachedData(generateCacheKey("smtp", mailboxId, "messages", "*")),
      deleteCachedData(
        generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
      ),
      deleteCachedData(generateCacheKey("smtp", mailboxId, "folders")),
    ]).catch(console.error);

    res.json({ success: true, message: `Message moved to ${targetFolder}` });
  });
});
// =========================
// SYNC SMTP MAILBOX - FIXED
// =========================
export const syncSmtpMailbox = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const { folder = "INBOX" } = req.query;
  const userId = req.user.id;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    // 🔴 FIX: ensureSelectedFolder now returns the box
    const box = await imapPool.ensureSelectedFolder(
      connection,
      folder,
      poolKey,
    );

    // Update last sync timestamp
    const updateData = { lastInboxSyncAt: new Date() };
    if (folder.toUpperCase() === "SENT") updateData.lastSentSyncAt = new Date();
    if (folder.toUpperCase() === "DRAFTS")
      updateData.lastDraftsSyncAt = new Date();

    await sender.update(updateData);

    // Invalidate cache for this folder
    await Promise.all([
      deleteCachedData(
        generateCacheKey("smtp", mailboxId, "messages", folder, "*"),
      ),
      deleteCachedData(generateCacheKey("smtp", mailboxId, "folders")),
    ]);

    // 🔴 FIX: box is now defined
    res.json({
      success: true,
      message: `Mailbox synced successfully (${folder})`,
      data: {
        syncedAt: new Date(),
        folder,
        totalMessages: box?.messages?.total || 0,
        unreadMessages: box?.messages?.unseen || 0,
      },
    });
  });
});

// =========================
// GET SMTP MAILBOX STATUS
// =========================
export const getSmtpStatus = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const cacheKey = generateCacheKey("smtp", mailboxId, "status");

    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const connection = await imapPool.getConnection(sender);
    const folders = ["INBOX", "SENT", "DRAFTS", "TRASH", "SPAM"];

    const statusPromises = folders.map(async (folder) => {
      try {
        const status = await imapPool.getFolderStatus(connection, folder);
        return {
          folder,
          total: status.messages?.total || 0,
          unread: status.messages?.unseen || 0,
          recent: status.messages?.recent || 0,
        };
      } catch (err) {
        return { folder, total: 0, unread: 0, recent: 0 };
      }
    });

    const results = await Promise.all(statusPromises);
    const statuses = {};
    results.forEach((r) => {
      statuses[r.folder] = {
        total: r.total,
        unread: r.unread,
        recent: r.recent,
      };
    });

    const result = {
      email: sender.email,
      domain: sender.domain,
      isConnected: true,
      folders: statuses,
      lastSyncAt: sender.lastInboxSyncAt,
    };

    await setCachedData(cacheKey, result, 60);
    res.json({ success: true, data: result });
  });
});

// =========================
// DISCONNECT SMTP MAILBOX
// =========================
export const disconnectSmtpMailbox = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await SmtpSender.findOne({ where: { id: mailboxId, userId } });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  // Close connection and clean up
  imapPool.closeConnection(mailboxId);
  clearMailboxLimiter(mailboxId, "smtp");
  await deleteCachedData(generateCacheKey("smtp", mailboxId, "*"));

  await sender.destroy({ force: true });
  res.json({ success: true, message: "SMTP mailbox disconnected" });
});

// =========================
// FOLDER-SPECIFIC MESSAGE GETTERS
// =========================
export const getSmtpSentMessages = asyncHandler(async (req, res) => {
  req.query.folder = "SENT";
  return getSmtpMessages(req, res);
});

export const getSmtpDraftMessages = asyncHandler(async (req, res) => {
  req.query.folder = "DRAFTS";
  return getSmtpMessages(req, res);
});

export const getSmtpTrashMessages = asyncHandler(async (req, res) => {
  req.query.folder = "TRASH";
  return getSmtpMessages(req, res);
});

export const getSmtpSpamMessages = asyncHandler(async (req, res) => {
  req.query.folder = "SPAM";
  return getSmtpMessages(req, res);
});

export const getSmtpArchiveMessages = asyncHandler(async (req, res) => {
  req.query.folder = "ARCHIVE";
  return getSmtpMessages(req, res);
});

// =========================
// HELPER
// =========================
const mapFolderType = (folderPath) => {
  const upperPath = folderPath.toUpperCase();
  if (upperPath.includes("INBOX")) return "inbox";
  if (upperPath.includes("SENT")) return "sent";
  if (upperPath.includes("DRAFT")) return "drafts";
  if (
    upperPath.includes("TRASH") ||
    upperPath.includes("BIN") ||
    upperPath.includes("DELETED")
  )
    return "trash";
  if (upperPath.includes("SPAM") || upperPath.includes("JUNK")) return "spam";
  if (upperPath.includes("ARCHIVE")) return "archive";
  if (upperPath.includes("OUTBOX")) return "outbox";
  return "custom";
};

// =========================
// SEND SMTP MESSAGE (COMPOSE)
// =========================
export const sendSmtpMessage = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { to, cc, bcc, subject, body, html, attachments = [] } = req.body;

  if (!to || !subject || (!body && !html)) {
    throw new AppError("To, subject, and message body are required", 400);
  }

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  // Use nodemailer for sending
  const nodemailer = (await import("nodemailer")).default;

  return withRateLimit(mailboxId, "smtp", async () => {
    // Create transporter
    const transporter = nodemailer.createTransport({
      host: sender.smtpHost,
      port: sender.smtpPort,
      secure: sender.smtpSecure,
      auth: {
        user: sender.smtpUsername,
        pass: sender.smtpPassword,
      },
    });

    // Build mail options
    const mailOptions = {
      from: `"${sender.displayName}" <${sender.email}>`,
      to: to,
      cc: cc,
      bcc: bcc,
      subject: subject,
      text: body,
      html: html,
    };

    // Add attachments if any
    if (attachments && attachments.length > 0) {
      mailOptions.attachments = attachments.map((att) => ({
        filename: att.filename,
        content: Buffer.from(att.content, "base64"),
        contentType: att.mimeType,
      }));
    }

    // Send mail
    const info = await transporter.sendMail(mailOptions);

    // Save to sent folder if supported
    try {
      const connection = await imapPool.getConnection(sender);
      // Implementation depends on IMAP server capabilities
      // Some servers auto-save to Sent folder
    } catch (err) {
      console.error("Failed to save to sent folder:", err);
    }

    await sender.update({ lastUsedAt: new Date(), lastSentAt: new Date() });

    // Invalidate sent messages cache
    await deleteCachedData(
      generateCacheKey("smtp", mailboxId, "messages", "SENT", "*"),
    );

    res.json({
      success: true,
      message: "Email sent successfully",
      data: { messageId: info.messageId },
    });
  });
});

// =========================
// CREATE SMTP DRAFT
// =========================
export const createSmtpDraft = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { to, cc, bcc, subject, body, html, attachments = [] } = req.body;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    // Ensure we're in Drafts folder
    await imapPool.ensureSelectedFolder(connection, "DRAFTS", poolKey);

    // Build email content
    const emailLines = [];

    emailLines.push(`From: ${sender.email}`);
    if (to) emailLines.push(`To: ${to}`);
    if (cc) emailLines.push(`Cc: ${cc}`);
    if (bcc) emailLines.push(`Bcc: ${bcc}`);
    emailLines.push(`Subject: ${subject || ""}`);
    emailLines.push("MIME-Version: 1.0");
    emailLines.push(
      `Content-Type: ${html ? "text/html" : "text/plain"}; charset="UTF-8"`,
    );
    emailLines.push("");
    emailLines.push(html || body || "");

    const email = emailLines.join("\r\n");

    // Append as draft
    await new Promise((resolve, reject) => {
      connection.append(
        email,
        { mailbox: "DRAFTS", flags: ["\\Draft"] },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate drafts cache
    await deleteCachedData(
      generateCacheKey("smtp", mailboxId, "messages", "DRAFTS", "*"),
    );

    res.json({
      success: true,
      message: "Draft created successfully",
    });
  });
});

// =========================
// UPDATE SMTP DRAFT
// =========================
export const updateSmtpDraft = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { to, cc, bcc, subject, body, html, attachments = [] } = req.body;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    await imapPool.ensureSelectedFolder(connection, "DRAFTS", poolKey);

    // Delete old draft
    await imapPool.addFlags(connection, parseInt(messageId), ["\\Deleted"]);
    await imapPool.expunge(connection);

    // Build new email content
    const emailLines = [];

    emailLines.push(`From: ${sender.email}`);
    if (to) emailLines.push(`To: ${to}`);
    if (cc) emailLines.push(`Cc: ${cc}`);
    if (bcc) emailLines.push(`Bcc: ${bcc}`);
    emailLines.push(`Subject: ${subject || ""}`);
    emailLines.push("MIME-Version: 1.0");
    emailLines.push(
      `Content-Type: ${html ? "text/html" : "text/plain"}; charset="UTF-8"`,
    );
    emailLines.push("");
    emailLines.push(html || body || "");

    const email = emailLines.join("\r\n");

    // Append as new draft
    await new Promise((resolve, reject) => {
      connection.append(
        email,
        { mailbox: "DRAFTS", flags: ["\\Draft"] },
        (err) => {
          if (err) reject(err);
          else resolve();
        },
      );
    });

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(
        generateCacheKey("smtp", mailboxId, "messages", "DRAFTS", "*"),
      ),
      deleteCachedData(
        generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
      ),
    ]);

    res.json({
      success: true,
      message: "Draft updated successfully",
    });
  });
});

// =========================
// DELETE SMTP DRAFT
// =========================
export const deleteSmtpDraft = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    await imapPool.ensureSelectedFolder(connection, "DRAFTS", poolKey);
    await imapPool.addFlags(connection, parseInt(messageId), ["\\Deleted"]);
    await imapPool.expunge(connection);

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(
        generateCacheKey("smtp", mailboxId, "messages", "DRAFTS", "*"),
      ),
      deleteCachedData(
        generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
      ),
    ]);

    res.json({
      success: true,
      message: "Draft deleted successfully",
    });
  });
});

// =========================
// SEND SMTP DRAFT
// =========================
export const sendSmtpDraft = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  const nodemailer = (await import("nodemailer")).default;

  return withRateLimit(mailboxId, "smtp", async () => {
    // First get the draft content
    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    await imapPool.ensureSelectedFolder(connection, "DRAFTS", poolKey);

    const messages = await imapPool.fetch(connection, [parseInt(messageId)], {
      bodies: "",
      struct: true,
    });

    if (messages.length === 0) {
      throw new AppError("Draft not found", 404);
    }

    const parsedMessages = await parseMessagesInParallel(messages);
    if (parsedMessages.length === 0) {
      throw new AppError("Draft not found", 404);
    }

    const draft = parsedMessages[0];

    // Send via SMTP
    const transporter = nodemailer.createTransport({
      host: sender.smtpHost,
      port: sender.smtpPort,
      secure: sender.smtpSecure,
      auth: {
        user: sender.smtpUsername,
        pass: sender.smtpPassword,
      },
    });

    const mailOptions = {
      from: `"${sender.displayName}" <${sender.email}>`,
      to: draft.to,
      subject: draft.subject,
      text: draft.text,
      html: draft.html,
    };

    await transporter.sendMail(mailOptions);

    // Delete the draft after sending
    await imapPool.addFlags(connection, parseInt(messageId), ["\\Deleted"]);
    await imapPool.expunge(connection);

    await sender.update({ lastUsedAt: new Date(), lastSentAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(generateCacheKey("smtp", mailboxId, "messages", "*")),
      deleteCachedData(
        generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
      ),
    ]);

    res.json({
      success: true,
      message: "Draft sent successfully",
    });
  });
});

// =========================
// TOGGLE SMTP FLAG (STAR)
// =========================
export const toggleSmtpFlag = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { flagged, folder = "INBOX" } = req.body;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    await imapPool.ensureSelectedFolder(connection, folder, poolKey);

    if (flagged) {
      await imapPool.addFlags(connection, parseInt(messageId), ["\\Flagged"]);
    } else {
      await imapPool.delFlags(connection, parseInt(messageId), ["\\Flagged"]);
    }

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(generateCacheKey("smtp", mailboxId, "messages", "*")),
      deleteCachedData(
        generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
      ),
    ]);

    res.json({
      success: true,
      message: flagged ? "Message flagged" : "Message unflagged",
    });
  });
});

// =========================
// GET SMTP ATTACHMENTS
// =========================
export const getSmtpAttachments = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { folder = "INBOX" } = req.query;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const cacheKey = generateCacheKey(
      "smtp",
      mailboxId,
      "attachments",
      messageId,
      folder,
    );

    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    await imapPool.ensureSelectedFolder(connection, folder, poolKey);

    const messages = await imapPool.fetch(connection, [parseInt(messageId)], {
      bodies: "",
      struct: true,
    });

    if (messages.length === 0) {
      throw new AppError("Message not found", 404);
    }

    const fullEmail = messages[0].parts.map((p) => p.data).join("");
    const parsed = await simpleParser(fullEmail);

    const attachments =
      parsed.attachments?.map((att) => ({
        id: att.contentId || att.filename,
        filename: att.filename,
        contentType: att.contentType,
        size: att.size,
        contentId: att.contentId,
        related: att.related,
      })) || [];

    await setCachedData(cacheKey, attachments, CACHE_TTL.SINGLE_MESSAGE);

    res.json({ success: true, data: attachments });
  });
});

// =========================
// DOWNLOAD SMTP ATTACHMENT
// =========================
export const downloadSmtpAttachment = asyncHandler(async (req, res) => {
  const { mailboxId, messageId, attachmentId } = req.params;
  const userId = req.user.id;
  const { folder = "INBOX" } = req.query;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    await imapPool.ensureSelectedFolder(connection, folder, poolKey);

    const messages = await imapPool.fetch(connection, [parseInt(messageId)], {
      bodies: "",
      struct: true,
    });

    if (messages.length === 0) {
      throw new AppError("Message not found", 404);
    }

    const fullEmail = messages[0].parts.map((p) => p.data).join("");
    const parsed = await simpleParser(fullEmail);

    const attachment = parsed.attachments?.find(
      (att) => att.contentId === attachmentId || att.filename === attachmentId,
    );

    if (!attachment) {
      throw new AppError("Attachment not found", 404);
    }

    res.setHeader("Content-Type", attachment.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${attachment.filename}"`,
    );
    res.setHeader("Content-Length", attachment.size);

    if (attachment.content instanceof Buffer) {
      res.send(attachment.content);
    } else {
      res.send(Buffer.from(attachment.content));
    }
  });
});

// =========================
// BATCH SMTP OPERATIONS
// =========================
export const batchSmtpOperations = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { messageIds, operation, targetFolder, folder = "INBOX" } = req.body;

  if (!messageIds || !messageIds.length || !operation) {
    throw new AppError("Message IDs and operation are required", 400);
  }

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    await imapPool.ensureSelectedFolder(connection, folder, poolKey);

    const results = [];

    for (const messageId of messageIds) {
      try {
        const uid = parseInt(messageId);

        switch (operation) {
          case "delete":
            await imapPool.addFlags(connection, uid, ["\\Deleted"]);
            results.push({ messageId, status: "deleted" });
            break;

          case "mark-read":
            await imapPool.addFlags(connection, uid, ["\\Seen"]);
            results.push({ messageId, status: "marked-read" });
            break;

          case "mark-unread":
            await imapPool.delFlags(connection, uid, ["\\Seen"]);
            results.push({ messageId, status: "marked-unread" });
            break;

          case "flag":
            await imapPool.addFlags(connection, uid, ["\\Flagged"]);
            results.push({ messageId, status: "flagged" });
            break;

          case "unflag":
            await imapPool.delFlags(connection, uid, ["\\Flagged"]);
            results.push({ messageId, status: "unflagged" });
            break;

          case "move":
            if (!targetFolder) {
              throw new AppError(
                "Target folder required for move operation",
                400,
              );
            }
            await imapPool.move(connection, uid, targetFolder);
            results.push({ messageId, status: "moved", targetFolder });
            break;

          default:
            throw new AppError(`Unknown operation: ${operation}`, 400);
        }
      } catch (err) {
        results.push({
          messageId,
          status: "failed",
          error: err.message,
        });
      }
    }

    if (operation === "delete") {
      await imapPool.expunge(connection);
    }

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(generateCacheKey("smtp", mailboxId, "messages", "*")),
      deleteCachedData(generateCacheKey("smtp", mailboxId, "folders")),
    ]);

    res.json({
      success: true,
      message: `Batch operation '${operation}' completed`,
      data: { results },
    });
  });
});

// =========================
// COPY SMTP MESSAGE
// =========================
export const copySmtpMessage = asyncHandler(async (req, res) => {
  const { mailboxId, messageId } = req.params;
  const userId = req.user.id;
  const { sourceFolder = "INBOX", targetFolder } = req.body;

  if (!targetFolder) {
    throw new AppError("Target folder is required", 400);
  }

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    // First fetch the message content
    await imapPool.ensureSelectedFolder(connection, sourceFolder, poolKey);

    const messages = await imapPool.fetch(connection, [parseInt(messageId)], {
      bodies: "",
      struct: true,
    });

    if (messages.length === 0) {
      throw new AppError("Message not found", 404);
    }

    const fullEmail = messages[0].parts.map((p) => p.data).join("");

    // Switch to target folder and append
    await imapPool.ensureSelectedFolder(connection, targetFolder, poolKey);

    await new Promise((resolve, reject) => {
      connection.append(fullEmail, { mailbox: targetFolder }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    await sender.update({ lastUsedAt: new Date() });

    // Invalidate caches
    await Promise.all([
      deleteCachedData(generateCacheKey("smtp", mailboxId, "messages", "*")),
      deleteCachedData(generateCacheKey("smtp", mailboxId, "folders")),
    ]);

    res.json({
      success: true,
      message: `Message copied to ${targetFolder}`,
    });
  });
});

// =========================
// SEARCH SMTP MESSAGES
// =========================
export const searchSmtpMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { query, folder = "INBOX", limit = 50 } = req.query;

  if (!query) {
    throw new AppError("Search query is required", 400);
  }

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const cacheKey = generateCacheKey(
      "smtp",
      mailboxId,
      "search",
      folder,
      query,
    );

    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const connection = await imapPool.getConnection(sender);
    const poolKey = `imap_${mailboxId}`;

    await imapPool.ensureSelectedFolder(connection, folder, poolKey);

    // Build search criteria
    const criteria = [["TEXT", query]];

    // Add date range if specified in query (simplified)
    if (query.includes("since:")) {
      // Parse date from query - simplified implementation
      const dateMatch = query.match(/since:(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        criteria.push(["SINCE", new Date(dateMatch[1])]);
      }
    }

    const uids = await imapPool.search(connection, criteria);

    // Limit results
    const limitedUids = uids.slice(0, parseInt(limit) || 50);

    if (limitedUids.length === 0) {
      const result = { messages: [], totalCount: 0 };
      await setCachedData(cacheKey, result, 60);
      return res.json({ success: true, data: result });
    }

    // Fetch messages
    const messages = await imapPool.fetch(connection, limitedUids, {
      bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", "TEXT"],
      struct: true,
    });

    const parsedMessages = await parseMessagesInParallel(messages);

    const result = {
      messages: parsedMessages,
      totalCount: uids.length,
    };

    await setCachedData(cacheKey, result, 60);

    res.json({ success: true, data: result });
  });
});
