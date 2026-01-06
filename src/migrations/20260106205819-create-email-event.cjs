"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("email_events", {
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

      eventType: {
        type: Sequelize.STRING,
        allowNull: false,
      },

      eventTimestamp: {
        type: Sequelize.DATE,
        allowNull: false,
      },

      metadata: Sequelize.JSONB,

      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("NOW()"),
      },
    });

    await queryInterface.addIndex("email_events", ["emailId"]);
    await queryInterface.addIndex("email_events", ["eventType", "eventTimestamp"]);
  },

  async down(queryInterface) {
    await queryInterface.dropTable("email_events");
  },
};
