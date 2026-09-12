import mongoose from "mongoose";

const mobileMutationReceiptSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    key: { type: String, required: true },
    state: { type: String, enum: ["processing", "complete"], default: "processing" },
    statusCode: Number,
    response: mongoose.Schema.Types.Mixed,
    expiresAt: { type: Date, required: true }
  },
  { timestamps: true }
);

mobileMutationReceiptSchema.index({ user: 1, key: 1 }, { unique: true });
mobileMutationReceiptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const MobileMutationReceipt = mongoose.model("MobileMutationReceipt", mobileMutationReceiptSchema);
