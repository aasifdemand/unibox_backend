'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('list_upload_records', {
      id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.literal('gen_random_uuid()'),
      },
      batchId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'list_upload_batches', key: 'id' },
        onDelete: 'CASCADE',
      },
      rawEmail: Sequelize.STRING,
      normalizedEmail: Sequelize.STRING,
      domain: Sequelize.STRING,
      name: Sequelize.STRING,
      metadata: Sequelize.JSONB,
      status: {
        type: Sequelize.ENUM(
          'parsed',
          'duplicate',
          'invalid',
          'queued',
          'completed',
          'failed'
        ),
        defaultValue: 'parsed',
      },
      failureReason: Sequelize.TEXT,
      createdAt: Sequelize.DATE,
    });

    await queryInterface.addIndex('list_upload_records', ['batchId']);
    await queryInterface.addIndex('list_upload_records', ['normalizedEmail']);
    await queryInterface.addIndex('list_upload_records', ['status']);
  },

  async down(queryInterface) {
    await queryInterface.dropTable('list_upload_records');
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_list_upload_records_status";'
    );
  },
};
