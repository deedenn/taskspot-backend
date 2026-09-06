import mongoose from "mongoose";
const schema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  event: { type: String, enum: ["active_day", "billing_viewed"], required: true },
  day: { type: String, required: true },
  at: { type: Date, required: true }
});
schema.index({ user: 1, event: 1, day: 1 }, { unique: true });
schema.index({ event: 1, at: 1 });
export const ProductEvent = mongoose.model("ProductEvent", schema);
