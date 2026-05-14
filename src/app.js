import cors from "cors";
import express from "express";
import morgan from "morgan";
import { authRouter } from "./routes/auth.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { notificationsRouter } from "./routes/notifications.js";
import { organizationsRouter } from "./routes/organizations.js";
import { projectsRouter } from "./routes/projects.js";
import { reportsRouter } from "./routes/reports.js";
import { tasksRouter } from "./routes/tasks.js";

export function createApp() {
  const app = express();
  const clientUrl = process.env.CLIENT_URL || "http://127.0.0.1:5173";
  const allowedOrigins = new Set([
    clientUrl,
    "http://localhost:5173",
    "http://127.0.0.1:5173"
  ]);

  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || allowedOrigins.has(origin)) {
          return callback(null, true);
        }

        callback(new Error("Origin is not allowed by CORS"));
      }
    })
  );
  app.use(express.json({ limit: "1mb" }));

  if (process.env.NODE_ENV !== "test") {
    app.use(morgan("dev"));
  }

  app.get("/", (req, res) => {
    res.redirect(clientUrl);
  });

  app.get("/api/health", (req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/organizations", organizationsRouter);
  app.use("/api/projects", projectsRouter);
  app.use("/api/tasks", tasksRouter);
  app.use("/api/dashboard", dashboardRouter);
  app.use("/api/notifications", notificationsRouter);
  app.use("/api/reports", reportsRouter);

  app.use((error, req, res, next) => {
    if (error?.type === "entity.too.large") {
      return res.status(413).json({ message: "Request body is too large" });
    }

    if (error?.name === "ValidationError" || error?.name === "CastError") {
      return res.status(400).json({ message: error.message });
    }

    console.error(error?.stack || error);
    res.status(500).json({ message: "Unexpected server error" });
  });

  return app;
}
