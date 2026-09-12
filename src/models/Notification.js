import mongoose from "mongoose";

const notificationSchema = new mongoose.Schema(
  {
    dedupeKey: String,
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project"
    },
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization"
    },
    task: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Task"
    },
    message: {
      type: String,
      required: true
    },
    kind: {
      type: String,
      default: "task_updated"
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({})
    },
    read: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

notificationSchema.index({ user: 1, read: 1, createdAt: -1 });
notificationSchema.index({ organization: 1, createdAt: -1 });
notificationSchema.index({ project: 1, createdAt: -1 });
notificationSchema.index({ task: 1, createdAt: -1 });
notificationSchema.index({ dedupeKey: 1 }, { unique: true, sparse: true });

notificationSchema.post("save", async function enqueuePush(notification) {
  if (!notification?.user) return;
  try {
    const { PushJob } = await import("./PushJob.js");
    await PushJob.updateOne(
      { notification: notification._id },
      {
        $setOnInsert: {
          notification: notification._id,
          user: notification.user,
          project: notification.project,
          task: notification.task,
          kind: notification.kind,
          title: "Taskspot",
          body: notification.message,
          data: {
            ...notification.data,
            ...(notification.task ? { url: `taskspot://tasks/${notification.task}` } : {})
          }
        }
      },
      { upsert: true }
    );
  } catch (error) {
    console.error("[taskspot:push]", { event: "enqueue_failed", code: error.code || error.name });
  }
});

export const Notification = mongoose.model("Notification", notificationSchema);
