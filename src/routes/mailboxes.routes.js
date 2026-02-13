import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";

// Import Gmail controllers
import {
  getGmailMessages,
  getGmailSentMessages,
  getGmailTrashMessages,
  getGmailSpamMessages,
  getGmailStarredMessages,
  getGmailImportantMessages,
  getGmailMessage,
  markGmailAsRead,
  deleteGmailMessage,
  getGmailLabels,
  syncGmailMailbox,
  refreshGmailToken,
  disconnectGmailMailbox,
  getGmailDraftMessages,
} from "../controllers/gmail.controller.js";

// Import Outlook controllers
import {
  getOutlookMessages,
  getOutlookSentMessages,
  getOutlookTrashMessages,
  getOutlookSpamMessages,
  getOutlookArchiveMessages,
  getOutlookOutboxMessages,
  getOutlookMessage,
  markOutlookAsRead,
  deleteOutlookMessage,
  getOutlookFolders,
  syncOutlookMailbox,
  refreshOutlookToken,
  disconnectOutlookMailbox,
  getOutlookDrafts,
} from "../controllers/outlook.controller.js";

// Import SMTP controllers
import {
  getSmtpMessages,
  getSmtpSentMessages,
  getSmtpDraftMessages,
  getSmtpTrashMessages,
  getSmtpSpamMessages,
  getSmtpArchiveMessages,
  getSmtpMessage,
  markSmtpAsRead,
  markSmtpAsUnread,
  deleteSmtpMessage,
  moveSmtpMessage,
  getSmtpFolders,
  syncSmtpMailbox,
  getSmtpStatus,
  disconnectSmtpMailbox,
} from "../controllers/smtp.controller.js";

// Import common mailbox controllers
import {
  getMailboxes,
  getMailboxById,
} from "../controllers/mailboxes.controller.js";

const router = Router();

// =========================
// ALL ROUTES REQUIRE AUTH
// =========================
router.use(protect);

// =========================
// MAILBOX MANAGEMENT
// =========================
router.get("/", getMailboxes);
router.get("/:mailboxId", getMailboxById);

// =========================
// GMAIL ROUTES
// =========================
router.get("/gmail/:mailboxId/messages", getGmailMessages);
router.get("/gmail/:mailboxId/sent", getGmailSentMessages);
router.get("/gmail/:mailboxId/trash", getGmailTrashMessages);
router.get("/gmail/:mailboxId/spam", getGmailSpamMessages);
router.get("/gmail/:mailboxId/starred", getGmailStarredMessages);
router.get("/gmail/:mailboxId/important", getGmailImportantMessages);
router.get("/gmail/:mailboxId/messages/:messageId", getGmailMessage);
router.put("/gmail/:mailboxId/messages/:messageId/read", markGmailAsRead);
router.delete("/gmail/:mailboxId/messages/:messageId", deleteGmailMessage);
router.get("/gmail/:mailboxId/labels", getGmailLabels);
router.post("/gmail/:mailboxId/sync", syncGmailMailbox);
router.post("/gmail/:mailboxId/refresh", refreshGmailToken);
router.post("/gmail/:mailboxId/disconnect", disconnectGmailMailbox);
router.get("/gmail/:mailboxId/drafts", getGmailDraftMessages);

// =========================
// OUTLOOK ROUTES
// =========================
router.get("/outlook/:mailboxId/messages", getOutlookMessages);
router.get("/outlook/:mailboxId/sent", getOutlookSentMessages);
router.get("/outlook/:mailboxId/trash", getOutlookTrashMessages);
router.get("/outlook/:mailboxId/spam", getOutlookSpamMessages);
router.get("/outlook/:mailboxId/archive", getOutlookArchiveMessages);
router.get("/outlook/:mailboxId/outbox", getOutlookOutboxMessages);
router.get("/outlook/:mailboxId/messages/:messageId", getOutlookMessage);
router.put("/outlook/:mailboxId/messages/:messageId/read", markOutlookAsRead);
router.delete("/outlook/:mailboxId/messages/:messageId", deleteOutlookMessage);
router.get("/outlook/:mailboxId/folders", getOutlookFolders);
router.post("/outlook/:mailboxId/sync", syncOutlookMailbox);
router.post("/outlook/:mailboxId/refresh", refreshOutlookToken);
router.post("/outlook/:mailboxId/disconnect", disconnectOutlookMailbox);
router.get("/outlook/:mailboxId/drafts", getOutlookDrafts);

// =========================
// SMTP ROUTES (Custom Domains)
// =========================
// Main inbox
router.get("/smtp/:mailboxId/messages", getSmtpMessages);

// Folder-specific routes
router.get("/smtp/:mailboxId/sent", getSmtpSentMessages);
router.get("/smtp/:mailboxId/drafts", getSmtpDraftMessages);
router.get("/smtp/:mailboxId/trash", getSmtpTrashMessages);
router.get("/smtp/:mailboxId/spam", getSmtpSpamMessages);
router.get("/smtp/:mailboxId/archive", getSmtpArchiveMessages);

// Individual message operations
router.get("/smtp/:mailboxId/messages/:messageId", getSmtpMessage);
router.put("/smtp/:mailboxId/messages/:messageId/read", markSmtpAsRead);
router.put("/smtp/:mailboxId/messages/:messageId/unread", markSmtpAsUnread);
router.delete("/smtp/:mailboxId/messages/:messageId", deleteSmtpMessage);
router.post("/smtp/:mailboxId/messages/:messageId/move", moveSmtpMessage);

// Folder and mailbox management
router.get("/smtp/:mailboxId/folders", getSmtpFolders);
router.post("/smtp/:mailboxId/sync", syncSmtpMailbox);
router.get("/smtp/:mailboxId/status", getSmtpStatus);
router.post("/smtp/:mailboxId/disconnect", disconnectSmtpMailbox);

export default router;
