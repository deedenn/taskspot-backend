import mongoose from "mongoose";

const subscriptionPeriodSchema = new mongoose.Schema(
  {
    subscription: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Subscription",
      required: true
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true
    },
    plan: {
      type: String,
      enum: ["free", "team", "business"],
      required: true
    },
    planVersion: {
      type: Number,
      default: 1
    },
    status: {
      type: String,
      enum: ["scheduled", "active", "expired", "superseded", "cancelled"],
      required: true
    },
    startsAt: {
      type: Date,
      required: true
    },
    endsAt: Date,
    activatedAt: Date,
    endedAt: Date,
    source: {
      type: String,
      enum: ["system", "payment", "manual", "migration"],
      required: true
    },
    sourceOrder: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "PaymentOrder"
    },
    previousPeriod: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPeriod"
    },
    transitionType: {
      type: String,
      enum: ["initial", "activate", "renew", "upgrade", "downgrade", "fallback", "manual"],
      required: true
    },
    endReason: {
      type: String,
      default: ""
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    note: {
      type: String,
      trim: true,
      default: ""
    }
  },
  { timestamps: true }
);

subscriptionPeriodSchema.index({ subscription: 1, startsAt: -1 });
subscriptionPeriodSchema.index({ organization: 1, status: 1, startsAt: -1 });
subscriptionPeriodSchema.index({ sourceOrder: 1 }, { unique: true, sparse: true });

export const SubscriptionPeriod = mongoose.model("SubscriptionPeriod", subscriptionPeriodSchema);
