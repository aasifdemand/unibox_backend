import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const CampaignSend = sequelize.define(
  "CampaignSend",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    campaignId: DataTypes.UUID,
    recipientId: DataTypes.UUID,
    step: DataTypes.INTEGER,

    senderId: DataTypes.UUID,
    emailId: DataTypes.UUID,

    status: {
      type: DataTypes.ENUM("queued", "sent", "failed", "skipped"),
      defaultValue: "queued",
    },

    sentAt: DataTypes.DATE,
    openedAt: DataTypes.DATE,
    repliedAt: DataTypes.DATE,
    // Add senderType field
    senderType: {
      type: DataTypes.ENUM("gmail", "outlook", "smtp"),
      allowNull: false,
      defaultValue: "smtp",
    },
  },

  {
    tableName: "campaign_sends",
    timestamps: true,
    indexes: [
      { unique: true, fields: ["campaignId", "recipientId", "step"] },
      { fields: ["sentAt"] },
      { fields: ["status"] },
    ],
  },
);

export default CampaignSend;
