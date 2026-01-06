import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const Sender = sequelize.define(
  "Sender",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    email: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    displayName: DataTypes.STRING,
    domain: DataTypes.STRING,

    isVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    verificationStatus: {
      type: DataTypes.STRING,
      defaultValue: "pending",
    },
  },
  {
    tableName: "senders",
    timestamps: true,
    paranoid: true,
  }
);

export default Sender;
