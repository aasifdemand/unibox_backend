import { Router } from "express";
import { protect } from "../middlewares/auth.middleware.js";
import {
  // List mailboxes
  getMailboxes,
  getMailboxById,

  // Gmail operations
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

  // Outlook operations
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

  // SMTP operations
  disconnectSmtpMailbox,
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
// Main inbox
router.get("/gmail/:mailboxId/messages", getGmailMessages);

// Folder-specific routes
router.get("/gmail/:mailboxId/sent", getGmailSentMessages);
router.get("/gmail/:mailboxId/trash", getGmailTrashMessages);
router.get("/gmail/:mailboxId/spam", getGmailSpamMessages);
router.get("/gmail/:mailboxId/starred", getGmailStarredMessages);
router.get("/gmail/:mailboxId/important", getGmailImportantMessages);

// Individual message operations
router.get("/gmail/:mailboxId/messages/:messageId", getGmailMessage);
router.put("/gmail/:mailboxId/messages/:messageId/read", markGmailAsRead);
router.delete("/gmail/:mailboxId/messages/:messageId", deleteGmailMessage);

// Label and mailbox management
router.get("/gmail/:mailboxId/labels", getGmailLabels);
router.post("/gmail/:mailboxId/sync", syncGmailMailbox);
router.post("/gmail/:mailboxId/refresh", refreshGmailToken);
router.post("/gmail/:mailboxId/disconnect", disconnectGmailMailbox);

// =========================
// OUTLOOK ROUTES
// =========================
// Main inbox
router.get("/outlook/:mailboxId/messages", getOutlookMessages);

// Folder-specific routes
router.get("/outlook/:mailboxId/sent", getOutlookSentMessages);
router.get("/outlook/:mailboxId/trash", getOutlookTrashMessages);
router.get("/outlook/:mailboxId/spam", getOutlookSpamMessages);
router.get("/outlook/:mailboxId/archive", getOutlookArchiveMessages);
router.get("/outlook/:mailboxId/outbox", getOutlookOutboxMessages);

// Individual message operations
router.get("/outlook/:mailboxId/messages/:messageId", getOutlookMessage);
router.put("/outlook/:mailboxId/messages/:messageId/read", markOutlookAsRead);
router.delete("/outlook/:mailboxId/messages/:messageId", deleteOutlookMessage);

// Folder and mailbox management
router.get("/outlook/:mailboxId/folders", getOutlookFolders);
router.post("/outlook/:mailboxId/sync", syncOutlookMailbox);
router.post("/outlook/:mailboxId/refresh", refreshOutlookToken);
router.post("/outlook/:mailboxId/disconnect", disconnectOutlookMailbox);

// =========================
// SMTP ROUTES
// =========================
router.post("/smtp/:mailboxId/disconnect", disconnectSmtpMailbox);

export default router;
