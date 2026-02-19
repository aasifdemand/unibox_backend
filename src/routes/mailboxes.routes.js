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
  markGmailAsUnread,
  deleteGmailMessage,
  permanentlyDeleteGmailMessage,
  getGmailLabels,
  syncGmailMailbox,
  refreshGmailToken,
  disconnectGmailMailbox,
  getGmailDraftMessages,
  sendGmailMessage,
  replyToGmailMessage,
  forwardGmailMessage,
  createGmailDraft,
  updateGmailDraft,
  deleteGmailDraft,
  sendGmailDraft,
  toggleGmailStarred,
  toggleGmailImportant,
  getGmailAttachment,
  getGmailMessageAttachments,
  batchGmailOperations,
  searchGmailMessages,
  modifyGmailMessageLabels,
  getGmailThreads,
  getGmailProfile,
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
  markOutlookAsUnread,
  deleteOutlookMessage,
  moveOutlookMessage,
  copyOutlookMessage,
  getOutlookFolders,
  createOutlookFolder,
  updateOutlookFolder,
  deleteOutlookFolder,
  syncOutlookMailbox,
  refreshOutlookToken,
  disconnectOutlookMailbox,
  getOutlookDrafts,
  sendOutlookMessage,
  replyToOutlookMessage,
  forwardOutlookMessage,
  createOutlookDraft,
  updateOutlookDraft,
  deleteOutlookDraft,
  sendOutlookDraft,
  createOutlookReplyDraft,
  createOutlookForwardDraft,
  toggleOutlookFlag,
  getOutlookAttachments,
  downloadOutlookAttachment,
  getOutlookProfile,
  searchOutlookMessages,
  batchOutlookOperations,
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
  copySmtpMessage,
  getSmtpFolders,
  syncSmtpMailbox,
  getSmtpStatus,
  disconnectSmtpMailbox,
  sendSmtpMessage,
  createSmtpDraft,
  updateSmtpDraft,
  deleteSmtpDraft,
  sendSmtpDraft,
  toggleSmtpFlag,
  getSmtpAttachments,
  downloadSmtpAttachment,
  batchSmtpOperations,
  searchSmtpMessages,
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

// Message listing routes
router.get("/gmail/:mailboxId/messages", getGmailMessages);
router.get("/gmail/:mailboxId/sent", getGmailSentMessages);
router.get("/gmail/:mailboxId/trash", getGmailTrashMessages);
router.get("/gmail/:mailboxId/spam", getGmailSpamMessages);
router.get("/gmail/:mailboxId/starred", getGmailStarredMessages);
router.get("/gmail/:mailboxId/important", getGmailImportantMessages);
router.get("/gmail/:mailboxId/drafts", getGmailDraftMessages);
router.get("/gmail/:mailboxId/search", searchGmailMessages);
router.get("/gmail/:mailboxId/threads", getGmailThreads);
router.get("/gmail/:mailboxId/profile", getGmailProfile);

// Message operations
router.get("/gmail/:mailboxId/messages/:messageId", getGmailMessage);
router.put("/gmail/:mailboxId/messages/:messageId/read", markGmailAsRead);
router.put("/gmail/:mailboxId/messages/:messageId/unread", markGmailAsUnread);
router.put("/gmail/:mailboxId/messages/:messageId/star", toggleGmailStarred);
router.put(
  "/gmail/:mailboxId/messages/:messageId/important",
  toggleGmailImportant,
);
router.delete("/gmail/:mailboxId/messages/:messageId", deleteGmailMessage);
router.delete(
  "/gmail/:mailboxId/messages/:messageId/permanent",
  permanentlyDeleteGmailMessage,
);
router.post(
  "/gmail/:mailboxId/messages/:messageId/labels",
  modifyGmailMessageLabels,
);

// Compose and reply
router.post("/gmail/:mailboxId/send", sendGmailMessage);
router.post("/gmail/:mailboxId/messages/:messageId/reply", replyToGmailMessage);
router.post(
  "/gmail/:mailboxId/messages/:messageId/forward",
  forwardGmailMessage,
);

// Draft operations
router.post("/gmail/:mailboxId/drafts", createGmailDraft);
router.put("/gmail/:mailboxId/drafts/:draftId", updateGmailDraft);
router.delete("/gmail/:mailboxId/drafts/:draftId", deleteGmailDraft);
router.post("/gmail/:mailboxId/drafts/:draftId/send", sendGmailDraft);

// Attachments
router.get(
  "/gmail/:mailboxId/messages/:messageId/attachments",
  getGmailMessageAttachments,
);
router.get(
  "/gmail/:mailboxId/messages/:messageId/attachments/:attachmentId",
  getGmailAttachment,
);

// Batch operations
router.post("/gmail/:mailboxId/batch", batchGmailOperations);

// Mailbox management
router.get("/gmail/:mailboxId/labels", getGmailLabels);
router.post("/gmail/:mailboxId/sync", syncGmailMailbox);
router.post("/gmail/:mailboxId/refresh", refreshGmailToken);
router.post("/gmail/:mailboxId/disconnect", disconnectGmailMailbox);

// =========================
// OUTLOOK ROUTES
// =========================

// Message listing routes
router.get("/outlook/:mailboxId/messages", getOutlookMessages);
router.get("/outlook/:mailboxId/sent", getOutlookSentMessages);
router.get("/outlook/:mailboxId/trash", getOutlookTrashMessages);
router.get("/outlook/:mailboxId/spam", getOutlookSpamMessages);
router.get("/outlook/:mailboxId/archive", getOutlookArchiveMessages);
router.get("/outlook/:mailboxId/outbox", getOutlookOutboxMessages);
router.get("/outlook/:mailboxId/drafts", getOutlookDrafts);
router.get("/outlook/:mailboxId/search", searchOutlookMessages);

