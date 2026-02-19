// models/reply-event.model.js
import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const ReplyEvent = sequelize.define(
  "ReplyEvent",
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    emailId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "emails",
        key: "id",
      },
    },
    campaignId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: {
        model: "campaigns",
        key: "id",
      },
    },
    replyFrom: DataTypes.STRING,
    replyTo: DataTypes.STRING,
    subject: DataTypes.STRING,
    body: DataTypes.TEXT,

    // ✅ Add provider IDs for better tracking
    providerMessageId: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    providerThreadId: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    providerConversationId: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    isFollowUp: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    metadata: DataTypes.JSONB,
    receivedAt: DataTypes.DATE,
  },
  {
    tableName: "reply_events",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["emailId"] },
      { fields: ["campaignId"] },
      { fields: ["providerMessageId"] },
      { fields: ["providerThreadId"] },
      { fields: ["providerConversationId"] },
    ],
  },
);

export default ReplyEvent;
