import { spawn } from "node:child_process";

if (!process.env.TEST_MONGODB_URI) {
  console.error("Set TEST_MONGODB_URI to a test MongoDB server. The suite creates and drops only its own ts_* database.");
  process.exit(1);
}
const child = spawn(process.execPath, ["--test", "test"], { stdio: "inherit", env: { ...process.env, NODE_ENV: "test" } });
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", () => process.exit(1));
