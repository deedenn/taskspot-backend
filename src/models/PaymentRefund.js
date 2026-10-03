import mongoose from "mongoose";

const fiscalizationSchema = new mongoose.Schema(
  {
    provider: { type: String, enum: ["digitalkassa"], default: "digitalkassa" },
    status: {
      type: String,
      enum: ["not_started", "pending", "succeeded", "failed"],
      default: "not_started"
    },
    receiptId: { type: String, trim: true, default: "" },
    receiptUrl: { type: String, trim: true, default: "" },
    attempts: { type: Number, default: 0 },
    lastAttemptAt: Date,
    completedAt: Date,
    errorCode: { type: String, trim: true, default: "" },
    errorMessage: { type: String, trim: true, default: "" }
  },
  { _id: false }
);

const paymentRefundSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true
    },
    paymentOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PaymentOrder",
      required: true
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    idempotencyKey: { type: String, required: true, trim: true },
    amountKopecks: { type: Number, required: true, min: 1 },
    currency: { type: String, enum: ["RUB"], default: "RUB" },
    reason: { type: String, trim: true, default: "" },
    status: {
      type: String,
      enum: ["creating", "pending", "unknown", "succeeded", "failed"],
      default: "creating"
    },
    provider: { type: String, enum: ["tochka_sbp"], default: "tochka_sbp" },
    providerRequestId: { type: String, trim: true, default: "" },
    providerStatus: { type: String, trim: true, default: "" },
    completedAt: Date,
    failedAt: Date,
    errorCode: { type: String, trim: true, default: "" },
    errorMessage: { type: String, trim: true, default: "" },
    fiscalization: { type: fiscalizationSchema, default: () => ({}) }
  },
  { timestamps: true }
);

paymentRefundSchema.index({ paymentOrder: 1, idempotencyKey: 1 }, { unique: true });
paymentRefundSchema.index(
  { providerRequestId: 1 },
  { unique: true, partialFilterExpression: { providerRequestId: { $gt: "" } } }
);
paymentRefundSchema.index({ status: 1, updatedAt: 1 });
paymentRefundSchema.index({ "fiscalization.status": 1, updatedAt: 1 });

export const PaymentRefund = mongoose.model("PaymentRefund", paymentRefundSchema);
