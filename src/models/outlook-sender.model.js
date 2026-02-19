import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const OutlookSender = sequelize.define(
  "OutlookSender",
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
       MICROSOFT OAUTH TOKENS
    ========================= */
    microsoftId: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    tenantId: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    accessToken: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    refreshToken: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },

    /* =========================
       MICROSOFT API SCOPES
    ========================= */
    scopes: {
      type: DataTypes.JSON,
      defaultValue: ["User.Read", "Mail.Send", "Mail.Read"],
    },

    /* =========================
       STATE & METADATA
    ========================= */
    isVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    dailySentCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    dailySentResetAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    /* =========================
       MICROSOFT SPECIFIC FIELDS
    ========================= */
    microsoftProfile: {
      type: DataTypes.JSON,
      allowNull: true,
    },

    jobTitle: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    companyName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // Add to GmailSender, OutlookSender, and SmtpSender models
    lastReplyCheckAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "outlook_senders",
    timestamps: true,
    paranoid: true,
    indexes: [
      { unique: true, fields: ["email"] },
      { fields: ["userId"] },
      { fields: ["microsoftId"] },
      { fields: ["isVerified"] },
    ],
  },
);

export default OutlookSender;
