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
    plan: {
      type: String,
      enum: ["free", "team", "business"],
      default: "free"
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

export const Organization = mongoose.model("Organization", organizationSchema);
