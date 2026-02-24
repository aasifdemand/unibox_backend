/* eslint-disable no-unused-vars */
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
const CACHEerrTTL = {
  MESSAGES: 1200, // 20 minutes
  FOLDERS: 1800, // 30 minutes
  SINGLEerrMESSAGE: 3600, // 60 minutes
};

function createImapConnection(sender) {
  const imap = new Imap({
    user: sender.email,
    password: sender.imapPassword,
    host: sender.imapHost,
    port: sender.imapPort,
    tls: sender.imapSecure,
    tlsOptions: { rejectUnauthorized: false },
    authTimeout: 15000,
    connTimeout: 15000,
  });

  const connected = new Promise((resolve, reject) => {
    imap.once("ready", () => resolve(imap));
    imap.once("error", (err) => {
      const isAuthError =
        err.message.toLowerCase().includes("authentication failed") ||
        err.message.toLowerCase().includes("invalid credentials");
      reject(
        new AppError(
          `IMAP connection failed: ${err.message}`,
          isAuthError ? 401 : 500,
        ),
      );
    });
    imap.connect();
  });

  return connected;
}

// =========================
// PROVIDER-AWARE FOLDER RESOLVER
// Gmail, Outlook, and generic SMTP servers all use different names for the same
// system folders.  This function maps a friendly name to the actual IMAP folder
// name used by the provider, with a live fallback lookup via getBoxes().
// =========================
async function resolveFolder(imap, sender, friendlyName) {
  const upper = friendlyName.toUpperCase();

  // --- Provider detection ------------------------------------------------
  const host = (sender.imapHost || "").toLowerCase();
  const isGmail = host.includes("gmail") || host.includes("googlemail");
  const isOutlook =
    host.includes("outlook") ||
    host.includes("hotmail") ||
    host.includes("live.com") ||
    host.includes("office365");

  // --- Static mappings -------------------------------------------------------
  const GMAILerrMAP = {
    INBOX: "INBOX",
    SENT: "[Gmail]/Sent Mail",
    DRAFTS: "[Gmail]/Drafts",
    TRASH: "[Gmail]/Trash",
    SPAM: "[Gmail]/Spam",
    ARCHIVE: "[Gmail]/All Mail",
    STARRED: "[Gmail]/Starred",
    IMPORTANT: "[Gmail]/Important",
  };

  const OUTLOOKerrMAP = {
    INBOX: "INBOX",
    SENT: "Sent Items",
    DRAFTS: "Drafts",
    TRASH: "Deleted Items",
    SPAM: "Junk Email",
    ARCHIVE: "Archive",
  };

  // Return a known mapping immediately if available
  if (isGmail && GMAILerrMAP[upper]) return GMAILerrMAP[upper];
  if (isOutlook && OUTLOOKerrMAP[upper]) return OUTLOOKerrMAP[upper];

  // If not a special folder or unknown provider, try the name directly first
  // but fall back to a fuzzy search against the real folder list
  const candidateNames = [friendlyName];
  if (upper === "SENT")
    candidateNames.push("Sent Items", "Sent", "[Gmail]/Sent Mail");
  if (upper === "DRAFTS") candidateNames.push("Drafts", "[Gmail]/Drafts");
  if (upper === "TRASH")
    candidateNames.push("Deleted Items", "Trash", "[Gmail]/Trash", "Bin");
  if (upper === "SPAM")
    candidateNames.push("Junk Email", "Junk", "[Gmail]/Spam");
  if (upper === "ARCHIVE") candidateNames.push("[Gmail]/All Mail", "Archive");

  // Flatten the live box list and match against our candidates
  try {
    const boxes = await util.promisify(imap.getBoxes).bind(imap)();
    const flatBoxes = flattenBoxes(boxes);
    for (const candidate of candidateNames) {
      const match = flatBoxes.find(
        (b) =>
          b.toLowerCase() === candidate.toLowerCase() ||
          b.toLowerCase().endsWith("/" + candidate.toLowerCase()),
      );
      if (match) return match;
    }
  } catch (error) {
    console.log(error);

    // Ignore — fall through to the raw name
  }

  // Last resort: return whatever was requested
  return friendlyName;
}

