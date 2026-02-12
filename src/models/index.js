import User from "./user.model.js";
import GmailSender from "./gmail-sender.model.js";
import OutlookSender from "./outlook-sender.model.js";
import SmtpSender from "./smtp-sender.model.js";
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

/* =====================================================
   USER OWNERSHIP
===================================================== */

// User → GmailSenders
User.hasMany(GmailSender, { foreignKey: "userId", onDelete: "CASCADE" });
GmailSender.belongsTo(User, { foreignKey: "userId" });

// User → OutlookSenders
User.hasMany(OutlookSender, { foreignKey: "userId", onDelete: "CASCADE" });
OutlookSender.belongsTo(User, { foreignKey: "userId" });

// User → SmtpSenders
User.hasMany(SmtpSender, { foreignKey: "userId", onDelete: "CASCADE" });
SmtpSender.belongsTo(User, { foreignKey: "userId" });

// User → Campaigns
User.hasMany(Campaign, { foreignKey: "userId", onDelete: "CASCADE" });
Campaign.belongsTo(User, { foreignKey: "userId" });

// User → Emails
User.hasMany(Email, { foreignKey: "userId", onDelete: "CASCADE" });
Email.belongsTo(User, { foreignKey: "userId" });

// User → List Upload Batches
User.hasMany(ListUploadBatch, { foreignKey: "userId", onDelete: "CASCADE" });
ListUploadBatch.belongsTo(User, { foreignKey: "userId" });

/* =====================================================
   POLYMORPHIC SENDER RELATIONSHIPS
   IMPORTANT: constraints: false everywhere
===================================================== */

/* ---------- Campaign ↔ Sender ---------- */

GmailSender.hasMany(Campaign, {
  foreignKey: "senderId",
  constraints: false,
});
Campaign.belongsTo(GmailSender, {
  foreignKey: "senderId",
  constraints: false,
});

OutlookSender.hasMany(Campaign, {
  foreignKey: "senderId",
  constraints: false,
});
Campaign.belongsTo(OutlookSender, {
  foreignKey: "senderId",
  constraints: false,
});

SmtpSender.hasMany(Campaign, {
  foreignKey: "senderId",
  constraints: false,
});
Campaign.belongsTo(SmtpSender, {
  foreignKey: "senderId",
  constraints: false,
});

/* ---------- Email ↔ Sender ---------- */

GmailSender.hasMany(Email, {
  foreignKey: "senderId",
  constraints: false,
});
Email.belongsTo(GmailSender, {
  foreignKey: "senderId",
  constraints: false,
});

OutlookSender.hasMany(Email, {
  foreignKey: "senderId",
  constraints: false,
});
Email.belongsTo(OutlookSender, {
  foreignKey: "senderId",
  constraints: false,
});

SmtpSender.hasMany(Email, {
  foreignKey: "senderId",
  constraints: false,
});
Email.belongsTo(SmtpSender, {
  foreignKey: "senderId",
  constraints: false,
});

/* ---------- CampaignSend ↔ Sender ---------- */

GmailSender.hasMany(CampaignSend, {
  foreignKey: "senderId",
  constraints: false,
});
CampaignSend.belongsTo(GmailSender, {
  foreignKey: "senderId",
  constraints: false,
});

OutlookSender.hasMany(CampaignSend, {
  foreignKey: "senderId",
  constraints: false,
});
CampaignSend.belongsTo(OutlookSender, {
  foreignKey: "senderId",
  constraints: false,
});

SmtpSender.hasMany(CampaignSend, {
  foreignKey: "senderId",
  constraints: false,
});
CampaignSend.belongsTo(SmtpSender, {
  foreignKey: "senderId",
  constraints: false,
});

/* =====================================================
   CAMPAIGN CORE
===================================================== */

// Campaign → Steps
Campaign.hasMany(CampaignStep, {
  foreignKey: "campaignId",
  onDelete: "CASCADE",
});
CampaignStep.belongsTo(Campaign, {
  foreignKey: "campaignId",
});

