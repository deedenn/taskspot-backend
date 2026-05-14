import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true
    },
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task"
    },
    message: {
      type: String,
      required: true
    },
    read: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, read: 1, createdAt: -1 });
notificationSchema.index({ project: 1, createdAt: -1 });
notificationSchema.index({ task: 1, createdAt: -1 });

export const Notification = mongoose.model("Notification", notificationSchema);
