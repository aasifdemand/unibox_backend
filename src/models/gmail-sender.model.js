import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const GmailSender = sequelize.define(
  "GmailSender",
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
       GOOGLE OAUTH TOKENS
    ========================= */
    googleId: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    accessToken: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    refreshToken: {
      type: DataTypes.TEXT,
      allowNull: true, // Might not be returned on first auth
    },

    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },

    googleProfile: {
      type: DataTypes.JSONB, // Store clientId, clientSecret, redirectUri here
      allowNull: true,
    },

    /* =========================
       GOOGLE API SCOPES
    ========================= */
    scopes: {
      type: DataTypes.JSON,
      defaultValue: [
        "https://www.googleapis.com/auth/gmail.send",
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify",
        "https://www.googleapis.com/auth/gmail.metadata",
      ],
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
       GOOGLE SPECIFIC FIELDS
    ========================= */
    googleProfile: {
      type: DataTypes.JSON,
      allowNull: true,
    },

    picture: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    timezone: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    tableName: "gmail_senders",
    timestamps: true,
    paranoid: true,
    indexes: [
      { unique: true, fields: ["email"] },
      { fields: ["userId"] },
      { fields: ["googleId"] },
      { fields: ["isVerified"] },
    ],
  },
);

export default GmailSender;
