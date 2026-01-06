"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("senders", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
        allowNull: false,
      },

      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: "users",
          key: "id",
        },
        onDelete: "CASCADE",
        onUpdate: "CASCADE",
      },

      email: {
        type: Sequelize.STRING,
        allowNull: false,
      },

      displayName: {
        type: Sequelize.STRING,
      },

      domain: {
        type: Sequelize.STRING,
      },

      isVerified: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },

      verificationStatus: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "pending",
      },

      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },

      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },

      deletedAt: {
        type: Sequelize.DATE,
      },
    });

    // 🔑 Ownership + lookup performance
    await queryInterface.addIndex("senders", ["userId"]);
    await queryInterface.addIndex("senders", ["userId", "email"], {
      unique: true,
      name: "senders_user_email_unique",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("senders");
  },
};
