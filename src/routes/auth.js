import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import express from "express";

import { sessionToken, strongPassword, requestPasswordReset, resetPassword, startAdminChallenge, finishAdminChallenge } from "../services/accountSecurity.js";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { Notification } from "../models/Notification.js";
import { Organization } from "../models/Organization.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { User } from "../models/User.js";
import { sendEmailVerificationEmail } from "../services/email.js";
import { persistEmailWith } from "../services/emailOutbox.js";

export const authRouter = express.Router();

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyPrefix: "auth"
});

const createToken = sessionToken;

function frontendUrl() {
  return process.env.CLIENT_URL || process.env.FRONTEND_URL || (process.env.NODE_ENV === "production" ? "https://taskspot.ru" : "http://localhost:5173");
}

function createEmailVerificationToken() {
  return crypto.randomBytes(32).toString("hex");
}

function hashEmailVerificationToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function emailVerificationUrl(token) {
  return `${frontendUrl().replace(/\/$/, "")}/verify-email?token=${token}`;
}

function shouldVerifyEmail(user) {
  return !user?.emailVerifiedAt && ["pending", "sent", "failed", "skipped"].includes(user?.emailVerificationStatus);
}

function publicRegistrationResponse({ user, emailResult, verificationToken }) {
  return {
    requiresEmailVerification: true,
    email: user.email,
    emailDeliveryStatus: emailResult.failed ? "failed" : emailResult.queued ? "pending" : emailResult.skipped ? "skipped" : "sent",
    ...(emailResult.reason || emailResult.error ? { emailDeliveryError: emailResult.reason || emailResult.error } : {}),
    ...(process.env.NODE_ENV === "test" ? { verificationToken } : {})
  };
}

async function setEmailVerificationToken(user) {
  const token = createEmailVerificationToken();
  user.emailVerificationTokenHash = hashEmailVerificationToken(token);
  user.emailVerificationExpiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
  user.emailVerificationStatus = "pending";
  user.emailVerificationError = "";
  return token;
}

async function sendVerificationAndSave(user, token) {
  return sendEmailVerificationEmail({
    email: user.email,
    name: user.name,
    verificationUrl: emailVerificationUrl(token),
    dispatch: persistEmailWith(user, "emailOutbox"),
    context: { kind: "verification", userId: String(user._id), tokenHash: user.emailVerificationTokenHash,
      dedupeKey: `verification:${user._id}:${user.emailVerificationTokenHash}` }
  });
}

async function acceptPendingInvitations(user) {
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

        if (project.organization) {
          const organization = await Organization.findById(project.organization);
          const organizationRole = invitation.role === "admin" ? "admin" : "member";

          if (
            organization &&
            !organization.members.some((member) => member.user.toString() === user._id.toString())
          ) {
            organization.members.push({ user: user._id, role: organizationRole });
            await organization.save();
          }
        }

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
              message: `Вам назначена задача в проекте «${project.name}»`
            });
          })
        );
      }
    })
  );
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

const isStrongPassword = strongPassword;

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

    const normalizedEmail = email.toLowerCase();
    const exists = await User.findOne({ email: normalizedEmail });
    if (exists) {
      return res.status(409).json({
        message: shouldVerifyEmail(exists)
          ? "Email is already registered. Please confirm your email or request a new confirmation link."
          : "Email is already registered",
        requiresEmailVerification: shouldVerifyEmail(exists)
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = new User({
      name: name.trim(),
      lastName: lastName.trim(),
      email: normalizedEmail,
      passwordHash,
      emailVerificationStatus: "pending"
    });
    const verificationToken = await setEmailVerificationToken(user);
    const emailResult = await sendVerificationAndSave(user, verificationToken);

    res.status(201).json(publicRegistrationResponse({ user, emailResult, verificationToken }));
  } catch (error) {
    res.status(500).json({ message: "Registration failed", error: error.message });
  }
});

authRouter.post("/email/verify", authLimiter, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ message: "Verification token is required" });
    }

    const tokenHash = hashEmailVerificationToken(token);
    const user = await User.findOne({ emailVerificationTokenHash: tokenHash });

    if (!user || !user.emailVerificationExpiresAt || user.emailVerificationExpiresAt < new Date()) {
      return res.status(400).json({ message: "Verification link is invalid or expired" });
    }

    user.emailVerifiedAt = new Date();
    user.emailVerificationTokenHash = "";
    user.emailVerificationExpiresAt = undefined;
    user.emailVerificationStatus = "verified";
    user.emailVerificationError = "";
    await user.save();
    await acceptPendingInvitations(user);
    user.lastLoginAt = new Date();
    await user.save();
    res.json({ token: createToken(user), user });
  } catch (error) {
    res.status(500).json({ message: "Email verification failed" });
  }
});

