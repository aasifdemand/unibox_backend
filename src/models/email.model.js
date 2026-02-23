// models/email.model.js
import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const Email = sequelize.define(
  "Email",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "users",
        key: "id",
      },
    },
    campaignId: {
      type: DataTypes.UUID,
      references: {
        model: "campaigns",
        key: "id",
      },
    },
    recipientId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "campaign_recipients",
        key: "id",
      },
    },
    senderId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    recipientEmail: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    // ✅ CRITICAL: Provider message IDs for reply tracking
    providerMessageId: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: true,
    },

    providerThreadId: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Thread ID from email provider (Gmail/Outlook)",
    },

    providerConversationId: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "Conversation ID for threading",
    },

    // ✅ Add these for better matching
    subject: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    htmlBody: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    textBody: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    status: {
      type: DataTypes.STRING,
      defaultValue: "queued",
    },

    metadata: DataTypes.JSONB,

    senderType: {
      type: DataTypes.ENUM("gmail", "outlook", "smtp"),
      allowNull: false,
      defaultValue: "smtp",
    },

    deliveryProvider: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    deliveryConfidence: {
      type: DataTypes.FLOAT,
      allowNull: true,
    },
    routedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // Tracking fields
    openedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    clickedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    clickCount: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    userAgent: {
      type: DataTypes.TEXT,
      allowNull: true,
    },

    ipAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    sentAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    deliveredAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // ✅ Add repliedAt field
    repliedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    bouncedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    bounceType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    bounceReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    tableName: "emails",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["campaignId"] },
      { fields: ["recipientId"] },
      { fields: ["status"] },
      { fields: ["providerMessageId"] },
      { fields: ["providerThreadId"] },
      { fields: ["providerConversationId"] },
    ],
  },
);

export default Email;
