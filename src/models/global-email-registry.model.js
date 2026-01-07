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

    firstSeenAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    lastSeenAt: DataTypes.DATE,
  },
  {
    tableName: "global_email_registry",
    timestamps: false,
    indexes: [{ unique: true, fields: ["normalizedEmail"] }],
  }
);

export default GlobalEmailRegistry;
