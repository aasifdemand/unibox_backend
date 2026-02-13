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

// Cache TTLs
const CACHE_TTL = {
  MESSAGES: 120, // 2 minutes
  FOLDERS: 300, // 5 minutes
  SINGLE_MESSAGE: 600, // 10 minutes
};

// =========================
// HELPER: Create IMAP connection
// =========================
const createImapConnection = (sender) => {
  return new Imap({
    user: sender.email,
    password: sender.imapPassword,
    host: sender.imapHost,
    port: sender.imapPort,
    tls: sender.imapSecure,
    tlsOptions: { rejectUnauthorized: false },
    authTimeout: 10000,
  });
};

// =========================
// HELPER: Open mailbox/folder
// =========================
const openMailbox = (imap, folderName = "INBOX") => {
  return new Promise((resolve, reject) => {
    imap.openBox(folderName, false, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
};

// =========================
// HELPER: Fetch messages with search criteria
// =========================
const fetchMessages = (imap, searchCriteria, fetchOptions) => {
  return new Promise((resolve, reject) => {
    imap.search(searchCriteria, (err, results) => {
      if (err) reject(err);
      if (!results || results.length === 0) {
        return resolve([]);
      }

      const fetch = imap.fetch(results, fetchOptions);
      const messages = [];

      fetch.on("message", (msg, seqno) => {
        const message = {
          seqno,
          parts: [],
          attributes: null,
        };

        msg.on("body", (stream, info) => {
          let buffer = "";
          stream.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
          });
          stream.on("end", () => {
            message.parts.push({
              which: info.which,
              size: info.size,
              data: buffer,
            });
          });
        });

        msg.once("attributes", (attrs) => {
          message.attributes = attrs;
        });

        msg.once("end", () => {
          messages.push(message);
        });
      });

      fetch.once("error", (err) => {
        reject(err);
      });

      fetch.once("end", () => {
        resolve(messages);
      });
    });
  });
};

// =========================
// GET SMTP MESSAGES (INBOX)
// =========================
export const getSmtpMessages = asyncHandler(async (req, res) => {
  const { mailboxId } = req.params;
  const userId = req.user.id;
  const { page = 1, limit = 10, folder = "INBOX" } = req.query;

  const sender = await SmtpSender.findOne({
    where: { id: mailboxId, userId, isVerified: true, isActive: true },
  });
  if (!sender) throw new AppError("SMTP mailbox not found", 404);

  return withRateLimit(mailboxId, "smtp", async () => {
    // Generate cache key
    const cacheKey = generateCacheKey(
      "smtp",
      mailboxId,
      "messages",
      folder,
      page,
      limit,
    );

    // Try cache first
    if (page === "1") {
      const cached = await getCachedData(cacheKey);
      if (cached) {
        console.log(`[CACHE HIT] SMTP messages for ${mailboxId} - ${folder}`);
        return res.json({ success: true, data: cached, fromCache: true });
      }
    }

    console.log(
      `[CACHE MISS] Fetching SMTP messages for ${mailboxId} - ${folder}`,
    );

    const imap = createImapConnection(sender);

    return new Promise((resolve, reject) => {
      imap.once("ready", async () => {
        try {
          const box = await openMailbox(imap, folder);

          const pageSize = parseInt(limit);
          const start = (parseInt(page) - 1) * pageSize + 1;
          const end = Math.min(start + pageSize - 1, box.messages.total);

          if (start > box.messages.total) {
            imap.end();
            return res.json({
              success: true,
              data: {
                messages: [],
                totalCount: box.messages.total,
                currentPage: parseInt(page),
                totalPages: Math.ceil(box.messages.total / pageSize),
                folder,
              },
            });
          }

          const fetchOptions = {
            bodies: ["HEADER.FIELDS (FROM TO SUBJECT DATE)", "TEXT"],
            struct: true,
            markSeen: false,
          };

          const searchCriteria = ["ALL"];
          const messages = await fetchMessages(
            imap,
            searchCriteria,
            fetchOptions,
          );

          // Parse messages
          const parsedMessages = await Promise.all(
            messages.slice(start - 1, end).map(async (msg) => {
              try {
                // Combine all parts for parsing
                const fullEmail = msg.parts.map((part) => part.data).join("");

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
                  isStarred:
                    msg.attributes?.flags?.includes("\\Flagged") || false,
                };
              } catch (err) {
                console.error("Failed to parse message:", err);
                return null;
              }
            }),
          );

          const validMessages = parsedMessages.filter((m) => m !== null);

          const result = {
            messages: validMessages,
            totalCount: box.messages.total,
            currentPage: parseInt(page),
            totalPages: Math.ceil(box.messages.total / pageSize),
            folder,
          };

          // Update last sync
          await sender.update({ lastInboxSyncAt: new Date() });

          // Cache first page
          if (page === "1") {
            await setCachedData(cacheKey, result, CACHE_TTL.MESSAGES);
          }

          imap.end();
          res.json({ success: true, data: result });
        } catch (error) {
          imap.end();
          reject(error);
        }
      });

      imap.once("error", (err) => {
        reject(new AppError(`IMAP connection failed: ${err.message}`, 500));
      });

      imap.once("end", () => {
        console.log("IMAP connection ended");
      });

      imap.connect();
    });
  });
});

