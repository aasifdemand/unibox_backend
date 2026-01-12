import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const CampaignStep = sequelize.define(
  "CampaignStep",
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

    stepOrder: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },

    subject: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    htmlBody: {
      type: DataTypes.TEXT,
      allowNull: false,
    },

    textBody: {
      type: DataTypes.TEXT,
    },

    delayMinutes: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    condition: {
      type: DataTypes.ENUM("always", "no_reply"),
      defaultValue: "always",
    },
  },
  {
    tableName: "campaign_steps",
    timestamps: true,
    indexes: [{ unique: true, fields: ["campaignId", "stepOrder"] }],
  }
);

export default CampaignStep;
