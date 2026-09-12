import mongoose from "mongoose";

const pushDeviceSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    installationId: { type: String, trim: true, required: true },
    token: { type: String, trim: true, required: true },
    platform: { type: String, enum: ["ios", "android", "unknown"], default: "unknown" },
    enabled: { type: Boolean, default: true },
    permission: { type: String, default: "granted" },
    lastSeenAt: { type: Date, default: Date.now },
    disabledAt: Date
  },
  { timestamps: true }
);

pushDeviceSchema.index({ user: 1, installationId: 1 }, { unique: true });
pushDeviceSchema.index({ token: 1 });

export const PushDevice = mongoose.model("PushDevice", pushDeviceSchema);
