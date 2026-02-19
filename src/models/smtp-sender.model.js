import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const SmtpSender = sequelize.define(
  "SmtpSender",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: {
        isEmail: true,
      },
    },

    displayName: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    domain: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    /* =========================
       SMTP SETTINGS (SEND)
    ========================= */
    smtpHost: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    smtpPort: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 587,
    },

    smtpSecure: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

    smtpUsername: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    smtpPassword: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    /* =========================
       IMAP SETTINGS (RECEIVE)
    ========================= */
    imapHost: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    imapPort: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 993,
    },

    imapSecure: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

    imapUsername: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    imapPassword: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    lastInboxSyncAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    /* =========================
       CONNECTION TEST RESULTS
    ========================= */
    smtpTestResult: {
      type: DataTypes.JSON,
      allowNull: true,
    },

    imapTestResult: {
      type: DataTypes.JSON,
      allowNull: true,
    },

    lastTestedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    /* =========================
       SECURITY & AUTHENTICATION
    ========================= */
    authMethod: {
      type: DataTypes.ENUM("PLAIN", "LOGIN", "CRAM-MD5", "XOAUTH2"),
      defaultValue: "PLAIN",
    },

    tlsVersion: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    dkimEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    spfEnabled: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    /* =========================
       RATE LIMITING & QUOTAS
    ========================= */
    dailyLimit: {
      type: DataTypes.INTEGER,
      defaultValue: 500,
    },

    hourlyLimit: {
      type: DataTypes.INTEGER,
      defaultValue: 100,
    },

    dailySentCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    hourlySentCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    lastSentAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    /* =========================
       STATE & METADATA
    ========================= */
    isVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    isActive: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

    verificationError: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    provider: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "e.g., AWS SES, SendGrid, Mailgun, Custom",
    },
    // Add to GmailSender, OutlookSender, and SmtpSender models
    lastReplyCheckAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "smtp_senders",
    timestamps: true,
    paranoid: true,
    indexes: [
      { unique: true, fields: ["email"] },
      { fields: ["userId"] },
      { fields: ["domain"] },
      { fields: ["isVerified"] },
      { fields: ["isActive"] },
      { fields: ["provider"] },
    ],
  },
);

export default SmtpSender;
