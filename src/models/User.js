import mongoose from "mongoose";

const userSchema = new mongoose.Schema(
  {
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
    }
  },
  { timestamps: true }
);

userSchema.index({ emailVerificationTokenHash: 1 });

userSchema.methods.toJSON = function toJSON() {
  const user = this.toObject();
  delete user.passwordHash;
  delete user.emailVerificationTokenHash;
  return user;
};

export const User = mongoose.model("User", userSchema);
