/**
 * Utility to catch unhandled errors and exceptions so the process doesn't crash 
 * abruptly without logging or when we want it to stay alive.
 */
export function initGlobalErrorHandlers() {
  process.on("uncaughtException", (error) => {
    console.error("💥 UI/Worker - Uncaught Exception:", error);
    // Usually it's recommended to exit on uncaughtException because the Node.js 
    // process might be in an undefined state. However, to keep the server running
    // as requested, we log the error and keep the process alive. 
    // If you experience weird state issues, consider exiting here and using PM2/Nodemon to restart.
  });

  process.on("unhandledRejection", (reason, promise) => {
    console.error("💥 UI/Worker - Unhandled Rejection at:", promise, "reason:", reason);
    // We explicitly do not exit here to keep the server running.
  });

  console.log("🛡️ Global error handlers initialized.");
}
