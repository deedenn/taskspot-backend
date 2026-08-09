import mongoose from "mongoose";

const organizationMemberSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true
    },
    role: {
      type: String,
      enum: ["owner", "admin", "member"],
      default: "member"
    }
  },
  { _id: false }
);

const organizationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      trim: true,
      required: true
    },
    personalOwner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    plan: {
      type: String,
      enum: ["free", "team", "business"],
      default: "free"
    },
    planExpiresAt: {
      type: Date
    },
    planAssignedAt: {
      type: Date
    },
    planAssignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User"
    },
    planSource: {
      type: String,
      enum: ["system", "manual", "billing"],
      default: "system"
    },
    planChangeReason: {
      type: String,
      trim: true,
      default: ""
    },
    billingNote: {
      type: String,
      trim: true,
      default: ""
    },
    members: [organizationMemberSchema]
  },
  { timestamps: true }
);

organizationSchema.index({ "members.user": 1, updatedAt: -1 });
organizationSchema.index({ personalOwner: 1 }, { unique: true, sparse: true });

export const Organization = mongoose.model("Organization", organizationSchema);
