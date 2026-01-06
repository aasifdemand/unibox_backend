import express from 'express';

import dotenv from 'dotenv';
import sequelize from './config/db.js';
import authRoutes from './routes/auth.route.js';
import userRoutes from './routes/user.routes.js';
import "./models/user.model.js"
import errorHandler from './middlewares/error.middleware.js';
import { responseMiddleware } from './middlewares/response.middleware.js';
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./utils/swagger.js";
import cookieParser from "cookie-parser";
import passport from "./config/passport.js";
import path from "path";
import { fileURLToPath } from "url";
import { protect } from "./middlewares/auth.middleware.js";

dotenv.config();

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json())
app.use(express.urlencoded({ extended: true }))
app.use(cookieParser());
app.use(passport.initialize());
app.use(express.static(path.join(__dirname, "public")));
try {
  await sequelize.authenticate();
  console.log("PostgreSQL connected");

  await sequelize.sync({alter:true}); // ⚠️ use migrations in real production
  console.log("Models synced");
} catch (error) {
  console.error("DB connection failed:", error);
}

app.use(responseMiddleware)
// routes

app.get("/", (req, res) => {
  res.redirect("/login.html");
});

app.get("/profile.html", protect, (req, res) => {
  res.sendFile(path.join(__dirname, "public/profile.html"));
});
app.use('/api/v1/auth',authRoutes )
app.use('/api/v1/users',userRoutes)
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));


app.use(errorHandler);


app.listen(process.env.PORT, () => {
    console.log(`API server is running on port ${process.env.PORT}❤️‍🔥`);
    console.log(`API docs available at http://localhost:${process.env.PORT}/api-docs 📝`)
})