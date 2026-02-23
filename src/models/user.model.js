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
      validate: {
        len: [2, 100], // Add validation
      },
    },

    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: {
        isEmail: true, // Add email validation
      },
    },

    password: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: {
        len: [8, 100], // Only validate if password exists
      },
    },

    googleId: {
      type: DataTypes.STRING,
      unique: true,
      allowNull: true, // Explicitly set allowNull
    },

    role: {
      type: DataTypes.ENUM("admin", "user"),
      defaultValue: "user",
      allowNull: false,
    },

    // Email verification fields
    isVerified: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
      allowNull: false,
    },

    verificationOtp: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    verificationOtpExpires: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // Password reset fields
    resetOtp: {
      type: DataTypes.STRING,
      allowNull: true,
    },

    resetOtpExpires: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // Account status
    lastLoginAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },

    // Add account type to easily distinguish
    authType: {
      type: DataTypes.ENUM("local", "google", "microsoft"),
      defaultValue: "local",
      allowNull: false,
    },
  },
  {
    tableName: "users",
    timestamps: true,
    paranoid: true,
    indexes: [
      // Add indexes for better performance
      {
        unique: true,
        fields: ["email"],
      },
      {
        fields: ["googleId"],
      },
      {
        fields: ["authType"],
      },
    ],
    hooks: {
      // Optional: Add hooks for additional logic
      beforeCreate: (user) => {
        // Set auth type based on provider
        if (user.googleId) {
          user.authType = "google";
        }
      },
    },
  },
);

export default User;
