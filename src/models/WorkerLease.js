import mongoose from "mongoose";

const schema = new mongoose.Schema({
  _id: String,
  token: String,
  expiresAt: { type: Date, required: true }
});

export const WorkerLease = mongoose.model("WorkerLease", schema);
