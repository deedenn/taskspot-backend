import mongoose from "mongoose";

const billingPaymentSchema = new mongoose.Schema(
  {
    provider: {
      type: String,
      enum: ["manual", "digitalkassa_sbp", "tochka_sbp"],
      default: "manual"
    },
    status: {
      type: String,
      enum: ["not_required", "invoice_requested", "awaiting_payment", "paid", "failed", "refunded"],
      default: "invoice_requested"
    },
    providerPaymentId: {
      type: String,
      trim: true,
      default: ""
    },
    providerInvoiceUrl: {
      type: String,
      trim: true,
      default: ""
    },
    paidAt: {
      type: Date
    }
  },
  { _id: false }
);

const billingRequestSchema = new mongoose.Schema(
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
    plan: {
      type: String,
      enum: ["team", "business"],
      required: true
    },
    periodMonths: {
      type: Number,
      enum: [1, 3, 6, 12],
      default: 1
    },
    amount: {
      type: Number,
      default: 0
    },
    currency: {
      type: String,
      enum: ["RUB"],
      default: "RUB"
    },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "cancelled"],
      default: "pending"
    },
    contactName: {
      type: String,
      trim: true,
      default: ""
    },
    contactEmail: {
      type: String,
      trim: true,
      lowercase: true,
      default: ""
    },
    contactPhone: {
      type: String,
      trim: true,
      default: ""
    },
    comment: {
      type: String,
      trim: true,
      default: ""
    },
    adminNote: {
      type: String,
      trim: true,
      default: ""
    },
    processedAt: {
      type: Date
    },
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    planExpiresAt: {
      type: Date
    },
    payment: {
      type: billingPaymentSchema,
      default: () => ({})
    }
  },
  { timestamps: true }
);

billingRequestSchema.index({ organization: 1, status: 1, createdAt: -1 });
billingRequestSchema.index({ requestedBy: 1, createdAt: -1 });
billingRequestSchema.index({ status: 1, createdAt: -1 });

export const BillingRequest = mongoose.model("BillingRequest", billingRequestSchema);
