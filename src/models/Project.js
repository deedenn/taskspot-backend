import mongoose from "mongoose";

function defaultInvitationExpiresAt() {
  return new Date(Date.now() + 1000 * 60 * 60 * 24 * 14);
}

const projectMemberSchema = new mongoose.Schema(
  {
    emailOutbox: { type: mongoose.Schema.Types.Mixed, select: false },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    role: {
      type: String,
      enum: ["admin", "member"],
      default: "member"
    }
  },
  { _id: false }
);

const categorySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      required: true
    },
    color: {
      type: String,
      default: "#1677ff"
    }
  },
  { timestamps: true }
);

const taskTemplateSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      trim: true,
      required: true
    },
    description: {
      type: String,
      trim: true,
      required: true
    },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "medium"
    },
    categories: [
      {
        type: mongoose.Schema.Types.ObjectId
      }
    ],
    checklist: [
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
      }
    ],
    recurrence: {
      enabled: {
        type: Boolean,
        default: false
      },
      frequency: {
        type: String,
        enum: ["none", "daily", "weekly", "monthly"],
        default: "none"
      }
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    }
  },
  { timestamps: true }
);

const invitationSchema = new mongoose.Schema(
  {
    emailOutbox: { type: mongoose.Schema.Types.Mixed, select: false },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      required: true
    },
    role: {
      type: String,
      enum: ["admin", "member"],
      default: "member"
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    token: {
      type: String,
      default: ""
    },
    expiresAt: {
      type: Date,
      default: defaultInvitationExpiresAt
    },
    emailSentAt: {
      type: Date
    },
    emailStatus: {
      type: String,
      enum: ["pending", "sent", "skipped", "failed"],
      default: "pending"
    },
    emailError: {
      type: String,
      default: ""
    },
    acceptedAt: {
      type: Date
    },
    status: {
      type: String,
      enum: ["pending", "accepted"],
      default: "pending"
    }
  },
  { timestamps: true }
);

const projectAvatarSchema = new mongoose.Schema(
  {
    name: {
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
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    uploadedAt: {
      type: Date
    }
  },
  { _id: false }
);

const projectSchema = new mongoose.Schema(
  {
    organization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization"
    },
    name: {
      type: String,
      trim: true,
      required: true
    },
    description: {
      type: String,
      trim: true,
      default: ""
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    avatar: projectAvatarSchema,
    members: [projectMemberSchema],
    categories: [categorySchema],
    invitations: [invitationSchema],
    templates: [taskTemplateSchema],
    isArchived: {
      type: Boolean,
      default: false
    },
    archivedAt: {
      type: Date
    },
    archivedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    }
  },
  { timestamps: true }
);

projectSchema.index({ "invitations.emailOutbox.key": 1 }, { sparse: true });
projectSchema.index({ "members.emailOutbox.key": 1 }, { sparse: true });
projectSchema.index({ organization: 1, updatedAt: -1 });
projectSchema.index({ "members.user": 1, updatedAt: -1 });
projectSchema.index({ "invitations.token": 1 });
projectSchema.index({ "invitations.email": 1, "invitations.status": 1 });

projectSchema.set("toJSON", { transform: (_document, result) => {
  for (const item of [...(result.members || []), ...(result.invitations || [])]) delete item.emailOutbox;
  return result;
} });

export const Project = mongoose.model("Project", projectSchema);