// =========================
// GET SMTP SENT MESSAGES
// =========================
export const getSmtpSentMessages = asyncHandler(async (req, res) => {
  req.query.folder = "SENT";
  return getSmtpMessages(req, res);
});

// =========================
// GET SMTP DRAFT MESSAGES
// =========================
export const getSmtpDraftMessages = asyncHandler(async (req, res) => {
  req.query.folder = "DRAFTS";
  return getSmtpMessages(req, res);
});

// =========================
// GET SMTP TRASH MESSAGES
// =========================
export const getSmtpTrashMessages = asyncHandler(async (req, res) => {
  req.query.folder = "TRASH";
  return getSmtpMessages(req, res);
});

// =========================
// GET SMTP SPAM MESSAGES
// =========================
export const getSmtpSpamMessages = asyncHandler(async (req, res) => {
  req.query.folder = "SPAM";
  return getSmtpMessages(req, res);
});

// =========================
// GET SMTP ARCHIVE MESSAGES
// =========================
export const getSmtpArchiveMessages = asyncHandler(async (req, res) => {
  req.query.folder = "ARCHIVE";
  return getSmtpMessages(req, res);
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

    // Try cache first
    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const imap = createImapConnection(sender);

    return new Promise((resolve, reject) => {
      imap.once("ready", async () => {
        try {
          await openMailbox(imap, folder);

          const fetchOptions = {
            bodies: "",
            struct: true,
          };

          const searchCriteria = [["UID", parseInt(messageId)]];
          const messages = await fetchMessages(
            imap,
            searchCriteria,
            fetchOptions,
          );

          if (messages.length === 0) {
            imap.end();
            throw new AppError("Message not found", 404);
          }

          const msg = messages[0];
          const fullEmail = msg.parts.map((part) => part.data).join("");

          const parsed = await simpleParser(fullEmail);

          const message = {
            id: msg.attributes?.uid || msg.seqno,
            uid: msg.attributes?.uid,
            seqno: msg.seqno,
            subject: parsed.subject || "(No Subject)",
            from: parsed.from?.text || "",
            to: parsed.to?.text || "",
            cc: parsed.cc?.text || "",
            bcc: parsed.bcc?.text || "",
            date: parsed.date || new Date(),
            text: parsed.text,
            html: parsed.html,
            attachments: parsed.attachments?.map((a) => ({
              filename: a.filename,
              contentType: a.contentType,
              size: a.size,
              contentId: a.contentId,
            })),
            flags: msg.attributes?.flags || [],
            isRead: msg.attributes?.flags?.includes("\\Seen") || false,
            isStarred: msg.attributes?.flags?.includes("\\Flagged") || false,
            isReplied: msg.attributes?.flags?.includes("\\Answered") || false,
            folder,
          };

          // Cache the message
          await setCachedData(cacheKey, message, CACHE_TTL.SINGLE_MESSAGE);

          imap.end();
          res.json({ success: true, data: message });
        } catch (error) {
          imap.end();
          reject(error);
        }
      });

      imap.once("error", (err) => {
        reject(new AppError(`IMAP connection failed: ${err.message}`, 500));
      });

      imap.connect();
    });
  });
});

