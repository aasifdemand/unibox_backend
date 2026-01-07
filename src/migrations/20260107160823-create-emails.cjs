'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('emails', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      userId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'users', key: 'id' },
        onDelete: 'CASCADE',
      },
      campaignId: {
        type: Sequelize.UUID,
        references: { model: 'campaigns', key: 'id' },
        onDelete: 'SET NULL',
      },
      senderId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'senders', key: 'id' },
        onDelete: 'RESTRICT',
      },
      recipientEmail: { type: Sequelize.STRING, allowNull: false },
      providerMessageId: { type: Sequelize.STRING, unique: true },
      status: { type: Sequelize.STRING, defaultValue: 'queued' },
      metadata: Sequelize.JSONB,
      createdAt: Sequelize.DATE,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('emails');
  },
};
