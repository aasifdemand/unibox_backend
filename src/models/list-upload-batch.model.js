import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const ListUploadBatch = sequelize.define(
  "ListUploadBatch",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },

    originalFilename: {
      type: DataTypes.STRING,
    },

    storagePath: {
      type: DataTypes.STRING,
    },

    fileType: {
      type: DataTypes.ENUM("csv", "xlsx", "txt"),
      allowNull: false,
    },

    status: {
      type: DataTypes.ENUM(
        "uploaded",
        "parsing",
        "deduping",
        "queued",
        "completed",
        "failed"
      ),
      defaultValue: "uploaded",
    },

    totalRecords: DataTypes.INTEGER,
    validRecords: DataTypes.INTEGER,
    duplicateRecords: DataTypes.INTEGER,
    failedRecords: DataTypes.INTEGER,

    checksum: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    errorReason: DataTypes.TEXT,
  },
  {
    tableName: "list_upload_batches",
    timestamps: true,
    indexes: [
      { fields: ["userId"] },
      { fields: ["status"] },
      { unique: true, fields: ["userId", "checksum"] },
    ],
  }
);

export default ListUploadBatch;
