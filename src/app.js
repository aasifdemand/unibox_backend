import express from "express";
import cookieParser from "cookie-parser";
import passport from "passport";
import "./config/passportgoogle-oauth.js";
import "./config/passport-microsoft.config.js";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./utils/swagger.js";
import authRoutes from "./routes/auth.route.js";
import userRoutes from "./routes/user.routes.js";
import listUploadRoutes from "./routes/list-upload.route.js";
import campaignRoutes from "./routes/campaign.route.js";
import senderRoutes from "./routes/sender.routes.js";
import mTADetectorRoutes from "./routes/mta-detector.route.js";
import emailTempalteRoutes from "./routes/email-template.routes.js";
import mailboxesRoutes from "./routes/mailboxes.routes.js";
import analyticsRoutes from "./routes/analytics.routes.js";
import trackingRoutes from "./routes/tracking.route.js";
import { responseMiddleware } from "./middlewares/response.middleware.js";
import errorHandler from "./middlewares/error.middleware.js";
import path from "path";
import { fileURLToPath } from "url";
import { protect } from "./middlewares/auth.middleware.js";
import cors from "cors";
import morgan from "morgan";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// core middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(passport.initialize());
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  }),
);
app.use(morgan("dev"));

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
app.use("/api/v1/lists", listUploadRoutes);
app.use("/api/v1/senders", senderRoutes);
app.use("/api/v1/campaigns", campaignRoutes);
app.use("/api/v1/analytics", analyticsRoutes);
app.use("/api/v1/mta-detector", mTADetectorRoutes);
app.use("/api/v1/templates", emailTempalteRoutes);
app.use("/api/v1/mailboxes", mailboxesRoutes);
app.use("/api/v1/track", trackingRoutes);

// swagger
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// error handler (LAST)
app.use(errorHandler);

export default app;
