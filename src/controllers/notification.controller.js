import { Notification } from '../models/index.js';

/**
 * Get all notifications for the authenticated user
 */
export const getNotifications = async (req, res, next) => {
    try {
        const userId = req.user.id;
        const {
            page = 1,
            limit = 50,
            unreadOnly = 'false',
            category = 'all',
            search = '',
        } = req.query;

        const offset = (Number(page) - 1) * Number(limit);

        // Build query
        const whereClause = { userId };

        if (unreadOnly === 'true') {
            whereClause.read = false;
        }

        if (category && category !== 'all') {
            whereClause.category = category;
        }

        if (search) {
            whereClause.title = { [process.env.DB_DIALECT === 'postgres' ? '$iLike' : '$like']: `%${search}%` };
        }

        const { rows: notifications, count: total } = await Notification.findAndCountAll({
            where: whereClause,
            order: [['createdAt', 'DESC']],
            limit: Number(limit),
            offset: Number(offset),
        });

        const unreadCount = await Notification.count({
            where: { userId, read: false },
        });

        res.status(200).json({
            success: true,
            message: 'Notifications fetched successfully',
            data: {
                notifications,
                total,
                unreadCount,
                page: Number(page),
                totalPages: Math.ceil(total / Number(limit)),
            }
        });
    } catch (error) {
        next(error);
    }
};

/**
 * Mark a specific notification as read
 */
export const markNotificationRead = async (req, res, next) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const notification = await Notification.findOne({
            where: { id, userId },
        });

        if (!notification) {
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }

        await notification.update({ read: true });

        res.status(200).json({ success: true, message: 'Notification marked as read', data: notification });
    } catch (error) {
        next(error);
    }
};

/**
 * Mark all notifications as read for the authenticated user
 */
export const markAllNotificationsRead = async (req, res, next) => {
    try {
        const userId = req.user.id;

        await Notification.update(
            { read: true },
            { where: { userId, read: false } }
        );

        res.status(200).json({ success: true, message: 'All notifications marked as read' });
    } catch (error) {
        next(error);
    }
};

/**
 * Delete a specific notification
 */
export const deleteNotification = async (req, res, next) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const deletedCount = await Notification.destroy({
            where: { id, userId },
        });

        if (deletedCount === 0) {
            return res.status(404).json({ success: false, message: 'Notification not found' });
        }

        res.status(200).json({ success: true, message: 'Notification deleted successfully' });
    } catch (error) {
        next(error);
    }
};
