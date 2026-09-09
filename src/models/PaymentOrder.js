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
      enum: ["creating", "pending", "succeeded", "failed", "expired", "cancelled", "refunded"],
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
    paymentUrl: {
      type: String,
      trim: true,
      default: ""
    },
    expiresAt: Date,
    succeededAt: Date
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
      enum: ["awaiting_payment", "paid", "expired", "cancelled", "failed", "refunded"],
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
    cancelledAt: Date,
    payment: {
      type: paymentSchema,
      required: true
    }
  },
  { timestamps: true }
);

paymentOrderSchema.index({ organization: 1, requestedBy: 1, idempotencyKey: 1 }, { unique: true });
paymentOrderSchema.index({ organization: 1, isOpen: 1 }, { unique: true, partialFilterExpression: { isOpen: true } });
paymentOrderSchema.index({ "payment.provider": 1, "payment.providerPaymentId": 1 }, { unique: true });
paymentOrderSchema.index({ organization: 1, createdAt: -1 });

export const PaymentOrder = mongoose.model("PaymentOrder", paymentOrderSchema);