// Campaign → Recipients
Campaign.hasMany(CampaignRecipient, {
  foreignKey: "campaignId",
  onDelete: "CASCADE",
});
CampaignRecipient.belongsTo(Campaign, {
  foreignKey: "campaignId",
});

// Campaign → Sends
Campaign.hasMany(CampaignSend, {
  foreignKey: "campaignId",
  onDelete: "CASCADE",
});
CampaignSend.belongsTo(Campaign, {
  foreignKey: "campaignId",
});

/* =====================================================
   CAMPAIGN RECIPIENT LINKS
===================================================== */

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

/* =====================================================
   EMAIL LIFECYCLE
===================================================== */

Campaign.hasMany(Email, {
  foreignKey: "campaignId",
  onDelete: "SET NULL",
});
Email.belongsTo(Campaign, {
  foreignKey: "campaignId",
});

Email.hasMany(EmailEvent, {
  foreignKey: "emailId",
  onDelete: "CASCADE",
});
EmailEvent.belongsTo(Email, {
  foreignKey: "emailId",
});

Email.hasMany(ReplyEvent, {
  foreignKey: "emailId",
  onDelete: "CASCADE",
});
ReplyEvent.belongsTo(Email, {
  foreignKey: "emailId",
});

Email.hasMany(BounceEvent, {
  foreignKey: "emailId",
  onDelete: "CASCADE",
});
BounceEvent.belongsTo(Email, {
  foreignKey: "emailId",
});

/* =====================================================
   LIST UPLOAD PIPELINE
===================================================== */

ListUploadBatch.hasMany(ListUploadRecord, {
  foreignKey: "batchId",
  onDelete: "CASCADE",
});
ListUploadRecord.belongsTo(ListUploadBatch, {
  foreignKey: "batchId",
});

Campaign.belongsTo(ListUploadBatch, {
  foreignKey: "listBatchId",
  onDelete: "RESTRICT",
});
ListUploadBatch.hasMany(Campaign, {
  foreignKey: "listBatchId",
});

/* =====================================================
   EMAIL VERIFICATION LINK
===================================================== */

CampaignRecipient.hasOne(GlobalEmailRegistry, {
  sourceKey: "email",
  foreignKey: "normalizedEmail",
  constraints: false,
});

GlobalEmailRegistry.belongsTo(CampaignRecipient, {
  targetKey: "email",
  foreignKey: "normalizedEmail",
  constraints: false,
});

ListUploadRecord.hasOne(GlobalEmailRegistry, {
  sourceKey: "normalizedEmail",
  foreignKey: "normalizedEmail",
  constraints: false,
});

GlobalEmailRegistry.belongsTo(ListUploadRecord, {
  targetKey: "normalizedEmail",
  foreignKey: "normalizedEmail",
  constraints: false,
});

/* =====================================================
   HELPER FUNCTIONS
===================================================== */

export async function getSenderWithType(senderId, senderType) {
  switch (senderType) {
    case "gmail":
      return await GmailSender.findByPk(senderId);
    case "outlook":
      return await OutlookSender.findByPk(senderId);
    case "smtp":
      return await SmtpSender.findByPk(senderId);
    default:
      throw new Error(`Unknown sender type: ${senderType}`);
  }
}

export async function getUserSenders(userId) {
  const [gmailSenders, outlookSenders, smtpSenders] = await Promise.all([
    GmailSender.findAll({ where: { userId } }),
    OutlookSender.findAll({ where: { userId } }),
    SmtpSender.findAll({ where: { userId } }),
  ]);

  return {
    gmail: gmailSenders,
    outlook: outlookSenders,
    smtp: smtpSenders,
    all: [...gmailSenders, ...outlookSenders, ...smtpSenders],
  };
}

export {
  User,
  GmailSender,
  OutlookSender,
  SmtpSender,
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
