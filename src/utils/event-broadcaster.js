import { Emitter } from "@socket.io/redis-emitter";
import { createClient } from "redis";
import { Notification } from "../models/index.js";

let emitter;

/**
 * Initializes the Redis emitter. This should be called in worker processes
 * that do not run an HTTP server but need to emit socket events.
 */
export const initEventEmitter = async () => {
    if (emitter) return emitter;

    const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
    const redisClient = createClient({ url: redisUrl });

    try {
        await redisClient.connect();
        emitter = new Emitter(redisClient);
        console.log("Redis Emitter initialized.");
        return emitter;
    } catch (err) {
        console.error("Failed to initialize Redis Emitter:", err);
        throw err;
    }
};

/**
 * Emits an event to a specific user across all Node processes.
 * @param {number|string} userId - The ID of the user to notify.
 * @param {string} eventName - The name of the event (e.g., 'notification').
 * @param {Object} payload - The data to send.
 */
export const emitToUser = async (userId, eventName, payload) => {
    try {
        let notificationData = payload;

        // If it's a 'notification' event, save it to the DB first so it persists
        if (eventName === 'notification') {
            const savedNotification = await Notification.create({
                userId,
                type: payload.type || 'info',
                category: payload.category || 'system',
                title: payload.title || 'System Notification',
                message: payload.message || '',
                metadata: payload.metadata || {},
            });
            // Attach the DB id and timestamp to the outgoing socket payload
            notificationData = {
                ...payload,
                id: savedNotification.id,
                read: savedNotification.read,
                date: savedNotification.createdAt,
            };
        }

        const io = await getEmitter();
        // The main server places users in rooms named 'user_<id>'
        io.to(`user_${userId}`).emit(eventName, notificationData);
    } catch (err) {
        console.error(`Failed to emit event '${eventName}' to user ${userId}:`, err);
    }
};

/**
 * Gets the emitter instance, initializing it if necessary.
 */
const getEmitter = async () => {
    if (!emitter) {
        return await initEventEmitter();
    }
    return emitter;
};
