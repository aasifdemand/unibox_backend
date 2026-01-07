'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('senders', {
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
      email: { type: Sequelize.STRING, allowNull: false },
      displayName: Sequelize.STRING,
      domain: Sequelize.STRING,
      isVerified: { type: Sequelize.BOOLEAN, defaultValue: false },
      verificationStatus: {
        type: Sequelize.STRING,
        defaultValue: 'pending',
      },
      createdAt: Sequelize.DATE,
      updatedAt: Sequelize.DATE,
      deletedAt: Sequelize.DATE,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('senders');
  },
};
