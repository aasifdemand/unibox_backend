"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("bounce_events", {
      id: {
        type: Sequelize.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },

      emailId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: "emails", key: "id" },
        onDelete: "CASCADE",
      },

      bounceType: {
        type: Sequelize.STRING,
        allowNull: false,
      },

      reason: Sequelize.STRING,
      smtpResponse: Sequelize.TEXT,
      metadata: Sequelize.JSONB,

      occurredAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },

      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },
    });

    await queryInterface.addIndex("bounce_events", ["emailId"]);
    await queryInterface.addIndex("bounce_events", ["bounceType"]);
    await queryInterface.addIndex("bounce_events", ["occurredAt"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("bounce_events");
  },
};
