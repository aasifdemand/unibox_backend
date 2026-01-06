import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const BounceEvent = sequelize.define(
  "BounceEvent",
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    emailId: { type: DataTypes.UUID, allowNull: false },
    bounceType: { type: DataTypes.STRING, allowNull: false },
    reason: DataTypes.STRING,
    smtpResponse: DataTypes.TEXT,
    metadata: DataTypes.JSONB,
    occurredAt: DataTypes.DATE,
  },
  {
    tableName: "bounce_events",
    timestamps: true,
    updatedAt: false,
  }
);

export default BounceEvent;
