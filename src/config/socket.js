import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import jwt from "jsonwebtoken";

let io;

export const initSocket = async (httpServer) => {
    io = new Server(httpServer, {
        cors: {
            origin: [
                process.env.FRONTEND_URL,
                "http://localhost:5173",
                "http://localhost:4173",
            ].filter(Boolean),
            methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
            credentials: true,
        },
    });

    // Setup Redis Adapter for cross-process communication (Workers -> Server)
    const redisUrl = process.env.REDIS_URL || "redis://127.0.0.1:6379";
    const pubClient = createClient({ url: redisUrl });
    const subClient = pubClient.duplicate();

    try {
        await Promise.all([pubClient.connect(), subClient.connect()]);
        io.adapter(createAdapter(pubClient, subClient));
        console.log("Socket.IO Redis Adapter connected.");
    } catch (err) {
        console.error("Failed to connect Socket.IO Redis adapter:", err);
    }

    // Middleware for Authentication
    io.use((socket, next) => {
        // Try to get token from handshake auth or cookies
        const token =
            socket.handshake.auth?.token ||
            (socket.handshake.headers.cookie &&
                parseCookies(socket.handshake.headers.cookie).access_token);

        if (!token) {
            return next(new Error("Authentication error: No token provided"));
        }

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            socket.user = decoded; // Contains id, email, role, etc.
            next();
        } catch (err) {
            return next(new Error("Authentication error: Invalid token"));
        }
    });

    io.on("connection", (socket) => {
        console.log(`Socket connected: ${socket.id} (User: ${socket.user.id})`);

        // Join a room specific to this user so we can target them easily
        socket.join(`user_${socket.user.id}`);

        // Allow user to join workspace-specific rooms if needed
        socket.on("join_workspace", (workspaceId) => {
            socket.join(`workspace_${workspaceId}`);
        });

        socket.on("disconnect", () => {
            console.log(`Socket disconnected: ${socket.id} (User: ${socket.user.id})`);
        });
    });

    return io;
};

export const getIO = () => {
    if (!io) {
        throw new Error("Socket.io not initialized!");
    }
    return io;
};

// Simple cookie parser helper
function parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;

    cookieHeader.split(";").forEach((cookie) => {
        let parts = cookie.split("=");
        list[parts.shift().trim()] = decodeURI(parts.join("="));
    });

    return list;
}
