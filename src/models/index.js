import User from "./user.model.js";
import Sender from "./sender.model.js";
import Campaign from "./campaign.model.js";
import Email from "./email.model.js";
import EmailEvent from "./email-event.model.js";
import ReplyEvent from "./reply-event.model.js";
import BounceEvent from "./bounce-event.model.js";
import ListUploadBatch from "./list-upload-batch.model.js";
import ListUploadRecord from "./list-upload-record.model.js";

/* =========================
   USER RELATIONSHIPS
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
   SENDER / CAMPAIGN
========================= */

// Sender → Campaigns
Sender.hasMany(Campaign, { foreignKey: "senderId", onDelete: "RESTRICT" });
Campaign.belongsTo(Sender, { foreignKey: "senderId" });

/* =========================
   CAMPAIGN / EMAIL
========================= */

// Campaign → Emails
Campaign.hasMany(Email, { foreignKey: "campaignId", onDelete: "SET NULL" });
Email.belongsTo(Campaign, { foreignKey: "campaignId" });

// Sender → Emails
Sender.hasMany(Email, { foreignKey: "senderId", onDelete: "RESTRICT" });
Email.belongsTo(Sender, { foreignKey: "senderId" });

/* =========================
   EMAIL EVENTS
========================= */

// Email → Lifecycle Events
Email.hasMany(EmailEvent, { foreignKey: "emailId", onDelete: "CASCADE" });
EmailEvent.belongsTo(Email, { foreignKey: "emailId" });

// Email → Replies
Email.hasMany(ReplyEvent, { foreignKey: "emailId", onDelete: "CASCADE" });
ReplyEvent.belongsTo(Email, { foreignKey: "emailId" });

// Email → Bounces
Email.hasMany(BounceEvent, { foreignKey: "emailId", onDelete: "CASCADE" });
BounceEvent.belongsTo(Email, { foreignKey: "emailId" });

/* =========================
   LIST UPLOAD PIPELINE
========================= */

// Batch → Records
ListUploadBatch.hasMany(ListUploadRecord, {
  foreignKey: "batchId",
  onDelete: "CASCADE",
});
ListUploadRecord.belongsTo(ListUploadBatch, { foreignKey: "batchId" });

export {
  User,
  Sender,
  Campaign,
  Email,
  EmailEvent,
  ReplyEvent,
  BounceEvent,
  ListUploadBatch,
  ListUploadRecord,
};