// Message operations
router.get("/outlook/:mailboxId/messages/:messageId", getOutlookMessage);
router.put("/outlook/:mailboxId/messages/:messageId/read", markOutlookAsRead);
router.put(
  "/outlook/:mailboxId/messages/:messageId/unread",
  markOutlookAsUnread,
);
router.put("/outlook/:mailboxId/messages/:messageId/flag", toggleOutlookFlag);
router.delete("/outlook/:mailboxId/messages/:messageId", deleteOutlookMessage);
router.post("/outlook/:mailboxId/messages/:messageId/move", moveOutlookMessage);
router.post("/outlook/:mailboxId/messages/:messageId/copy", copyOutlookMessage);

// Compose and reply
router.post("/outlook/:mailboxId/send", sendOutlookMessage);
router.post(
  "/outlook/:mailboxId/messages/:messageId/reply",
  replyToOutlookMessage,
);
router.post(
  "/outlook/:mailboxId/messages/:messageId/forward",
  forwardOutlookMessage,
);

// Draft operations
router.post("/outlook/:mailboxId/drafts", createOutlookDraft);
router.put("/outlook/:mailboxId/drafts/:messageId", updateOutlookDraft);
router.delete("/outlook/:mailboxId/drafts/:messageId", deleteOutlookDraft);
router.post("/outlook/:mailboxId/drafts/:messageId/send", sendOutlookDraft);
router.post(
  "/outlook/:mailboxId/messages/:messageId/createReplyDraft",
  createOutlookReplyDraft,
);
router.post(
  "/outlook/:mailboxId/messages/:messageId/createForwardDraft",
  createOutlookForwardDraft,
);

// Attachments
router.get(
  "/outlook/:mailboxId/messages/:messageId/attachments",
  getOutlookAttachments,
);
router.get(
  "/outlook/:mailboxId/messages/:messageId/attachments/:attachmentId",
  downloadOutlookAttachment,
);

// Folder management
router.get("/outlook/:mailboxId/folders", getOutlookFolders);
router.post("/outlook/:mailboxId/folders", createOutlookFolder);
router.put("/outlook/:mailboxId/folders/:folderId", updateOutlookFolder);
router.delete("/outlook/:mailboxId/folders/:folderId", deleteOutlookFolder);

// Profile
router.get("/outlook/:mailboxId/profile", getOutlookProfile);

// Batch operations
router.post("/outlook/:mailboxId/batch", batchOutlookOperations);

// Mailbox management
router.post("/outlook/:mailboxId/sync", syncOutlookMailbox);
router.post("/outlook/:mailboxId/refresh", refreshOutlookToken);
router.post("/outlook/:mailboxId/disconnect", disconnectOutlookMailbox);

// =========================
// SMTP ROUTES (Custom Domains)
// =========================

// Message listing routes
router.get("/smtp/:mailboxId/messages", getSmtpMessages);
router.get("/smtp/:mailboxId/sent", getSmtpSentMessages);
router.get("/smtp/:mailboxId/drafts", getSmtpDraftMessages);
router.get("/smtp/:mailboxId/trash", getSmtpTrashMessages);
router.get("/smtp/:mailboxId/spam", getSmtpSpamMessages);
router.get("/smtp/:mailboxId/archive", getSmtpArchiveMessages);
router.get("/smtp/:mailboxId/search", searchSmtpMessages);

// Individual message operations
router.get("/smtp/:mailboxId/messages/:messageId", getSmtpMessage);
router.put("/smtp/:mailboxId/messages/:messageId/read", markSmtpAsRead);
router.put("/smtp/:mailboxId/messages/:messageId/unread", markSmtpAsUnread);
router.put("/smtp/:mailboxId/messages/:messageId/flag", toggleSmtpFlag);
router.delete("/smtp/:mailboxId/messages/:messageId", deleteSmtpMessage);
router.post("/smtp/:mailboxId/messages/:messageId/move", moveSmtpMessage);
router.post("/smtp/:mailboxId/messages/:messageId/copy", copySmtpMessage);

// Compose
router.post("/smtp/:mailboxId/send", sendSmtpMessage);

// Draft operations
router.post("/smtp/:mailboxId/drafts", createSmtpDraft);
router.put("/smtp/:mailboxId/drafts/:messageId", updateSmtpDraft);
router.delete("/smtp/:mailboxId/drafts/:messageId", deleteSmtpDraft);
router.post("/smtp/:mailboxId/drafts/:messageId/send", sendSmtpDraft);

// Attachments
router.get(
  "/smtp/:mailboxId/messages/:messageId/attachments",
  getSmtpAttachments,
);
router.get(
  "/smtp/:mailboxId/messages/:messageId/attachments/:attachmentId",
  downloadSmtpAttachment,
);

// Batch operations
router.post("/smtp/:mailboxId/batch", batchSmtpOperations);

// Folder and mailbox management
router.get("/smtp/:mailboxId/folders", getSmtpFolders);
router.post("/smtp/:mailboxId/sync", syncSmtpMailbox);
router.get("/smtp/:mailboxId/status", getSmtpStatus);
router.post("/smtp/:mailboxId/disconnect", disconnectSmtpMailbox);

export default router;
