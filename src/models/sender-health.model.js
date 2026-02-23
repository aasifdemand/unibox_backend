import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const SenderHealth = sequelize.define(
  "SenderHealth",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    senderId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
    },

    // DNS Checks
    spfValid: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    dkimValid: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    dmarcPolicy: {
      type: DataTypes.STRING,
      allowNull: true, // none | quarantine | reject
    },

    ptrValid: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    // Blacklist
    blacklisted: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    // Behavioral Metrics
    bounceRate: {
      type: DataTypes.FLOAT,
      defaultValue: 0,
    },

    complaintRate: {
      type: DataTypes.FLOAT,
      defaultValue: 0,
    },

    // Final Computed Score
    reputationScore: {
      type: DataTypes.INTEGER,
      defaultValue: 0,
    },

    // Health Status
    healthStatus: {
      type: DataTypes.STRING,
      defaultValue: "unknown", // healthy | warning | critical
    },

    lastCheckedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "sender_health",
    timestamps: true,
  },
);

export default SenderHealth;
