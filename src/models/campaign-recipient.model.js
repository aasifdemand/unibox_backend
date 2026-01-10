import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const CampaignRecipient = sequelize.define(
  "CampaignRecipient",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    campaignId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    email: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    name: {
      type: DataTypes.STRING,
      allowNull: true, // optional but recommended
    },

    metadata: {
      type: DataTypes.JSONB,
      defaultValue: {},
    },

    currentStep: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    status: {
      type: DataTypes.ENUM(
        "pending",
        "sent",
        "replied",
        "bounced",
        "completed",
        "stopped"
      ),
      defaultValue: "pending",
    },

    lastSentAt: DataTypes.DATE,
    repliedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    }

  },
  {
    tableName: "campaign_recipients",
    timestamps: true,
    indexes: [
      { fields: ["campaignId"] },
      { fields: ["email"] },
      { unique: true, fields: ["campaignId", "email"] },
    ],
  }
);

export default CampaignRecipient;
