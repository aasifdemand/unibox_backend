import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const ReplyEvent = sequelize.define(
  "ReplyEvent",
  {
    id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
    emailId: { type: DataTypes.UUID, allowNull: false },
    replyFrom: DataTypes.STRING,
    subject: DataTypes.STRING,
    body: DataTypes.TEXT,
    metadata: DataTypes.JSONB,
    receivedAt: DataTypes.DATE,
  },
  {
    tableName: "reply_events",
    timestamps: true,
    updatedAt: false,
  }
);

export default ReplyEvent;
