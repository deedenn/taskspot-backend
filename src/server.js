import dotenv from "dotenv";
import { createApp } from "./app.js";
import { connectDb } from "./config/db.js";
import { validateRuntimeEnv } from "./config/env.js";

dotenv.config();
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
