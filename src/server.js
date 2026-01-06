import dotenv from "dotenv";
import app from "./app.js";
import sequelize from "./config/db.js";

// load env FIRST
dotenv.config();

// ensure models are registered
import "./models/user.model.js";

const PORT = process.env.PORT || 8080;

async function startServer() {
  try {
    await sequelize.authenticate();
    console.log("PostgreSQL connected");

    await sequelize.sync({ alter: true }); // migrations later
    console.log("Models synced");

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
