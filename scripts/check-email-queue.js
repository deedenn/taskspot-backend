import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmailJob } from "../src/models/EmailJob.js";
import { User } from "../src/models/User.js";
import { Project } from "../src/models/Project.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
if (process.env.NODE_ENV !== "production") dotenv.config({ path: path.join(root, ".env.local"), override: true, quiet: true });

try {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  const now = new Date();
  const counts = await EmailJob.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]);
  const recentFailures = await EmailJob.find({ status: "failed" })
    .select("_id attempts lastErrorCode lastAttemptAt").sort({ updatedAt: -1 }).limit(20).lean();
  const oldestQueued = await EmailJob.findOne({ status: "queued" }).select("_id createdAt nextAttemptAt attempts").sort({ createdAt: 1 }).lean();
  console.log(JSON.stringify({
    event: "email_queue_diagnostics", at: now,
    workersEnabled: process.env.BACKGROUND_WORKERS_ENABLED !== "false",
    maxAttempts: Math.max(1, Math.min(20, Number(process.env.EMAIL_MAX_ATTEMPTS) || 8)),
    counts: Object.fromEntries(counts.map((row) => [row._id, row.count])),
    expiredLeases: await EmailJob.countDocuments({ status: "processing", leaseUntil: { $lte: now } }),
    unsynced: await EmailJob.countDocuments({ statusSynced: false, status: { $ne: "processing" } }),
    pendingUserIntents: await User.countDocuments({ "emailOutbox.key": { $exists: true } }),
    projectsWithPendingIntents: await Project.countDocuments({ $or: [
      { "members.emailOutbox.key": { $exists: true } }, { "invitations.emailOutbox.key": { $exists: true } }
    ] }),
    oldestQueued, recentFailures
  }, null, 2));
} catch {
  console.error(JSON.stringify({ event: "email_queue_diagnostics_failed", message: "Не удалось прочитать очередь. Проверьте подключение MongoDB." }));
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
