import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const EmailEvent = sequelize.define(
  "EmailEvent",
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    emailId: { type: DataTypes.UUID, allowNull: false },
    eventType: { type: DataTypes.STRING, allowNull: false },
    eventTimestamp: { type: DataTypes.DATE, allowNull: false },
    metadata: DataTypes.JSONB,
  },
  {
    tableName: "email_events",
    timestamps: true,
    updatedAt: false,
  }
);

export default EmailEvent;
