import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmailJob } from "../src/models/EmailJob.js";
import { User } from "../src/models/User.js";
import { Project } from "../src/models/Project.js";

function maskEmail(value) {
  const [local = "", domain = ""] = String(value || "").split("@");
  if (!domain) return "***";
  return `${local.slice(0, 2)}${local.length > 2 ? "***" : "*"}@${domain}`;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
if (process.env.NODE_ENV !== "production") dotenv.config({ path: path.join(root, ".env.local"), override: true, quiet: true });

try {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  const now = new Date();
  const [counts, kinds, recentAdminLoginJobs, activeAdminChallenges] = await Promise.all([
    EmailJob.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    EmailJob.aggregate([{ $group: { _id: { kind: "$context.kind", status: "$status" }, count: { $sum: 1 } } }]),
    EmailJob.find({ "context.kind": "admin_login" })
      .select("status attempts lastError lastErrorCode createdAt lastAttemptAt acceptedAt nextAttemptAt")
      .sort({ createdAt: -1 }).limit(10).lean(),
    User.find({ isSuperAdmin: true, "adminChallenge.requestedAt": { $exists: true } })
      .select("email status +adminChallenge").lean()
  ]);
  const recentFailures = await EmailJob.find({ status: "failed" })
    .select("_id context.kind attempts lastErrorCode lastAttemptAt").sort({ updatedAt: -1 }).limit(20).lean();
  const oldestQueued = await EmailJob.findOne({ status: "queued" }).select("_id createdAt nextAttemptAt attempts").sort({ createdAt: 1 }).lean();
  const pendingUserIntentFilter = { $or: [
    { "emailOutbox.key": { $exists: true } },
    { "passwordReset.outbox.key": { $exists: true } },
    { "adminChallenge.outbox.key": { $exists: true } }
  ] };
  console.log(JSON.stringify({
    event: "email_queue_diagnostics", at: now,
    workersEnabled: process.env.BACKGROUND_WORKERS_ENABLED !== "false",
    maxAttempts: Math.max(1, Math.min(20, Number(process.env.EMAIL_MAX_ATTEMPTS) || 8)),
    counts: Object.fromEntries(counts.map((row) => [row._id, row.count])),
    kinds: kinds.map((row) => ({ kind: row._id.kind || "unknown", status: row._id.status, count: row.count })),
    privacyRejected: await EmailJob.countDocuments({ lastErrorCode: "EMAIL_PRIVACY_REJECTED" }),
    expiredLeases: await EmailJob.countDocuments({ status: "processing", leaseUntil: { $lte: now } }),
    unsynced: await EmailJob.countDocuments({ statusSynced: false, status: { $ne: "processing" } }),
    pendingUserIntents: await User.countDocuments(pendingUserIntentFilter),
    pendingUserIntentsByKind: {
      direct: await User.countDocuments({ "emailOutbox.key": { $exists: true } }),
      passwordReset: await User.countDocuments({ "passwordReset.outbox.key": { $exists: true } }),
      adminLogin: await User.countDocuments({ "adminChallenge.outbox.key": { $exists: true } })
    },
    activeAdminChallenges: activeAdminChallenges.map((user) => ({
      recipient: maskEmail(user.email),
      status: user.status,
      requestedAt: user.adminChallenge?.requestedAt,
      expiresAt: user.adminChallenge?.expiresAt,
      pendingOutbox: Boolean(user.adminChallenge?.outbox?.key)
    })),
    recentAdminLoginJobs,
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
