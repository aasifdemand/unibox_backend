import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const Campaign = sequelize.define(
  "Campaign",
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

    senderId: {
      type: DataTypes.UUID,
      allowNull: false,
      // REMOVE THE REFERENCES since we have polymorphic associations
    },

    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    subject: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    htmlBody: {
      type: DataTypes.TEXT,
    },

    textBody: {
      type: DataTypes.TEXT,
    },
    listBatchId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    status: {
      type: DataTypes.ENUM(
        "draft",
        "scheduled",
        "running",
        "sending",
        "completed",
        "paused",
      ),
      allowNull: false,
      defaultValue: "draft",
    },

    scheduledAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // 👇 ADD THESE TRACKING FIELDS
    trackOpens: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    trackClicks: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },
    unsubscribeLink: {
      type: DataTypes.BOOLEAN,
      defaultValue: true,
    },

    // Stats fields
    totalSent: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalReplied: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalOpens: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },
    totalClicks: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    completedAt: {
      type: DataTypes.DATE,
    },

    timezone: {
      type: DataTypes.STRING,
      defaultValue: "UTC",
    },
    maxFollowUps: {
      type: DataTypes.INTEGER,
      defaultValue: 3,
    },

    throttlePerMinute: {
      type: DataTypes.INTEGER,
      defaultValue: 20,
    },
    // Add senderType field
    senderType: {
      type: DataTypes.ENUM("gmail", "outlook", "smtp"),
      allowNull: false,
      defaultValue: "smtp",
    },
  },
  {
    tableName: "campaigns",
    timestamps: true,
    paranoid: true,
    indexes: [
      { fields: ["userId"] },
      { fields: ["senderId"] },
      { fields: ["status"] },
      { fields: ["scheduledAt"] },
      // Add composite index for sender lookup
      { fields: ["senderId", "senderType"] },
    ],
  },
);

export default Campaign;
