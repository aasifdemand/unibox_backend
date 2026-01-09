import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const Sender = sequelize.define(
  "senders",
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
       PROVIDER
    ========================= */
    provider: {
      type: DataTypes.ENUM("gmail", "smtp", "outlook"),
      allowNull: false,
    },

    /* =========================
       SMTP (Gmail / Custom)
    ========================= */
    smtpHost: DataTypes.STRING,
    smtpPort: DataTypes.INTEGER,
    smtpSecure: DataTypes.BOOLEAN,
    smtpUser: DataTypes.STRING,
    smtpPass: DataTypes.STRING,

    /* =========================
       MICROSOFT OAUTH
    ========================= */
    oauthProvider: {
      type: DataTypes.STRING, // "microsoft"
    },

    oauthClientId: DataTypes.STRING,
    oauthTenantId: DataTypes.STRING,

    oauthAccessToken: DataTypes.TEXT,
    oauthRefreshToken: DataTypes.TEXT,

    oauthExpiresAt: DataTypes.DATE,

    /* =========================
       STATE
    ========================= */
    isVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

  },
  {
    tableName: "senders",
    timestamps: true,
    paranoid: true,
    indexes: [{ fields: ["email"], unique: true }],
  }
);

export default Sender;
