import mongoose from "mongoose";

export const TASK_STATUSES = ["open", "in_progress", "review", "done", "closed"];
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"];

const commentSchema = new mongoose.Schema(
  {
    author: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    text: {
      type: String,
      trim: true,
      required: true
    }
  },
  { timestamps: true }
);

const activitySchema = new mongoose.Schema(
  {
    actor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    action: {
      type: String,
      enum: [
        "created",
        "status_changed",
        "description_changed",
        "due_date_changed",
        "categories_changed",
        "assignee_changed",
        "observers_changed",
        "priority_changed",
        "checklist_changed",
        "attachment_added",
        "attachment_removed",
        "recurrence_changed",
        "comment_added"
      ],
      required: true
    },
    from: {
      type: String,
      default: ""
    },
    to: {
      type: String,
      default: ""
    },
    details: {
      type: String,
      default: ""
    }
  },
  { timestamps: true }
);

const checklistItemSchema = new mongoose.Schema(
  {
    text: {
      type: String,
      trim: true,
      required: true
    },
    done: {
      type: Boolean,
      default: false
    }
  },
  { timestamps: true }
);

const attachmentSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      required: true
    },
    url: {
      type: String,
      trim: true,
      default: ""
    },
    key: {
      type: String,
      trim: true,
      default: ""
    },
    mimeType: {
      type: String,
      trim: true,
      default: ""
    },
    size: {
      type: Number,
      default: 0
    },
    addedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    }
  },
  { timestamps: true }
);

const taskSchema = new mongoose.Schema(
  {
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true
    },
    creator: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    description: {
      type: String,
      trim: true,
      required: true
    },
    dueDate: {
      type: Date
    },
    categories: [
      {
        type: mongoose.Schema.Types.ObjectId
      }
    ],
    assignee: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    assigneeEmail: {
      type: String,
      trim: true,
      lowercase: true
    },
    observers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User"
      }
    ],
    priority: {
      type: String,
      enum: TASK_PRIORITIES,
      default: "medium"
    },
    checklist: [checklistItemSchema],
    attachments: [attachmentSchema],
    recurrence: {
      timeZone: { type: String, default: "Europe/Moscow" },
      anchorDay: Number,
      anchorTime: { hour: Number, minute: Number, second: Number },
      revision: String,
      lastRunAt: Date,
      lastTask: { type: mongoose.Schema.Types.ObjectId, ref: "Task" },
      lastError: { type: String, default: "" },
      retryAt: Date,
      enabled: {
        type: Boolean,
        default: false
      },
      frequency: {
        type: String,
        enum: ["none", "daily", "weekly", "monthly"],
        default: "none"
      },
      nextRunAt: {
        type: Date
      }
    },
    recurrenceSource: { type: mongoose.Schema.Types.ObjectId, ref: "Task" },
    recurrenceKey: { type: String },
    status: {
      type: String,
      enum: TASK_STATUSES,
      default: "open"
    },
    comments: [commentSchema],
    activities: [activitySchema]
  },
  { timestamps: true }
);

taskSchema.index({ project: 1, status: 1, dueDate: 1 });
taskSchema.index({ project: 1, updatedAt: -1, _id: -1 });
taskSchema.index({ project: 1, createdAt: -1, _id: -1 });
taskSchema.index({ creator: 1, updatedAt: -1 });
taskSchema.index({ assignee: 1, updatedAt: -1 });
taskSchema.index({ observers: 1, updatedAt: -1 });
taskSchema.index({ assigneeEmail: 1 });
taskSchema.index({ "recurrence.enabled": 1, status: 1 });
taskSchema.index({ "recurrence.enabled": 1, "recurrence.nextRunAt": 1 });
taskSchema.index({ recurrenceKey: 1 }, { unique: true, sparse: true });

export const Task = mongoose.model("Task", taskSchema);
