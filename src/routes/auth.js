import bcrypt from "bcryptjs";
import express from "express";
import jwt from "jsonwebtoken";
import { requireJwtSecret } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { Notification } from "../models/Notification.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { User } from "../models/User.js";

export const authRouter = express.Router();

const BOOTSTRAP_ADMIN_EMAIL = "admin@taskspot.ru";
const BOOTSTRAP_ADMIN_PASSWORD = "qwerty";
const LEGACY_BOOTSTRAP_ADMIN_PASSWORD = "admin";

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyPrefix: "auth"
});

function createToken(user) {
  return jwt.sign({ userId: user._id }, requireJwtSecret(), {
    algorithm: "HS256",
    expiresIn: "7d"
  });
}

async function ensureBootstrapAdmin() {
  const existing = await User.findOne({ email: BOOTSTRAP_ADMIN_EMAIL });

  if (existing) {
    let changed = false;

    if (!existing.isSuperAdmin) {
      existing.isSuperAdmin = true;
      existing.passwordHash = await bcrypt.hash(BOOTSTRAP_ADMIN_PASSWORD, 12);
      changed = true;
    }

    if (existing.status !== "active") {
      existing.status = "active";
      changed = true;
    }

    if (await bcrypt.compare(LEGACY_BOOTSTRAP_ADMIN_PASSWORD, existing.passwordHash)) {
      existing.passwordHash = await bcrypt.hash(BOOTSTRAP_ADMIN_PASSWORD, 12);
      changed = true;
    }

    if (changed) {
      await existing.save();
    }

    return existing;
  }

  const passwordHash = await bcrypt.hash(BOOTSTRAP_ADMIN_PASSWORD, 12);
  return User.create({
    name: "Taskspot Admin",
    email: BOOTSTRAP_ADMIN_EMAIL,
    passwordHash,
    isSuperAdmin: true,
    status: "active"
  });
}

function publicInvitation(project, invitation) {
  return {
    email: invitation.email,
    role: invitation.role,
    expiresAt: invitation.expiresAt,
    project: {
      id: project._id,
      name: project.name,
      description: project.description
    },
    invitedBy: invitation.invitedBy
      ? {
          name: invitation.invitedBy.name,
          email: invitation.invitedBy.email
        }
      : null
  };
}

function isStrongPassword(password) {
  return (
    typeof password === "string" &&
    password.length >= 8 &&
    /[A-Za-zА-Яа-яЁё]/.test(password) &&
    /\d/.test(password)
  );
}

async function findInvitationByToken(token) {
  if (!token) return null;

  const project = await Project.findOne({
    "invitations.token": token,
    "invitations.status": "pending"
  }).populate("invitations.invitedBy", "name lastName email");

  if (!project) return null;

  const invitation = project.invitations.find(
    (item) => item.token === token && item.status === "pending"
  );

  if (!invitation || invitation.expiresAt < new Date()) {
    return null;
  }

  return { project, invitation };
}

authRouter.get("/invitations/:token", async (req, res) => {
  const found = await findInvitationByToken(req.params.token);

  if (!found) {
    return res.status(404).json({ message: "Invitation not found or expired" });
  }

  res.json({ invitation: publicInvitation(found.project, found.invitation) });
});

authRouter.post("/register", authLimiter, async (req, res) => {
  try {
    const { name, lastName, email, password, invitationToken } = req.body;

    if (!name?.trim() || !lastName?.trim() || !email || !password) {
      return res.status(400).json({ message: "Name, last name, email and password are required" });
    }

    if (!isStrongPassword(password)) {
      return res.status(400).json({ message: "Password must contain at least 8 characters, letters and digits" });
    }

    const invited = await findInvitationByToken(invitationToken);
    if (invitationToken && !invited) {
      return res.status(400).json({ message: "Invitation is invalid or expired" });
    }

    if (invited && invited.invitation.email !== email.toLowerCase()) {
      return res.status(400).json({ message: "Use the email address from the invitation" });
    }

    const exists = await User.findOne({ email: email.toLowerCase() });
    if (exists) {
      return res.status(409).json({ message: "Email is already registered" });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await User.create({
      name: name.trim(),
      lastName: lastName.trim(),
      email,
      passwordHash
    });
    const invitedProjects = await Project.find({
      "invitations.email": user.email,
      "invitations.status": "pending"
    });

    await Promise.all(
      invitedProjects.map(async (project) => {
        const invitation = project.invitations.find(
          (item) => item.email === user.email && item.status === "pending"
        );
        const isAlreadyMember = project.members.some(
          (member) => member.user.toString() === user._id.toString()
        );

        if (invitation && !isAlreadyMember) {
          project.members.push({ user: user._id, role: invitation.role });
          invitation.status = "accepted";
          invitation.acceptedAt = new Date();
          await project.save();

          const assignedTasks = await Task.find({
            project: project._id,
            assigneeEmail: user.email,
            $or: [{ assignee: { $exists: false } }, { assignee: null }]
          });

          await Promise.all(
            assignedTasks.map(async (task) => {
              task.assignee = user._id;
              task.assigneeEmail = undefined;
              await task.save();

              await Notification.create({
                user: user._id,
                project: project._id,
                task: task._id,
                message: `You were assigned a task in "${project.name}"`
              });
            })
          );
        }
      })
    );

    res.status(201).json({ token: createToken(user), user });
  } catch (error) {
    res.status(500).json({ message: "Registration failed" });
  }
});

authRouter.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = email?.toLowerCase();

    if (normalizedEmail === BOOTSTRAP_ADMIN_EMAIL) {
      await ensureBootstrapAdmin();
    }

    const user = await User.findOne({ email: normalizedEmail });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    if (user.status && user.status !== "active") {
      return res.status(403).json({ message: user.status === "blocked" ? "User is blocked" : "User is inactive" });
    }

    user.lastLoginAt = new Date();
    await user.save();

    res.json({ token: createToken(user), user });
  } catch (error) {
    res.status(500).json({ message: "Login failed" });
  }
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.user });
});

authRouter.patch("/me", requireAuth, async (req, res) => {
  try {
    const { name, lastName = "", phone = "", avatarUrl = "" } = req.body;

    if (!name?.trim() || !lastName?.trim()) {
      return res.status(400).json({ message: "Name and last name are required" });
    }

    req.user.name = name.trim();
    req.user.lastName = lastName.trim();
    req.user.phone = String(phone || "").trim();
    req.user.avatarUrl = String(avatarUrl || "").trim();
    await req.user.save();

    res.json({ user: req.user });
  } catch (error) {
    res.status(500).json({ message: "Profile update failed" });
  }
});

authRouter.patch("/password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !isStrongPassword(newPassword)) {
      return res.status(400).json({ message: "Current password and strong new password are required" });
    }

    const isValid = await bcrypt.compare(currentPassword, req.user.passwordHash);
    if (!isValid) {
      return res.status(400).json({ message: "Current password is incorrect" });
    }

    req.user.passwordHash = await bcrypt.hash(newPassword, 12);
    await req.user.save();

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: "Password update failed" });
  }
});
