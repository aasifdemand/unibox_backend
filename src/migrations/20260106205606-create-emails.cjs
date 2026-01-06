"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("emails", {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.literal("gen_random_uuid()"),
        primaryKey: true,
        allowNull: false,
      },

      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "users", key: "id" },
        onDelete: "CASCADE",
      },

      campaignId: {
        type: Sequelize.UUID,
        references: { model: "campaigns", key: "id" },
        onDelete: "SET NULL",
      },

      senderId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "senders", key: "id" },
        onDelete: "RESTRICT",
      },

      recipientEmail: {
        type: Sequelize.STRING,
        allowNull: false,
      },

      providerMessageId: {
        type: Sequelize.STRING,
        unique: true,
      },

      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: "queued",
      },

      metadata: {
        type: Sequelize.JSONB,
      },

      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },
    });

    await queryInterface.addIndex("emails", ["userId"]);
    await queryInterface.addIndex("emails", ["campaignId"]);
    await queryInterface.addIndex("emails", ["providerMessageId"]);
    await queryInterface.addIndex("emails", ["createdAt"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("emails");
  },
};
