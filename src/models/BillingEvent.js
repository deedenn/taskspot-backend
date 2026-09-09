import crypto from "node:crypto";
import mongoose from "mongoose";

const billingEventSchema = new mongoose.Schema(
  {
    eventId: {
      type: String,
      default: () => crypto.randomUUID(),
      unique: true
    },
    type: {
      type: String,
      required: true
    },
    version: {
      type: Number,
      default: 1
    },
    aggregateType: {
      type: String,
      required: true
    },
    aggregateId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization",
      required: true
    },
    actorType: {
      type: String,
      enum: ["user", "admin", "provider", "system"],
      required: true
    },
    actorId: String,
    correlationId: String,
    causationId: String,
    idempotencyKey: {
      type: String,
      required: true,
      unique: true
    },
    payload: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    occurredAt: {
      type: Date,
      default: Date.now
    },
    publishedAt: Date
  },
  { timestamps: true }
);

billingEventSchema.index({ organization: 1, occurredAt: -1 });
billingEventSchema.index({ aggregateType: 1, aggregateId: 1, occurredAt: -1 });

export const BillingEvent = mongoose.model("BillingEvent", billingEventSchema);
