import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const ListUploadRecord = sequelize.define(
  "ListUploadRecord",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    batchId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    rawEmail: DataTypes.STRING,
    normalizedEmail: DataTypes.STRING,
    domain: DataTypes.STRING,
    name: DataTypes.STRING,

    metadata: DataTypes.JSONB,

    status: {
      type: DataTypes.ENUM(
        "parsed",
        "duplicate",
        "invalid",
        "queued",
        "completed",
        "failed"
      ),
      defaultValue: "parsed",
    },

    failureReason: DataTypes.TEXT,
  },
  {
    tableName: "list_upload_records",
    timestamps: true,
    updatedAt: false,
    indexes: [
      { fields: ["batchId"] },
      { fields: ["normalizedEmail"] },
      { fields: ["status"] },
    ],
  }
);

export default ListUploadRecord;
