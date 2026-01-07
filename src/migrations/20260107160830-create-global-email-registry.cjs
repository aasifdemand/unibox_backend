'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('global_email_registry', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      normalizedEmail: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true,
      },
      domain: Sequelize.STRING,
      firstSeenAt: {
        type: Sequelize.DATE,
        defaultValue: Sequelize.literal('NOW()'),
      },
      lastSeenAt: Sequelize.DATE,
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('global_email_registry');
  },
};
