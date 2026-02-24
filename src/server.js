import dotenv from "dotenv";
dotenv.config(); // ALWAYS first

import { initGlobalErrorHandlers } from "./utils/error-handler.js";
initGlobalErrorHandlers();

import app from "./app.js";
import sequelize from "./config/db.js";
import "./models/index.js";
import { checkAllCampaignsCompletion } from "./utils/campaign-completion.checker.js";

const PORT = process.env.PORT || 8080;

// Campaign completion checker interval (every 5 minutes)
const CAMPAIGN_CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutes

async function startServer() {
  try {
    await sequelize.authenticate();
    console.log("PostgreSQL connected");
    sequelize.query("SELECT current_database();").then(([res]) => {
      console.log("Connected DB:", res);
    });

    if (process.env.NODE_ENV !== "production") {
      await sequelize.sync({ alter: true });
      console.log("Database synced (development mode)");
    } else {
      console.log("Database sync skipped (production mode)");
    }

    app.listen(PORT, () => {
      console.log(`API server running on port ${PORT} ❤️‍🔥`);
      console.log(`Swagger docs: http://localhost:${PORT}/api-docs 📝`);
    });

    // Start campaign completion checker
    console.log("Starting campaign completion checker...");
    await runCompletionChecker();
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

async function runCompletionChecker() {
  // Run immediately on startup
  try {
    await checkAllCampaignsCompletion();
  } catch (error) {
    console.error("Error in initial campaign completion check:", error);
  }

  // Then run periodically
  setInterval(async () => {
    try {
      await checkAllCampaignsCompletion();
    } catch (error) {
      console.error("Error in campaign completion check:", error);
    }
  }, CAMPAIGN_CHECK_INTERVAL);
}

startServer();
