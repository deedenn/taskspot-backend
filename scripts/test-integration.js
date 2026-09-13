import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

if (!process.env.TEST_MONGODB_URI) {
  console.error("Set TEST_MONGODB_URI to a test MongoDB server. The suite creates and drops only its own ts_* database.");
  process.exit(1);
}

const testDirectory = new URL("../test/", import.meta.url);
const testFiles = readdirSync(testDirectory, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.js"))
  .map((entry) => fileURLToPath(new URL(entry.name, testDirectory)))
  .sort();

if (!testFiles.length) {
  console.error("No test files found in the test directory.");
  process.exit(1);
}

const child = spawn(process.execPath, ["--test", "--test-concurrency=1", ...testFiles], {
  stdio: "inherit",
  env: { ...process.env, NODE_ENV: "test" }
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", () => process.exit(1));
