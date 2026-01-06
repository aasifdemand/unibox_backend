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
    userId: { type: DataTypes.UUID, allowNull: false },
    campaignId: DataTypes.UUID,
    senderId: { type: DataTypes.UUID, allowNull: false },

    recipientEmail: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    providerMessageId: {
      type: DataTypes.STRING,
      unique: true,
    },

    status: {
      type: DataTypes.STRING,
      defaultValue: "queued",
    },

    metadata: DataTypes.JSONB,
  },
  {
    tableName: "emails",
    timestamps: true,
    updatedAt: false,
  }
);

export default Email;
