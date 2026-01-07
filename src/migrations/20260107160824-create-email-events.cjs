'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('email_events', {
      id: {
        type: Sequelize.BIGINT,
        autoIncrement: true,
        primaryKey: true,
      },
      emailId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'emails', key: 'id' },
        onDelete: 'CASCADE',
      },
      eventType: { type: Sequelize.STRING, allowNull: false },
      eventTimestamp: { type: Sequelize.DATE, allowNull: false },
      metadata: Sequelize.JSONB,
      createdAt: Sequelize.DATE,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('email_events');
  },
};