// Recursively flatten IMAP box tree into path strings
function flattenBoxes(boxes, prefix = "") {
  const result = [];
  for (const [name, box] of Object.entries(boxes || {})) {
    const fullPath = prefix ? `${prefix}${box.delimiter || "/"}${name}` : name;
    result.push(fullPath);
    if (box.children) {
      result.push(...flattenBoxes(box.children, fullPath));
    }
  }
  return result;
}

// =========================
// HELPER: open a folder and return the box info
// =========================
async function openFolder(imap, folderName) {
  return util.promisify(imap.openBox).bind(imap)(folderName, false);
}

// =========================
// HELPER: fetch messages from an OPEN imap connection
// =========================
function fetchMessages(imap, uids, options) {
  return new Promise((resolve, reject) => {
    const fetch = imap.fetch(uids, options);
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

// =========================
// HELPER: fetch UIDs for a sequence range
// =========================
function fetchUidsForRange(imap, range) {
  return new Promise((resolve, reject) => {
    const fetch = imap.seq.fetch(range, { bodies: "", struct: true });
    const uidList = [];
    fetch.on("message", (msg) => {
      msg.once("attributes", (attrs) => {
        if (attrs.uid) uidList.push(attrs.uid);
      });
    });
    fetch.once("error", reject);
    fetch.once("end", () => resolve(uidList));
  });
}

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

// =========================
// CORE MESSAGE FETCHER - plain async so it can be called by any handler
// =========================
async function fetchSmtpMessagesForFolder(req, res, folder) {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { page = 1, limit = 10 } = req.query;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const pageSize = Math.min(parseInt(limit) || 10, 50);
    const currentPage = Math.max(parseInt(page) || 1, 1);

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
        data: { ...cached, limit: pageSize },
        fromCache: true,
      });
    }

    // --- Per-request connection (never share across folders) ---
    const imap = await createImapConnection(sender);

    try {
      // Resolve the provider-specific folder name
      const resolvedFolder = await resolveFolder(imap, sender, folder);

      // Open the folder — this guarantees we are in the RIGHT folder
      let box;
      try {
        box = await openFolder(imap, resolvedFolder);
      } catch (err) {
        console.log(err);

        // Folder doesn't exist on this account
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

      const totalMessages = box.messages.total || 0;

      if (totalMessages === 0) {
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

      const totalPages = Math.ceil(totalMessages / pageSize);

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

      // Calculate range from the END (newest first)
      const startSeq = Math.max(1, totalMessages - currentPage * pageSize + 1);
      const endSeq = totalMessages - (currentPage - 1) * pageSize;
      const rangeStart = Math.min(startSeq, endSeq);
      const rangeEnd = Math.max(startSeq, endSeq);

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

      // Fetch UIDs for range then full bodies
      const uids = await fetchUidsForRange(imap, `${rangeStart}:${rangeEnd}`);
      uids.sort((a, b) => b - a); // newest first

      const rawMessages = await fetchMessages(imap, uids, {
        bodies: ["HEADER.FIELDS (FROM TO CC SUBJECT DATE)", ""],
        struct: true,
      });

      const parsedMessages = await parseMessagesInParallel(rawMessages);
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

      // Update last sync silently
      sender.update({ lastInboxSyncAt: new Date() }).catch(() => {});

      await setCachedData(cacheKey, result, CACHEerrTTL.MESSAGES);
      res.json({ success: true, data: result });
    } finally {
      try {
        imap.end();
      } catch (err) {
        console.log(err);
      }
    }
  });
}

// GET SMTP MESSAGES - uses folder from query param (default: INBOX)
export const getSmtpMessages = asyncHandler(async (req, res) => {
  const folder = req.query.folder || "INBOX";
  return fetchSmtpMessagesForFolder(req, res, folder);
});

// =========================
// FOLDER-SPECIFIC SHORTCUTS
// Each calls fetchSmtpMessagesForFolder directly with a hardcoded folder name.
// =========================
export const getSmtpSentMessages = asyncHandler(async (req, res) => {
  return fetchSmtpMessagesForFolder(req, res, "SENT");
});

