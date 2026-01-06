"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("campaigns", {
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

      senderId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: "senders",
          key: "id",
        },
        onDelete: "RESTRICT",
        onUpdate: "CASCADE",
      },

      name: {
        type: Sequelize.STRING,
        allowNull: false,
      },

      subject: {
        type: Sequelize.STRING,
        allowNull: false,
      },

      htmlBody: {
        type: Sequelize.TEXT,
      },

      textBody: {
        type: Sequelize.TEXT,
      },

      status: {
        type: Sequelize.ENUM(
          "draft",
          "scheduled",
          "sending",
          "completed",
          "paused"
        ),
        allowNull: false,
        defaultValue: "draft",
      },

      scheduledAt: {
        type: Sequelize.DATE,
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

    // 🔑 Performance indexes
    await queryInterface.addIndex("campaigns", ["userId"]);
    await queryInterface.addIndex("campaigns", ["senderId"]);
    await queryInterface.addIndex("campaigns", ["status"]);
    await queryInterface.addIndex("campaigns", ["scheduledAt"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("campaigns");
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_campaigns_status";'
    );
  },
};
