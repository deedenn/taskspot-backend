import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.js";
import { connectDb } from "./config/db.js";
import { validateRuntimeEnv } from "./config/env.js";

const envDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(envDir, ".env") });
dotenv.config({ path: path.join(envDir, ".env.local"), override: true });
validateRuntimeEnv();

const port = process.env.PORT || 4000;
const app = createApp();

connectDb()
  .then(() => {
    app.listen(port, () => {
      console.log(`API listening on http://localhost:${port}`);
    });
  })
  .catch((error) => {
    console.error("Failed to connect database", error);
    process.exit(1);
  });
