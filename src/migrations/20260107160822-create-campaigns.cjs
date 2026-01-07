'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('campaigns', {
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
      senderId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'senders', key: 'id' },
        onDelete: 'RESTRICT',
      },
      name: { type: Sequelize.STRING, allowNull: false },
      subject: { type: Sequelize.STRING, allowNull: false },
      htmlBody: Sequelize.TEXT,
      textBody: Sequelize.TEXT,
      status: {
        type: Sequelize.ENUM(
          'draft',
          'scheduled',
          'sending',
          'completed',
          'paused'
        ),
        defaultValue: 'draft',
      },
      scheduledAt: Sequelize.DATE,
      createdAt: Sequelize.DATE,
      updatedAt: Sequelize.DATE,
      deletedAt: Sequelize.DATE,
    });

    await queryInterface.addIndex('campaigns', ['userId']);
    await queryInterface.addIndex('campaigns', ['senderId']);
    await queryInterface.addIndex('campaigns', ['status']);
    await queryInterface.addIndex('campaigns', ['scheduledAt']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('campaigns');
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_campaigns_status";'
    );
  },
};