authRouter.post("/email/resend", authLimiter, async (req, res) => {
  try {
    const normalizedEmail = req.body.email?.toLowerCase();
    const user = normalizedEmail ? await User.findOne({ email: normalizedEmail }) : null;

    if (!user || !shouldVerifyEmail(user)) {
      return res.json({ ok: true });
    }

    const verificationToken = await setEmailVerificationToken(user);
    const emailResult = await sendVerificationAndSave(user, verificationToken);

    res.json({
      ok: true,
      emailDeliveryStatus: emailResult.failed ? "failed" : emailResult.queued ? "pending" : emailResult.skipped ? "skipped" : "sent",
      ...(emailResult.reason || emailResult.error ? { emailDeliveryError: emailResult.reason || emailResult.error } : {}),
      ...(process.env.NODE_ENV === "test" ? { verificationToken } : {})
    });
  } catch (error) {
    res.status(500).json({ message: "Email verification resend failed", error: error.message });
  }
});

authRouter.post("/login", authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = typeof email === "string" ? email.trim().toLowerCase() : "";

    if (!normalizedEmail || typeof password !== "string" || Buffer.byteLength(password, "utf8") > 72) return res.status(401).json({ message: "Invalid email or password" });
    const user = await User.findOne({ email: normalizedEmail });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    if (user.status && user.status !== "active") {
      return res.status(403).json({ message: user.status === "blocked" ? "User is blocked" : "User is inactive" });
    }

    if (shouldVerifyEmail(user)) {
      return res.status(403).json({
        message: "Подтвердите email, чтобы войти в Taskspot",
        requiresEmailVerification: true,
        email: user.email
      });
    }

    if (user.isSuperAdmin) {
      if (!strongPassword(password, true)) return res.status(403).json({ message: "Обновите пароль администратора через серверную команду настройки" });
      return res.json(await startAdminChallenge(user));
    }
    user.lastLoginAt = new Date();
    await user.save();

    res.json({ token: createToken(user), user });
  } catch (error) {
    res.status(error.statusCode || 500).json({ message: error.statusCode ? error.message : "Login failed" });
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

    if (typeof currentPassword !== "string" || Buffer.byteLength(currentPassword, "utf8") > 72 || !strongPassword(newPassword, req.user.isSuperAdmin)) {
      return res.status(400).json({ message: req.user.isSuperAdmin ? "Нужен текущий пароль и новый: от 12 символов, буквы, цифры и специальный символ (до 72 байт)" : "Нужен текущий пароль и новый: от 8 символов, буквы и цифры (до 72 байт)" });
    }

    const isValid = await bcrypt.compare(currentPassword, req.user.passwordHash);
    if (!isValid) {
      return res.status(400).json({ message: "Неверный текущий пароль" });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    const changed = await User.updateOne({ _id: req.user._id, passwordHash: req.user.passwordHash }, {
      $set: { passwordHash }, $inc: { sessionVersion: 1 }, $unset: { passwordReset: "", adminChallenge: "" }
    });
    if (changed.modifiedCount !== 1) return res.status(409).json({ message: "Пароль уже изменён. Войдите повторно." });

    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ message: "Не удалось изменить пароль" });
  }
});

authRouter.post("/password/forgot", authLimiter, asyncRoute(async (req, res) => {
  await requestPasswordReset(req.body.email);
  res.status(202).json({ message: "Если адрес зарегистрирован и подтверждён, на него будет отправлена ссылка для смены пароля." });
}));
authRouter.post("/password/reset", authLimiter, asyncRoute(async (req, res) => {
  const user = await resetPassword(req.body.token, req.body.password);
  if (!user) return res.status(400).json({ message: "Ссылка недействительна или истекла. Запросите новую." });
  res.json({ ok: true });
}));
authRouter.post("/login/code", authLimiter, asyncRoute(async (req, res) => {
  const user = await finishAdminChallenge(req.body.challengeId, req.body.code);
  if (!user) return res.status(400).json({ message: "Неверный или просроченный код. После 5 попыток запросите новый." });
  res.json({ user, token: sessionToken(user, true) });
}));
