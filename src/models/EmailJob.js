import mongoose from "mongoose";

const emailPayloadSchema = new mongoose.Schema({
  to: { type: String, required: true, trim: true, lowercase: true },
  subject: { type: String, required: true },
  text: String,
  html: String
}, { _id: false, strict: "throw" });

const emailContextSchema = new mongoose.Schema({
  kind: { type: String, required: true, enum: ["verification", "password_reset", "admin_login", "invitation", "member_added", "task", "reminder", "billing_alert"] },
  userId: String,
  projectId: String,
  taskId: String,
  invitationId: String,
  token: String,
  tokenHash: String,
  dueDate: String,
  orderId: String,
  refundId: String,
  event: String,
  dedupeKey: { type: String, required: true }
}, { _id: false, strict: "throw" });

const emailJobSchema = new mongoose.Schema({
  dedupeKey: { type: String, required: true, unique: true },
  messageId: { type: String, required: true },
  mail: { type: emailPayloadSchema, required: true, select: false },
  context: { type: emailContextSchema, required: true },
  status: { type: String, enum: ["queued", "processing", "accepted", "failed", "cancelled"], default: "queued" },
  attempts: { type: Number, default: 0 },
  nextAttemptAt: { type: Date, default: Date.now },
  leaseUntil: Date,
  lockToken: String,
  acceptedAt: Date,
  lastAttemptAt: Date,
  lastError: { type: String, default: "" },
  lastErrorCode: { type: String, default: "" },
  statusSynced: { type: Boolean, default: false }
}, { timestamps: true });

emailJobSchema.index({ status: 1, nextAttemptAt: 1, leaseUntil: 1 });
emailJobSchema.index({ statusSynced: 1, status: 1 });
export const EmailJob = mongoose.model("EmailJob", emailJobSchema);
