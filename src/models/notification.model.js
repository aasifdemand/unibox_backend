import { DataTypes } from 'sequelize';
import sequelize from '../config/db.js';

const Notification = sequelize.define(
    'Notification',
    {
        id: {
            type: DataTypes.UUID,
            primaryKey: true,
            defaultValue: DataTypes.UUIDV4,
        },
        userId: {
            type: DataTypes.UUID,
            allowNull: false,
        },
        type: {
            type: DataTypes.ENUM('success', 'info', 'warning', 'error', 'system'),
            defaultValue: 'info',
            allowNull: false,
        },
        category: {
            type: DataTypes.STRING, // e.g., 'campaign', 'reply', 'system', 'audience'
            defaultValue: 'system',
        },
        title: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        message: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        read: {
            type: DataTypes.BOOLEAN,
            defaultValue: false,
            allowNull: false,
        },
        metadata: {
            type: DataTypes.JSONB, // For storing extra data like campaignId, templateId, etc.
            defaultValue: {},
        },
    },
    {
        timestamps: true,
        indexes: [
            {
                fields: ['userId'],
            },
            {
                fields: ['read'],
            },
            {
                fields: ['category'],
            },
        ],
    }
);

export default Notification;
