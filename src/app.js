import express from "express";
import cookieParser from "cookie-parser";
import passport from "./config/passport.js";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./utils/swagger.js";
import authRoutes from "./routes/auth.route.js";
import userRoutes from "./routes/user.routes.js";
import listUploadRoutes from "./routes/list-upload.route.js";
import { responseMiddleware } from "./middlewares/response.middleware.js";
import errorHandler from "./middlewares/error.middleware.js";
import path from "path";
import { fileURLToPath } from "url";
import { protect } from "./middlewares/auth.middleware.js";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// core middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(passport.initialize());

// static files
app.use(express.static(path.join(__dirname, "public")));

// response wrapper
app.use(responseMiddleware);

// root redirect
app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// protected static page
app.get("/profile.html", protect, (req, res) => {
  res.sendFile(path.join(__dirname, "public/profile.html"));
});

// routes
app.use("/api/v1/auth", authRoutes);
app.use("/api/v1/users", userRoutes);
app.use("/api/v1/lists", listUploadRoutes)

// swagger
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// error handler (LAST)
app.use(errorHandler);

export default app;
