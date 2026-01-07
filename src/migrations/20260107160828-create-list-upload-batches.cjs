'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('list_upload_batches', {
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
      originalFilename: Sequelize.STRING,
      storagePath: Sequelize.STRING,
      fileType: {
        type: Sequelize.ENUM('csv', 'xlsx', 'txt'),
        allowNull: false,
      },
      status: {
        type: Sequelize.ENUM(
          'uploaded',
          'parsing',
          'deduping',
          'queued',
          'completed',
          'failed'
        ),
        defaultValue: 'uploaded',
      },
      totalRecords: Sequelize.INTEGER,
      validRecords: Sequelize.INTEGER,
      duplicateRecords: Sequelize.INTEGER,
      failedRecords: Sequelize.INTEGER,
      checksum: { type: Sequelize.STRING, allowNull: false },
      errorReason: Sequelize.TEXT,
      createdAt: Sequelize.DATE,
      updatedAt: Sequelize.DATE,
    });

    await queryInterface.addIndex('list_upload_batches', ['userId']);
    await queryInterface.addIndex('list_upload_batches', ['status']);
    await queryInterface.addIndex(
      'list_upload_batches',
      ['userId', 'checksum'],
      { unique: true }
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('list_upload_batches');
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_list_upload_batches_fileType";'
    );
    await queryInterface.sequelize.query(
      'DROP TYPE IF EXISTS "enum_list_upload_batches_status";'
    );
  },
};
