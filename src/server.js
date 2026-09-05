import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { connectDb } from "./config/db.js";
import { validateRuntimeEnv } from "./config/env.js";
import { startWorkers } from "./services/workers.js";

const envDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(envDir, ".env") });

if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: path.join(envDir, ".env.local"), override: true });
}

validateRuntimeEnv();

const port = process.env.PORT || 4000;
const app = createApp();

connectDb()
  .then(async () => {
    const stopWorkers = process.env.BACKGROUND_WORKERS_ENABLED === "false" ? async () => {} : await startWorkers();
    const server = app.listen(port, () => {
      console.log(`API listening on http://localhost:${port}`);
    });
    let closing = false;
    const shutdown = async () => {
      if (closing) return;
      closing = true;
      server.close();
      await stopWorkers();
      process.exit(0);
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  })
  .catch((error) => {
    console.error("Failed to connect database", error);
    process.exit(1);
  });
