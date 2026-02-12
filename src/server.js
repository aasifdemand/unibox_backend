import dotenv from "dotenv";
dotenv.config(); // ALWAYS first

import app from "./app.js";
import sequelize from "./config/db.js";
import "./models/index.js";

const PORT = process.env.PORT || 8080;

async function startServer() {
  try {
    await sequelize.authenticate();
    console.log("PostgreSQL connected");
    sequelize.query("SELECT current_database();").then(([res]) => {
      console.log("Connected DB:", res);
    });

    await sequelize.sync();

    app.listen(PORT, () => {
      console.log(`API server running on port ${PORT} ❤️‍🔥`);
      console.log(`Swagger docs: http://localhost:${PORT}/api-docs 📝`);
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
