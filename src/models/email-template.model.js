import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const EmailTemplate = sequelize.define(
  "EmailTemplate",
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

    name: {
      type: DataTypes.STRING(150),
      allowNull: false,
    },

    subject: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },

    htmlContent: {
      type: DataTypes.TEXT("long"),
      allowNull: false,
    },

    textContent: {
      type: DataTypes.TEXT("long"),
      allowNull: true,
    },

    variables: {
      // e.g. ["first_name", "company"]
      type: DataTypes.JSONB,
      defaultValue: [],
    },

    status: {
      type: DataTypes.ENUM("draft", "active", "archived"),
      defaultValue: "draft",
    },

    isDefault: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    createdAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },

    updatedAt: {
      type: DataTypes.DATE,
      defaultValue: DataTypes.NOW,
    },
  },
  {
    tableName: "email_templates",
    timestamps: true,
    indexes: [
      { fields: ["userId"] },
      { fields: ["status"] },
      { unique: false, fields: ["userId", "name"] },
    ],
  },
);

export default EmailTemplate;
