import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Task } from "../src/models/Task.js";
import { WorkerLease } from "../src/models/WorkerLease.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
if (process.env.NODE_ENV !== "production") dotenv.config({ path: path.join(root, ".env.local"), override: true, quiet: true });
try {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI missing");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  const now = new Date();
  const lease = await WorkerLease.findById("task-scheduler").select("expiresAt").lean();
  console.log(JSON.stringify({
    event: "task_schedule_diagnostics", at: now,
    workersEnabled: process.env.BACKGROUND_WORKERS_ENABLED !== "false",
    timeZone: process.env.TASK_TIME_ZONE || "Europe/Moscow",
    leaseExpiresAt: lease?.expiresAt,
    leaseExpired: Boolean(lease && lease.expiresAt <= now),
    enabled: await Task.countDocuments({ "recurrence.enabled": true }),
    due: await Task.countDocuments({ "recurrence.enabled": true, "recurrence.nextRunAt": { $lte: now } }),
    missingNextRun: await Task.countDocuments({ "recurrence.enabled": true, "recurrence.nextRunAt": null }),
    delayed: await Task.find({ "recurrence.enabled": true, "recurrence.lastError": { $nin: ["", null] } })
      .select("_id project recurrence.nextRunAt recurrence.retryAt recurrence.lastError recurrence.lastRunAt recurrence.lastTask")
      .sort({ "recurrence.retryAt": 1 }).limit(50).lean()
  }, null, 2));
} catch {
  console.error(JSON.stringify({ event: "task_schedule_diagnostics_failed", message: "Не удалось прочитать расписания. Проверьте MongoDB." }));
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
