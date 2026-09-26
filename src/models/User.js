import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
    sessionVersion: { type: Number, default: 0 },
    passwordReset: { type: mongoose.Schema.Types.Mixed, select: false },
    adminChallenge: { type: mongoose.Schema.Types.Mixed, select: false },
    emailOutbox: { type: mongoose.Schema.Types.Mixed, select: false },
    name: {
      type: String,
      trim: true,
      required: true
    },
    lastName: {
      type: String,
      trim: true,
      default: ""
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      unique: true,
      required: true
    },
    passwordHash: {
      type: String,
      required: true
    },
    avatarUrl: {
      type: String,
      trim: true,
      default: ""
    },
    phone: {
      type: String,
      trim: true,
      default: ""
    },
    status: {
      type: String,
      enum: ["active", "inactive", "blocked"],
      default: "active"
    },
    isSuperAdmin: {
      type: Boolean,
      default: false
    },
    lastLoginAt: {
      type: Date
    },
    emailVerifiedAt: {
      type: Date
    },
    emailVerificationTokenHash: {
      type: String,
      default: ""
    },
    emailVerificationExpiresAt: {
      type: Date
    },
    emailVerificationSentAt: {
      type: Date
    },
    emailVerificationStatus: {
      type: String,
      enum: ["verified", "pending", "sent", "failed", "skipped"],
      default: "verified"
    },
    emailVerificationError: {
      type: String,
      default: ""
    },
    termsAcceptedAt: { type: Date },
    termsVersion: { type: String, default: "" },
    workspaceProvisioningVersion: {
      type: Number,
      default: 0
    },
    personalOrganization: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Organization"
    },
    starterProject: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project"
    }
  },
  { timestamps: true }
);

userSchema.index({ "passwordReset.outbox.key": 1 }, { sparse: true });
userSchema.index({ "adminChallenge.outbox.key": 1 }, { sparse: true });
userSchema.index({ "passwordReset.tokenHash": 1 }, { sparse: true });
userSchema.index({ "adminChallenge.id": 1 }, { sparse: true });
userSchema.index({ emailVerificationTokenHash: 1 });
userSchema.index({ "emailOutbox.key": 1 }, { sparse: true });
userSchema.index({ isSuperAdmin: 1, createdAt: -1 });
userSchema.index({ isSuperAdmin: 1, status: 1 });

userSchema.methods.toJSON = function toJSON() {
  const user = this.toObject();
  delete user.passwordHash;
  delete user.passwordReset;
  delete user.adminChallenge;
  delete user.sessionVersion;
  delete user.emailVerificationTokenHash;
  delete user.emailOutbox;
  delete user.workspaceProvisioningVersion;
  delete user.personalOrganization;
  delete user.starterProject;
  delete user.termsAcceptedAt;
  delete user.termsVersion;
  return user;
};

export const User = mongoose.model("User", userSchema);
