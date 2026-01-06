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

    status: {
      type: DataTypes.ENUM(
        "draft",
        "scheduled",
        "sending",
        "completed",
        "paused"
      ),
      allowNull: false,
      defaultValue: "draft",
    },

    scheduledAt: {
      type: DataTypes.DATE,
    },
  },
  {
    tableName: "campaigns",
    timestamps: true,
    paranoid: true, // enables deletedAt
    indexes: [
      { fields: ["userId"] },
      { fields: ["senderId"] },
      { fields: ["status"] },
      { fields: ["scheduledAt"] },
    ],
  }
);

export default Campaign;