// =========================
// GET SMTP FOLDERS
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
      console.log(`[CACHE HIT] SMTP folders for ${mailboxId}`);
      return res.json({ success: true, data: cached, fromCache: true });
    }

    console.log(`[CACHE MISS] Fetching SMTP folders for ${mailboxId}`);

    const imap = createImapConnection(sender);

    return new Promise((resolve, reject) => {
      imap.once("ready", () => {
        imap.getBoxes((err, boxes) => {
          if (err) {
            imap.end();
            reject(new AppError(`Failed to get folders: ${err.message}`, 500));
            return;
          }

          const processFolders = (boxObj, parentPath = "") => {
            let folders = [];

            for (const [name, box] of Object.entries(boxObj)) {
              const fullPath = parentPath
                ? `${parentPath}${imap.delimiter}${name}`
                : name;

              const folder = {
                id: fullPath,
                name: name,
                fullPath: fullPath,
                delimiter: imap.delimiter,
                hasChildren: box.children
                  ? Object.keys(box.children).length > 0
                  : false,
                attribs: box.attribs || [],
                folderType: mapFolderType(fullPath),
              };

              folders.push(folder);

              if (box.children) {
                folders = folders.concat(
                  processFolders(box.children, fullPath),
                );
              }
            }

            return folders;
          };

          let folders = processFolders(boxes);

          // Add counts to folders
          const getFolderCounts = async () => {
            const foldersWithCounts = [];

            for (const folder of folders) {
              try {
                await openMailbox(imap, folder.fullPath);

                // Get total count
                const total = await new Promise((res, rej) => {
                  imap.status(folder.fullPath, (err, status) => {
                    if (err) rej(err);
                    else res(status);
                  });
                });

                // Get unread count
                const unreadSearch = [["UNSEEN"]];
                const unread = await fetchMessages(imap, unreadSearch, {
                  bodies: "",
                  max: 0,
                });

                foldersWithCounts.push({
                  ...folder,
                  totalCount: total?.messages?.total || 0,
                  unreadCount: unread.length,
                });
              } catch (error) {
                foldersWithCounts.push({
                  ...folder,
                  totalCount: 0,
                  unreadCount: 0,
                });
              }
            }

            return foldersWithCounts;
          };

          getFolderCounts()
            .then((foldersWithCounts) => {
              // Sort folders: INBOX first, then SENT, DRAFTS, etc.
              foldersWithCounts.sort((a, b) => {
                const order = {
                  INBOX: 1,
                  SENT: 2,
                  DRAFTS: 3,
                  TRASH: 4,
                  SPAM: 5,
                  JUNK: 6,
                  ARCHIVE: 7,
                };

                const aOrder = order[a.name.toUpperCase()] || 8;
                const bOrder = order[b.name.toUpperCase()] || 8;

                if (aOrder !== bOrder) return aOrder - bOrder;
                return a.name.localeCompare(b.name);
              });

              const result = {
                folders: foldersWithCounts,
                flatList: foldersWithCounts,
              };

              // Cache the folders
              setCachedData(cacheKey, result, CACHE_TTL.FOLDERS);

              imap.end();
              res.json({ success: true, data: result });
            })
            .catch((error) => {
              imap.end();
              reject(error);
            });
        });
      });

      imap.once("error", (err) => {
        reject(new AppError(`IMAP connection failed: ${err.message}`, 500));
      });

      imap.connect();
    });
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
    const imap = createImapConnection(sender);

    return new Promise((resolve, reject) => {
      imap.once("ready", async () => {
        try {
          await openMailbox(imap, folder);

          // Mark as read by removing \Seen flag
          await new Promise((res, rej) => {
            imap.addFlags(parseInt(messageId), ["\\Seen"], (err) => {
              if (err) rej(err);
              else res();
            });
          });

          // Invalidate caches
          await deleteCachedData(
            generateCacheKey("smtp", mailboxId, "messages", "*"),
          );
          await deleteCachedData(
            generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
          );
          await deleteCachedData(
            generateCacheKey("smtp", mailboxId, "folders"),
          );

          imap.end();
          res.json({ success: true, message: "Message marked as read" });
        } catch (error) {
          imap.end();
          reject(error);
        }
      });

      imap.once("error", (err) => {
        reject(new AppError(`IMAP connection failed: ${err.message}`, 500));
      });

      imap.connect();
    });
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
    const imap = createImapConnection(sender);

    return new Promise((resolve, reject) => {
      imap.once("ready", async () => {
        try {
          await openMailbox(imap, folder);

          // Mark as unread by removing \Seen flag
          await new Promise((res, rej) => {
            imap.delFlags(parseInt(messageId), ["\\Seen"], (err) => {
              if (err) rej(err);
              else res();
            });
          });

          // Invalidate caches
          await deleteCachedData(
            generateCacheKey("smtp", mailboxId, "messages", "*"),
          );
          await deleteCachedData(
            generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
          );
          await deleteCachedData(
            generateCacheKey("smtp", mailboxId, "folders"),
          );

          imap.end();
          res.json({ success: true, message: "Message marked as unread" });
        } catch (error) {
          imap.end();
          reject(error);
        }
      });

      imap.once("error", (err) => {
        reject(new AppError(`IMAP connection failed: ${err.message}`, 500));
      });

      imap.connect();
    });
  });
});

// =========================
// DELETE SMTP MESSAGE (Move to trash)
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
    const imap = createImapConnection(sender);

    return new Promise((resolve, reject) => {
      imap.once("ready", async () => {
        try {
          await openMailbox(imap, folder);

          // Move to trash (add \Deleted flag and expunge)
          await new Promise((res, rej) => {
            imap.addFlags(parseInt(messageId), ["\\Deleted"], (err) => {
              if (err) rej(err);
              else res();
            });
          });

          // Permanently delete
          imap.expunge((err) => {
            if (err) reject(err);
          });

          // Invalidate all caches for this mailbox
          await deleteCachedData(generateCacheKey("smtp", mailboxId, "*"));

          imap.end();
          res.json({ success: true, message: "Message deleted successfully" });
        } catch (error) {
          imap.end();
          reject(error);
        }
      });

      imap.once("error", (err) => {
        reject(new AppError(`IMAP connection failed: ${err.message}`, 500));
      });

      imap.connect();
    });
  });
});

