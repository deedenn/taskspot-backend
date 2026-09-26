import mongoose from "mongoose";

const serviceMetricSchema = new mongoose.Schema({
  _id: { type: Date, required: true },
  bucket: { type: Date, required: true },
  requests: { type: Number, default: 0 },
  clientErrors: { type: Number, default: 0 },
  serverErrors: { type: Number, default: 0 },
  totalDurationMs: { type: Number, default: 0 },
  maxDurationMs: { type: Number, default: 0 }
}, { timestamps: true });

serviceMetricSchema.index({ bucket: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const ServiceMetric = mongoose.model("ServiceMetric", serviceMetricSchema);
