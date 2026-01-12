import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";
import {
  EmailProvider,
  ConfidenceLevel,
} from "../enums/email-provider.enum.js";

const EmailDomainProvider = sequelize.define(
  "EmailDomainProvider",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    domain: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },

    provider: {
      type: DataTypes.ENUM(...Object.values(EmailProvider)),
      allowNull: false,
      defaultValue: EmailProvider.UNKNOWN,
    },

    confidence: {
      type: DataTypes.ENUM(...Object.values(ConfidenceLevel)),
      allowNull: false,
      defaultValue: ConfidenceLevel.WEAK,
    },

    score: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },

    signals: {
      type: DataTypes.JSONB,
      allowNull: true,
    },

    detectedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },

    ttlExpiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  },
  {
    tableName: "email_domain_providers",
    timestamps: true,
    indexes: [{ unique: true, fields: ["domain"] }, { fields: ["provider"] }],
  }
);

export default EmailDomainProvider;
