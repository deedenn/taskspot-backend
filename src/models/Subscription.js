import mongoose from "mongoose";

const subscriptionSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true,
      unique: true
    },
    status: {
      type: String,
      enum: ["active", "grace", "suspended", "closed"],
      default: "active"
    },
    currentPlan: {
      type: String,
      enum: ["free", "team", "business"],
      default: "free"
    },
    currentPeriod: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPeriod"
    },
    scheduledPeriod: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPeriod"
    },
    billingTimezone: {
      type: String,
      default: "Europe/Moscow"
    },
    revision: {
      type: Number,
      default: 0
    }
  },
  { timestamps: true }
);

export const Subscription = mongoose.model("Subscription", subscriptionSchema);
