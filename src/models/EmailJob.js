import mongoose from "mongoose";

const emailJobSchema = new mongoose.Schema({
  dedupeKey: { type: String, required: true, unique: true },
  messageId: { type: String, required: true },
  mail: { type: mongoose.Schema.Types.Mixed, required: true, select: false },
  context: { type: mongoose.Schema.Types.Mixed, default: {} },
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