export const getSmtpDraftMessages = asyncHandler(async (req, res) => {
  return fetchSmtpMessagesForFolder(req, res, "DRAFTS");
});

export const getSmtpTrashMessages = asyncHandler(async (req, res) => {
  return fetchSmtpMessagesForFolder(req, res, "TRASH");
});

export const getSmtpSpamMessages = asyncHandler(async (req, res) => {
  return fetchSmtpMessagesForFolder(req, res, "SPAM");
});

export const getSmtpArchiveMessages = asyncHandler(async (req, res) => {
  return fetchSmtpMessagesForFolder(req, res, "ARCHIVE");
});

// =========================
// GET SMTP FOLDERS (BATCH OPTIMIZED)
// =========================
export const getSmtpFolders = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const cacheKey = generateCacheKey("smtp", mailboxId, "folders");

    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const imap = await createImapConnection(sender);
    try {
      const boxes = await util.promisify(imap.getBoxes).bind(imap)();
      const delimiter = imap.delimiter || "/";

      const processFolders = (boxObj, parentPath = "") => {
        let folders = [];
        for (const [name, box] of Object.entries(boxObj)) {
          const fullPath = parentPath
            ? `${parentPath}${delimiter}${name}`
            : name;
          folders.push({
            id: fullPath,
            name,
            fullPath,
            delimiter,
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

      const folders = processFolders(boxes);

      const statusPromises = folders.map(async (folder) => {
        try {
          const status = await util.promisify(imap.status).bind(imap)(
            folder.fullPath,
          );
          return {
            ...folder,
            totalCount: status.messages?.total || 0,
            unreadCount: status.messages?.unseen || 0,
          };
        } catch (err) {
          console.log(err);

          return { ...folder, totalCount: 0, unreadCount: 0 };
        }
      });

      const foldersWithCounts = await Promise.all(statusPromises);
      foldersWithCounts.sort((a, b) => {
        const order = { INBOX: 1, SENT: 2, DRAFTS: 3, TRASH: 4, SPAM: 5 };
        return (
          (order[a.name.toUpperCase()] || 6) -
            (order[b.name.toUpperCase()] || 6) || a.name.localeCompare(b.name)
        );
      });

      const result = {
        folders: foldersWithCounts,
        flatList: foldersWithCounts,
      };
      await setCachedData(cacheKey, result, CACHEerrTTL.FOLDERS);
      res.json({ success: true, data: result });
    } finally {
      try {
        imap.end();
      } catch (err) {
        console.log(err);
      }
    }
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
    where: { id: mailboxId, userId, isActive: true },
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

    const imap = await createImapConnection(sender);
    try {
      const resolvedFolder = await resolveFolder(imap, sender, folder);
      await openFolder(imap, resolvedFolder);

      const uid = parseInt(messageId);
      const rawMessages = await fetchMessages(imap, [uid], {
        bodies: "",
        struct: true,
      });

      if (rawMessages.length === 0)
        throw new AppError("Message not found", 404);

      const parsedMessages = await parseMessagesInParallel(rawMessages);
      if (parsedMessages.length === 0)
        throw new AppError("Message not found", 404);

      const message = parsedMessages[0];
      message.folder = folder;

      await setCachedData(cacheKey, message, CACHEerrTTL.SINGLEerrMESSAGE);
      res.json({ success: true, data: message });
    } finally {
      try {
        imap.end();
      } catch (err) {
        console.log(err);
      }
    }
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
    where: { id: mailboxId, userId, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const imap = await createImapConnection(sender);
    try {
      const resolvedFolder = await resolveFolder(imap, sender, folder);
      await openFolder(imap, resolvedFolder);
      await util.promisify(imap.addFlags).bind(imap)(parseInt(messageId), [
        "\\Seen",
      ]);
      Promise.all([
        deleteCachedData(
          generateCacheKey("smtp", mailboxId, "messages", folder, "*"),
        ),
        deleteCachedData(
          generateCacheKey("smtp", mailboxId, "message", messageId, folder),
        ),
        deleteCachedData(generateCacheKey("smtp", mailboxId, "folders")),
      ]).catch(() => {});
      res.json({ success: true, message: "Message marked as read" });
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
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
    where: { id: mailboxId, userId, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const imap = await createImapConnection(sender);
    try {
      const resolvedFolder = await resolveFolder(imap, sender, folder);
      await openFolder(imap, resolvedFolder);
      await util.promisify(imap.delFlags).bind(imap)(parseInt(messageId), [
        "\\Seen",
      ]);
      Promise.all([
        deleteCachedData(
          generateCacheKey("smtp", mailboxId, "messages", folder, "*"),
        ),
        deleteCachedData(
          generateCacheKey("smtp", mailboxId, "message", messageId, folder),
        ),
        deleteCachedData(generateCacheKey("smtp", mailboxId, "folders")),
      ]).catch(() => {});
      res.json({ success: true, message: "Message marked as unread" });
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
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
    where: { id: mailboxId, userId, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const imap = await createImapConnection(sender);
    try {
      const resolvedFolder = await resolveFolder(imap, sender, folder);
      await openFolder(imap, resolvedFolder);
      await util.promisify(imap.addFlags).bind(imap)(parseInt(messageId), [
        "\\Deleted",
      ]);
      await util.promisify(imap.expunge).bind(imap)();
      await deleteCachedData(generateCacheKey("smtp", mailboxId, "*"));
      res.json({ success: true, message: "Message deleted successfully" });
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
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
    where: { id: mailboxId, userId, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const imap = await createImapConnection(sender);
    try {
      const resolvedSource = await resolveFolder(imap, sender, sourceFolder);
      const resolvedTarget = await resolveFolder(imap, sender, targetFolder);
      await openFolder(imap, resolvedSource);
      await util.promisify(imap.move).bind(imap)(
        parseInt(messageId),
        resolvedTarget,
      );
      Promise.all([
        deleteCachedData(generateCacheKey("smtp", mailboxId, "messages", "*")),
        deleteCachedData(
          generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
        ),
        deleteCachedData(generateCacheKey("smtp", mailboxId, "folders")),
      ]).catch(() => {});
      res.json({ success: true, message: `Message moved to ${targetFolder}` });
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
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
    where: { id: mailboxId, userId, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const imap = await createImapConnection(sender);
    let box;
    try {
      const resolvedFolder = await resolveFolder(imap, sender, folder);
      box = await openFolder(imap, resolvedFolder);
    } catch (err) {
      box = null;
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }

    const updateData = { lastInboxSyncAt: new Date() };
    if (folder.toUpperCase() === "SENT") updateData.lastSentSyncAt = new Date();
    if (folder.toUpperCase() === "DRAFTS")
      updateData.lastDraftsSyncAt = new Date();
    await sender.update(updateData);

    await Promise.all([
      deleteCachedData(
        generateCacheKey("smtp", mailboxId, "messages", folder, "*"),
      ),
      deleteCachedData(generateCacheKey("smtp", mailboxId, "folders")),
    ]);

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
    where: { id: mailboxId, userId, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    const cacheKey = generateCacheKey("smtp", mailboxId, "status");

    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const imap = await createImapConnection(sender);
    try {
      const friendlyFolders = ["INBOX", "SENT", "DRAFTS", "TRASH", "SPAM"];
      const statusPromises = friendlyFolders.map(async (folderName) => {
        try {
          const resolved = await resolveFolder(imap, sender, folderName);
          const status = await util.promisify(imap.status).bind(imap)(resolved);
          return {
            folder: folderName,
            total: status.messages?.total || 0,
            unread: status.messages?.unseen || 0,
            recent: status.messages?.recent || 0,
          };
        } catch (err) {
          return { folder: folderName, total: 0, unread: 0, recent: 0 };
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
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
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

  // Clean up rate limiter and cache
  clearMailboxLimiter(mailboxId, "smtp");
  await deleteCachedData(generateCacheKey("smtp", mailboxId, "*"));

  await sender.destroy({ force: true });
  res.json({ success: true, message: "SMTP mailbox disconnected" });
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
    where: { id: mailboxId, userId, isActive: true },
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
    const imap = await createImapConnection(sender);
    try {
      const resolvedDrafts = await resolveFolder(imap, sender, "DRAFTS");
      await openFolder(imap, resolvedDrafts);

      const emailLines = [
        `From: ${sender.email}`,
        ...(to ? [`To: ${to}`] : []),
        ...(cc ? [`Cc: ${cc}`] : []),
        ...(bcc ? [`Bcc: ${bcc}`] : []),
        `Subject: ${subject || ""}`,
        "MIME-Version: 1.0",
        `Content-Type: ${html ? "text/html" : "text/plain"}; charset="UTF-8"`,
        "",
        html || body || "",
      ];
      const emailRaw = emailLines.join("\r\n");

      await new Promise((resolve, reject) => {
        imap.append(
          emailRaw,
          { mailbox: resolvedDrafts, flags: ["\\Draft"] },
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });

      await sender.update({ lastUsedAt: new Date() });
      await deleteCachedData(
        generateCacheKey("smtp", mailboxId, "messages", "DRAFTS", "*"),
      );
      res.json({ success: true, message: "Draft created successfully" });
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
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
    const imap = await createImapConnection(sender);
    try {
      const resolvedDrafts = await resolveFolder(imap, sender, "DRAFTS");
      await openFolder(imap, resolvedDrafts);

      // Delete old draft
      await util.promisify(imap.addFlags).bind(imap)(parseInt(messageId), [
        "\\Deleted",
      ]);
      await util.promisify(imap.expunge).bind(imap)();

      const emailLines = [
        `From: ${sender.email}`,
        ...(to ? [`To: ${to}`] : []),
        ...(cc ? [`Cc: ${cc}`] : []),
        ...(bcc ? [`Bcc: ${bcc}`] : []),
        `Subject: ${subject || ""}`,
        "MIME-Version: 1.0",
        `Content-Type: ${html ? "text/html" : "text/plain"}; charset="UTF-8"`,
        "",
        html || body || "",
      ];
      const emailRaw = emailLines.join("\r\n");

      await new Promise((resolve, reject) => {
        imap.append(
          emailRaw,
          { mailbox: resolvedDrafts, flags: ["\\Draft"] },
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });

      await sender.update({ lastUsedAt: new Date() });
      await Promise.all([
        deleteCachedData(
          generateCacheKey("smtp", mailboxId, "messages", "DRAFTS", "*"),
        ),
        deleteCachedData(
          generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
        ),
      ]);
      res.json({ success: true, message: "Draft updated successfully" });
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
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
    const imap = await createImapConnection(sender);
    try {
      const resolvedDrafts = await resolveFolder(imap, sender, "DRAFTS");
      await openFolder(imap, resolvedDrafts);
      await util.promisify(imap.addFlags).bind(imap)(parseInt(messageId), [
        "\\Deleted",
      ]);
      await util.promisify(imap.expunge).bind(imap)();
      await sender.update({ lastUsedAt: new Date() });
      await Promise.all([
        deleteCachedData(
          generateCacheKey("smtp", mailboxId, "messages", "DRAFTS", "*"),
        ),
        deleteCachedData(
          generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
        ),
      ]);
      res.json({ success: true, message: "Draft deleted successfully" });
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
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
    const imap = await createImapConnection(sender);
    try {
      const resolvedDrafts = await resolveFolder(imap, sender, "DRAFTS");
      await openFolder(imap, resolvedDrafts);

      const rawMessages = await fetchMessages(imap, [parseInt(messageId)], {
        bodies: "",
        struct: true,
      });
      if (rawMessages.length === 0) throw new AppError("Draft not found", 404);

      const parsedMessages = await parseMessagesInParallel(rawMessages);
      if (parsedMessages.length === 0)
        throw new AppError("Draft not found", 404);

      const draft = parsedMessages[0];

      const transporter = nodemailer.createTransport({
        host: sender.smtpHost,
        port: sender.smtpPort,
        secure: sender.smtpSecure,
        auth: { user: sender.smtpUsername, pass: sender.smtpPassword },
      });

      await transporter.sendMail({
        from: `"${sender.displayName}" <${sender.email}>`,
        to: draft.to,
        subject: draft.subject,
        text: draft.text,
        html: draft.html,
      });

      // Delete the draft after sending
      await util.promisify(imap.addFlags).bind(imap)(parseInt(messageId), [
        "\\Deleted",
      ]);
      await util.promisify(imap.expunge).bind(imap)();

      await sender.update({ lastUsedAt: new Date(), lastSentAt: new Date() });
      await Promise.all([
        deleteCachedData(generateCacheKey("smtp", mailboxId, "messages", "*")),
        deleteCachedData(
          generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
        ),
      ]);
      res.json({ success: true, message: "Draft sent successfully" });
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
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
    const imap = await createImapConnection(sender);
    try {
      const resolvedFolder = await resolveFolder(imap, sender, folder);
      await openFolder(imap, resolvedFolder);
      if (flagged) {
        await util.promisify(imap.addFlags).bind(imap)(parseInt(messageId), [
          "\\Flagged",
        ]);
      } else {
        await util.promisify(imap.delFlags).bind(imap)(parseInt(messageId), [
          "\\Flagged",
        ]);
      }
      await sender.update({ lastUsedAt: new Date() });
      await Promise.all([
        deleteCachedData(
          generateCacheKey("smtp", mailboxId, "messages", folder, "*"),
        ),
        deleteCachedData(
          generateCacheKey("smtp", mailboxId, "message", messageId, folder),
        ),
      ]);
      res.json({
        success: true,
        message: flagged ? "Message flagged" : "Message unflagged",
      });
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
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
    if (cached)
      return res.json({ success: true, data: cached, fromCache: true });

    const imap = await createImapConnection(sender);
    try {
      const resolvedFolder = await resolveFolder(imap, sender, folder);
      await openFolder(imap, resolvedFolder);
      const rawMessages = await fetchMessages(imap, [parseInt(messageId)], {
        bodies: "",
        struct: true,
      });
      if (rawMessages.length === 0)
        throw new AppError("Message not found", 404);

      const fullEmail = rawMessages[0].parts.map((p) => p.data).join("");
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

      await setCachedData(cacheKey, attachments, CACHEerrTTL.SINGLEerrMESSAGE);
      res.json({ success: true, data: attachments });
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
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
    const imap = await createImapConnection(sender);
    try {
      const resolvedFolder = await resolveFolder(imap, sender, folder);
      await openFolder(imap, resolvedFolder);
      const rawMessages = await fetchMessages(imap, [parseInt(messageId)], {
        bodies: "",
        struct: true,
      });
      if (rawMessages.length === 0)
        throw new AppError("Message not found", 404);

      const fullEmail = rawMessages[0].parts.map((p) => p.data).join("");
      const parsed = await simpleParser(fullEmail);
      const attachment = parsed.attachments?.find(
        (att) =>
          att.contentId === attachmentId || att.filename === attachmentId,
      );
      if (!attachment) throw new AppError("Attachment not found", 404);

      res.setHeader("Content-Type", attachment.contentType);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${attachment.filename}"`,
      );
      res.setHeader("Content-Length", attachment.size);
      res.send(
        attachment.content instanceof Buffer
          ? attachment.content
          : Buffer.from(attachment.content),
      );
    } finally {
      try {
        imap.end();
      } catch (err) {}
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
    const imap = await createImapConnection(sender);
    try {
      const resolvedFolder = await resolveFolder(imap, sender, folder);
      await openFolder(imap, resolvedFolder);
      const results = [];

      for (const messageId of messageIds) {
        try {
          const uid = parseInt(messageId);
          switch (operation) {
            case "delete":
              await util.promisify(imap.addFlags).bind(imap)(uid, [
                "\\Deleted",
              ]);
              results.push({ messageId, status: "deleted" });
              break;
            case "mark-read":
              await util.promisify(imap.addFlags).bind(imap)(uid, ["\\Seen"]);
              results.push({ messageId, status: "marked-read" });
              break;
            case "mark-unread":
              await util.promisify(imap.delFlags).bind(imap)(uid, ["\\Seen"]);
              results.push({ messageId, status: "marked-unread" });
              break;
            case "flag":
              await util.promisify(imap.addFlags).bind(imap)(uid, [
                "\\Flagged",
              ]);
              results.push({ messageId, status: "flagged" });
              break;
            case "unflag":
              await util.promisify(imap.delFlags).bind(imap)(uid, [
                "\\Flagged",
              ]);
              results.push({ messageId, status: "unflagged" });
              break;
            case "move":
              if (!targetFolder)
                throw new AppError(
                  "Target folder required for move operation",
                  400,
                );
              const resolvedTarget = await resolveFolder(
                imap,
                sender,
                targetFolder,
              );
              await util.promisify(imap.move).bind(imap)(uid, resolvedTarget);
              results.push({ messageId, status: "moved", targetFolder });
              break;
            default:
              throw new AppError(`Unknown operation: ${operation}`, 400);
          }
        } catch (err) {
          results.push({ messageId, status: "failed", error: err.message });
        }
      }

      if (operation === "delete") {
        await util.promisify(imap.expunge).bind(imap)();
      }

      await sender.update({ lastUsedAt: new Date() });
      await Promise.all([
        deleteCachedData(generateCacheKey("smtp", mailboxId, "messages", "*")),
        deleteCachedData(generateCacheKey("smtp", mailboxId, "folders")),
      ]);
      res.json({
        success: true,
        message: `Batch operation '${operation}' completed`,
        data: { results },
      });
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
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
    const imap = await createImapConnection(sender);
    try {
      const resolvedSource = await resolveFolder(imap, sender, sourceFolder);
      const resolvedTarget = await resolveFolder(imap, sender, targetFolder);
      await openFolder(imap, resolvedSource);

      const rawMessages = await fetchMessages(imap, [parseInt(messageId)], {
        bodies: "",
        struct: true,
      });
      if (rawMessages.length === 0)
        throw new AppError("Message not found", 404);

      const fullEmail = rawMessages[0].parts.map((p) => p.data).join("");

      await new Promise((resolve, reject) => {
        imap.append(fullEmail, { mailbox: resolvedTarget }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

      await sender.update({ lastUsedAt: new Date() });
      await Promise.all([
        deleteCachedData(generateCacheKey("smtp", mailboxId, "messages", "*")),
        deleteCachedData(generateCacheKey("smtp", mailboxId, "folders")),
      ]);
      res.json({ success: true, message: `Message copied to ${targetFolder}` });
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
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
    if (cached)
      return res.json({ success: true, data: cached, fromCache: true });

    const imap = await createImapConnection(sender);
    try {
      const resolvedFolder = await resolveFolder(imap, sender, folder);
      await openFolder(imap, resolvedFolder);

      const criteria = [["TEXT", query]];
      if (query.includes("since:")) {
        const dateMatch = query.match(/since:(\d{4}-\d{2}-\d{2})/);
        if (dateMatch) criteria.push(["SINCE", new Date(dateMatch[1])]);
      }

      const uids = await util.promisify(imap.search).bind(imap)(criteria);
      const limitedUids = uids.slice(0, parseInt(limit) || 50);

      if (limitedUids.length === 0) {
        const result = { messages: [], totalCount: 0 };
        await setCachedData(cacheKey, result, 60);
        return res.json({ success: true, data: result });
      }

      const rawMessages = await fetchMessages(imap, limitedUids, {
        bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", ""],
        struct: true,
      });
      const parsedMessages = await parseMessagesInParallel(rawMessages);
      const result = { messages: parsedMessages, totalCount: uids.length };
      await setCachedData(cacheKey, result, 60);
      res.json({ success: true, data: result });
    } finally {
      try {
        imap.end();
      } catch (err) {}
    }
  });
});