// =========================
// MOVE SMTP MESSAGE TO FOLDER
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
    const imap = createImapConnection(sender);

    return new Promise((resolve, reject) => {
      imap.once("ready", async () => {
        try {
          await openMailbox(imap, sourceFolder);

          // Move message to target folder
          await new Promise((res, rej) => {
            imap.move(parseInt(messageId), targetFolder, (err) => {
              if (err) rej(err);
              else res();
            });
          });

          // Invalidate caches
          await deleteCachedData(
            generateCacheKey("smtp", mailboxId, "messages", "*"),
          );
          await deleteCachedData(
            generateCacheKey("smtp", mailboxId, "message", messageId, "*"),
          );
          await deleteCachedData(
            generateCacheKey("smtp", mailboxId, "folders"),
          );

          imap.end();
          res.json({
            success: true,
            message: `Message moved to ${targetFolder}`,
          });
        } catch (error) {
          imap.end();
          reject(error);
        }
      });

      imap.once("error", (err) => {
        reject(new AppError(`IMAP connection failed: ${err.message}`, 500));
      });

      imap.connect();
    });
  });
});

// =========================
// SYNC SMTP MAILBOX
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
    const imap = createImapConnection(sender);

    return new Promise((resolve, reject) => {
      imap.once("ready", async () => {
        try {
          await openMailbox(imap, folder);

          // Test connection by getting box status
          const box = await openMailbox(imap, folder);

          // Update last sync timestamp
          const updateData = { lastInboxSyncAt: new Date() };
          if (folder.toUpperCase() === "SENT")
            updateData.lastSentSyncAt = new Date();
          if (folder.toUpperCase() === "DRAFTS")
            updateData.lastDraftsSyncAt = new Date();

          await sender.update(updateData);

          // Invalidate cache for this folder
          await deleteCachedData(
            generateCacheKey("smtp", mailboxId, "messages", folder, "*"),
          );
          await deleteCachedData(
            generateCacheKey("smtp", mailboxId, "folders"),
          );

          imap.end();
          res.json({
            success: true,
            message: `Mailbox synced successfully (${folder})`,
            data: {
              syncedAt: new Date(),
              folder,
              totalMessages: box.messages.total,
              unreadMessages: box.messages.unseen,
            },
          });
        } catch (error) {
          imap.end();
          reject(error);
        }
      });

      imap.once("error", (err) => {
        reject(new AppError(`IMAP connection failed: ${err.message}`, 500));
      });

      imap.connect();
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

    // Try cache first
    const cached = await getCachedData(cacheKey);
    if (cached) {
      return res.json({ success: true, data: cached, fromCache: true });
    }

    const imap = createImapConnection(sender);

    return new Promise((resolve, reject) => {
      imap.once("ready", async () => {
        try {
          // Get status for common folders
          const folders = ["INBOX", "SENT", "DRAFTS", "TRASH", "SPAM"];
          const statuses = {};

          for (const folder of folders) {
            try {
              const status = await new Promise((res, rej) => {
                imap.status(folder, (err, status) => {
                  if (err) rej(err);
                  else res(status);
                });
              });

              statuses[folder] = {
                total: status.messages?.total || 0,
                unread: status.messages?.unseen || 0,
                recent: status.messages?.recent || 0,
              };
            } catch (err) {
              statuses[folder] = { total: 0, unread: 0, recent: 0 };
            }
          }

          const result = {
            email: sender.email,
            domain: sender.domain,
            isConnected: true,
            folders: statuses,
            lastSyncAt: sender.lastInboxSyncAt,
          };

          // Cache status for 1 minute
          await setCachedData(cacheKey, result, 60);

          imap.end();
          res.json({ success: true, data: result });
        } catch (error) {
          imap.end();
          reject(error);
        }
      });

      imap.once("error", (err) => {
        reject(new AppError(`IMAP connection failed: ${err.message}`, 500));
      });

      imap.connect();
    });
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

  // Clear rate limiter
  clearMailboxLimiter(mailboxId, "smtp");

  // Clear all caches for this mailbox
  await deleteCachedData(generateCacheKey("smtp", mailboxId, "*"));

  await sender.destroy({ force: true });
  res.json({ success: true, message: "SMTP mailbox disconnected" });
});

// =========================
// HELPER: Map folder name to type
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
