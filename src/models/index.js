import User from "./user.model.js";
import Sender from "./sender.model.js";
import Campaign from "./campaign.model.js";
import CampaignStep from "./campaign-step.model.js";
import CampaignRecipient from "./campaign-recipient.model.js";
import CampaignSend from "./campaign-send.model.js";

import Email from "./email.model.js";
import EmailEvent from "./email-event.model.js";
import ReplyEvent from "./reply-event.model.js";
import BounceEvent from "./bounce-event.model.js";

import ListUploadBatch from "./list-upload-batch.model.js";
import ListUploadRecord from "./list-upload-record.model.js";
import GlobalEmailRegistry from "./global-email-registry.model.js";

/* =========================
   USER OWNERSHIP
========================= */

// User → Senders
User.hasMany(Sender, { foreignKey: "userId", onDelete: "CASCADE" });
Sender.belongsTo(User, { foreignKey: "userId" });

// User → Campaigns
User.hasMany(Campaign, { foreignKey: "userId", onDelete: "CASCADE" });
Campaign.belongsTo(User, { foreignKey: "userId" });

// User → Emails
User.hasMany(Email, { foreignKey: "userId", onDelete: "CASCADE" });
Email.belongsTo(User, { foreignKey: "userId" });

// User → List Upload Batches
User.hasMany(ListUploadBatch, { foreignKey: "userId", onDelete: "CASCADE" });
ListUploadBatch.belongsTo(User, { foreignKey: "userId" });

/* =========================
   SENDER RELATIONSHIPS
========================= */

// Sender → Campaigns
Sender.hasMany(Campaign, {
  foreignKey: "senderId",
  onDelete: "RESTRICT",
});
Campaign.belongsTo(Sender, { foreignKey: "senderId" });

// Sender → Emails
Sender.hasMany(Email, {
  foreignKey: "senderId",
  onDelete: "RESTRICT",
});
Email.belongsTo(Sender, { foreignKey: "senderId" });

// Sender → Campaign Sends (IMPORTANT for throttling & rotation)
Sender.hasMany(CampaignSend, {
  foreignKey: "senderId",
  onDelete: "RESTRICT",
});
CampaignSend.belongsTo(Sender, {
  foreignKey: "senderId",
});

/* =========================
   CAMPAIGN CORE
========================= */

// Campaign → Steps (follow-ups)
Campaign.hasMany(CampaignStep, {
  foreignKey: "campaignId",
  onDelete: "CASCADE",
});
CampaignStep.belongsTo(Campaign, {
  foreignKey: "campaignId",
});

// Campaign → Recipients (state machine)
Campaign.hasMany(CampaignRecipient, {
  foreignKey: "campaignId",
  onDelete: "CASCADE",
});
CampaignRecipient.belongsTo(Campaign, {
  foreignKey: "campaignId",
});

// Campaign → Sends (idempotency + history)
Campaign.hasMany(CampaignSend, {
  foreignKey: "campaignId",
  onDelete: "CASCADE",
});
CampaignSend.belongsTo(Campaign, {
  foreignKey: "campaignId",
});

/* =========================
   CAMPAIGN RECIPIENT LINKS
========================= */

// CampaignRecipient → Sends
CampaignRecipient.hasMany(CampaignSend, {
  foreignKey: "recipientId",
  onDelete: "CASCADE",
});
CampaignSend.belongsTo(CampaignRecipient, {
  foreignKey: "recipientId",
});

CampaignSend.belongsTo(Email, {
  foreignKey: "emailId",

  onDelete: "SET NULL",
});
/* =========================
   EMAIL LIFECYCLE
========================= */

// Campaign → Emails
Campaign.hasMany(Email, {
  foreignKey: "campaignId",
  onDelete: "SET NULL",
});
Email.belongsTo(Campaign, {
  foreignKey: "campaignId",
});

// Email → Events
Email.hasMany(EmailEvent, {
  foreignKey: "emailId",
  onDelete: "CASCADE",
});
EmailEvent.belongsTo(Email, {
  foreignKey: "emailId",
});

// Email → Replies
Email.hasMany(ReplyEvent, {
  foreignKey: "emailId",
  onDelete: "CASCADE",
});
ReplyEvent.belongsTo(Email, {
  foreignKey: "emailId",
});

// Email → Bounces
Email.hasMany(BounceEvent, {
  foreignKey: "emailId",
  onDelete: "CASCADE",
});
BounceEvent.belongsTo(Email, {
  foreignKey: "emailId",
});

/* =========================
   LIST UPLOAD PIPELINE
========================= */

// Batch → Records
ListUploadBatch.hasMany(ListUploadRecord, {
  foreignKey: "batchId",
  onDelete: "CASCADE",
});
ListUploadRecord.belongsTo(ListUploadBatch, {
  foreignKey: "batchId",
});

// Campaign → Source List Batch
Campaign.belongsTo(ListUploadBatch, {
  foreignKey: "listBatchId",
  onDelete: "RESTRICT",
});
ListUploadBatch.hasMany(Campaign, {
  foreignKey: "listBatchId",
});

/* =========================
   EMAIL VERIFICATION LINK
========================= */

// CampaignRecipient.email  → GlobalEmailRegistry.normalizedEmail
CampaignRecipient.hasOne(GlobalEmailRegistry, {
  sourceKey: "email",
  foreignKey: "normalizedEmail",
  constraints: false, // VERY IMPORTANT
});

GlobalEmailRegistry.belongsTo(CampaignRecipient, {
  targetKey: "email",
  foreignKey: "normalizedEmail",
  constraints: false,
});

export {
  User,
  Sender,
  Campaign,
  CampaignStep,
  CampaignRecipient,
  CampaignSend,
  Email,
  EmailEvent,
  ReplyEvent,
  BounceEvent,
  ListUploadBatch,
  ListUploadRecord,
  GlobalEmailRegistry,
};
