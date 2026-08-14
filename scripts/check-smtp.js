import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkEmailTransport } from "../src/services/email.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(rootDir, ".env") });

if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: path.join(rootDir, ".env.local"), override: true });
}

const diagnostics = await checkEmailTransport();

console.log(JSON.stringify({
  event: "smtp_check_complete",
  diagnostics
}, null, 2));

if (!diagnostics.ok) {
  process.exitCode = 1;
}
