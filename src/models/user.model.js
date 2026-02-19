import { DataTypes } from "sequelize";
import sequelize from "../config/db.js";

const User = sequelize.define(
  "User",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },

    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },

    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },

    password: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    googleId: {
      type: DataTypes.STRING,
      unique: true,
    },

    role: {
      type: DataTypes.ENUM("admin", "user"),
      defaultValue: "user",
    },

    // Email verification fields
    isVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },

    verificationOtp: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    verificationOtpExpires: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    resetOtp: DataTypes.STRING,
    resetOtpExpires: DataTypes.DATE,
    lastLoginAt: DataTypes.DATE,
  },
  {
    tableName: "users",
    timestamps: true,
    paranoid: true,
  },
);

export default User;
