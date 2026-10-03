import mongoose from "mongoose";

const paymentSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ["mock", "digitalkassa_sbp", "tochka_sbp"],
      default: "mock"
    },
    status: {
      type: String,
      enum: ["creating", "creation_unknown", "pending", "succeeded", "failed", "expired", "cancelled", "refunded"],
      default: "pending"
    },
    providerPaymentId: {
      type: String,
      trim: true,
      required: true
    },
    qrPayload: {
      type: String,
      trim: true,
      default: ""
    },
    qrImage: {
      type: String,
      default: ""
    },
    paymentUrl: {
      type: String,
      trim: true,
      default: ""
    },
    operationId: {
      type: String,
      trim: true,
      default: ""
    },
    rail: {
      type: String,
      enum: ["sbp", "digital_ruble"],
      default: "sbp"
    },
    refTransactionId: {
      type: String,
      trim: true,
      default: ""
    },
    lastCheckedAt: Date,
    expiresAt: Date,
    succeededAt: Date,
    creationAttempts: { type: Number, default: 0 },
    creationLastAttemptAt: Date,
    creationLockedUntil: Date,
    creationLockId: { type: String, trim: true, default: "" },
    creationErrorCode: { type: String, trim: true, default: "" },
    creationErrorMessage: { type: String, trim: true, default: "" }
  },
  { _id: false }
);

const paymentOrderSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true
    },
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    targetPlan: {
      type: String,
      enum: ["team", "business"],
      required: true
    },
    planVersion: {
      type: Number,
      required: true
    },
    planName: {
      type: String,
      required: true
    },
    periodMonths: {
      type: Number,
      enum: [1, 3, 6, 12],
      required: true
    },
    transitionType: {
      type: String,
      enum: ["activate", "renew", "upgrade", "downgrade"],
      required: true
    },
    status: {
      type: String,
      enum: ["awaiting_payment", "paid", "partially_refunded", "expired", "cancelled", "failed", "refunded"],
      default: "awaiting_payment"
    },
    amountKopecks: {
      type: Number,
      min: 0,
      required: true
    },
    currency: {
      type: String,
      enum: ["RUB"],
      default: "RUB"
    },
    priceSnapshot: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    idempotencyKey: {
      type: String,
      required: true
    },
    isOpen: {
      type: Boolean,
      default: true
    },
    expiresAt: {
      type: Date,
      required: true
    },
    paidAt: Date,
    receiptEmail: { type: String, trim: true, lowercase: true, default: "" },
    refundedAmountKopecks: { type: Number, min: 0, default: 0 },
    refundReservedAmountKopecks: { type: Number, min: 0, default: 0 },
    cancelledAt: Date,
    payment: {
      type: paymentSchema,
      required: true
    },
    fiscalization: {
      provider: {
        type: String,
        enum: ["digitalkassa"],
        default: "digitalkassa"
      },
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
    }
  },
  { timestamps: true }
);

paymentOrderSchema.index({ organization: 1, requestedBy: 1, idempotencyKey: 1 }, { unique: true });
paymentOrderSchema.index({ organization: 1, isOpen: 1 }, { unique: true, partialFilterExpression: { isOpen: true } });
paymentOrderSchema.index({ "payment.provider": 1, "payment.providerPaymentId": 1 }, { unique: true });
paymentOrderSchema.index(
  { "payment.operationId": 1 },
  { unique: true, partialFilterExpression: { "payment.operationId": { $gt: "" } } }
);
paymentOrderSchema.index({ organization: 1, createdAt: -1 });
paymentOrderSchema.index({ status: 1, createdAt: -1 });
paymentOrderSchema.index({ status: 1, paidAt: -1 });
paymentOrderSchema.index({ status: 1, "fiscalization.status": 1 });

export const PaymentOrder = mongoose.model("PaymentOrder", paymentOrderSchema);
