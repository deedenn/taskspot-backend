import mongoose from "mongoose";

const deviceSessionSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    installationId: { type: String, trim: true, required: true },
    platform: { type: String, enum: ["ios", "android", "unknown"], default: "unknown" },
    refreshTokenHash: { type: String, required: true, unique: true, select: false },
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    lastUsedAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

deviceSessionSchema.index({ user: 1, installationId: 1 });
deviceSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const DeviceSession = mongoose.model("DeviceSession", deviceSessionSchema);
