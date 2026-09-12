import mongoose from "mongoose";

const ticketSchema = new mongoose.Schema(
  { id: String, token: String },
  { _id: false }
);

const pushJobSchema = new mongoose.Schema(
  {
    notification: { type: mongoose.Schema.Types.ObjectId, ref: "Notification", required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project" },
    task: { type: mongoose.Schema.Types.ObjectId, ref: "Task" },
    kind: { type: String, default: "task_updated" },
    title: { type: String, default: "Taskspot" },
    body: { type: String, required: true },
    data: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
    status: { type: String, enum: ["queued", "processing", "sent", "retry", "failed"], default: "queued" },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    lockedAt: Date,
    tickets: [ticketSchema],
    receiptsCheckedAt: Date,
    lastError: { type: String, default: "" }
  },
  { timestamps: true }
);

pushJobSchema.index({ status: 1, nextAttemptAt: 1 });

export const PushJob = mongoose.model("PushJob", pushJobSchema);
