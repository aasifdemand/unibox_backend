import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const GlobalEmailRegistry = sequelize.define(
  "GlobalEmailRegistry",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    normalizedEmail: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },

    domain: DataTypes.STRING,

    /* =========================
       VERIFICATION FIELDS
    ========================= */

    verificationStatus: {
      type: DataTypes.ENUM("valid", "invalid", "risky", "unknown", "verifying"),
      defaultValue: "unknown",
    },

    verificationScore: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },

    verificationProvider: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    verifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    verificationMeta: {
      type: DataTypes.JSONB,
      defaultValue: {},
    },

    firstSeenAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    lastSeenAt: DataTypes.DATE,
  },
  {
    tableName: "global_email_registry",
    timestamps: false,
    indexes: [
      { unique: true, fields: ["normalizedEmail"] },
      { fields: ["verificationStatus"] },
      { fields: ["verifiedAt"] },
    ],
  }
);

export default GlobalEmailRegistry;
