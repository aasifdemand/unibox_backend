'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('reply_events', {
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
      replyFrom: Sequelize.STRING,
      subject: Sequelize.STRING,
      body: Sequelize.TEXT,
      metadata: Sequelize.JSONB,
      receivedAt: Sequelize.DATE,
      createdAt: Sequelize.DATE,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('reply_events');
  },
};
