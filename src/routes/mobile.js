import bcrypt from "bcryptjs";
import express from "express";
import mongoose from "mongoose";
import { rateLimit } from "../middleware/rateLimit.js";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { DeviceSession } from "../models/DeviceSession.js";
import { MobileMutationReceipt } from "../models/MobileMutationReceipt.js";
import { Notification } from "../models/Notification.js";
import { Organization } from "../models/Organization.js";
import { Project } from "../models/Project.js";
import { PushDevice } from "../models/PushDevice.js";
import { Task, TASK_PRIORITIES } from "../models/Task.js";
import { User } from "../models/User.js";
import { strongPassword, requestPasswordReset, resetPassword } from "../services/accountSecurity.js";
import { canViewTask, idOf, isProjectAdmin, projectMember, taskFilterForProjects, visibleNotificationFilter } from "../services/taskAccess.js";
import { limitExceeded, limitPayload, organizationUsage, planFor } from "../services/plans.js";
import { createMobileSession, requireMobileAuth, revokeMobileSession, rotateMobileSession } from "../services/mobileSessions.js";
import {
  acceptPendingInvitations,
  findInvitationByToken,
  hashEmailVerificationToken,
  publicRegistrationResponse,
  sendVerificationAndSave,
  setEmailVerificationToken,
  shouldVerifyEmail
} from "./auth.js";

export const mobileRouter = express.Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: "mobile-auth" });
const ACTIVE_STATUSES = ["open", "in_progress"];
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function httpError(statusCode, message, data = {}) {
  return Object.assign(new Error(message), { statusCode, data });
}

function installation(body) {
  const installationId = String(body?.installationId || "").trim();
  if (!installationId || installationId.length > 128) throw httpError(400, "installationId is required");
  const platform = ["ios", "android"].includes(body?.platform) ? body.platform : "unknown";
  return { installationId, platform };
}

function taskVersion(task) {
  return Number(task?.__v || 0);
}

function taskDto(task) {
  const value = typeof task?.toObject === "function" ? task.toObject() : { ...task };
  value.version = taskVersion(value);
  delete value.__v;
  return value;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    const date = new Date(cursor.at);
    if (!mongoose.isObjectIdOrHexString(cursor.id) || Number.isNaN(date.getTime())) throw new Error();
    return { at: date, id: new mongoose.Types.ObjectId(cursor.id) };
  } catch {
    throw httpError(400, "Некорректный cursor");
  }
}

function expectedVersion(req) {
  const source = String(req.get("If-Match") || "").replace(/^W\//, "").replaceAll('"', "");
  if (!/^\d+$/.test(source)) throw httpError(428, "Для изменения нужен If-Match с версией задачи");
  return Number(source);
}

async function populatedTask(task) {
  await task.populate([
    { path: "project", select: "name categories members isArchived archivedAt" },
    { path: "creator", select: "name lastName email" },
    { path: "assignee", select: "name lastName email avatarUrl" },
    { path: "observers", select: "name lastName email" },
    { path: "attachments.addedBy", select: "name lastName email" },
    { path: "comments.author", select: "name lastName email" },
    { path: "activities.actor", select: "name lastName email" }
  ]);
  await task.project?.populate?.("members.user", "name lastName email avatarUrl");
  return taskDto(task);
}

async function loadVisibleTask(taskId, userId) {
  if (!mongoose.isObjectIdOrHexString(taskId)) throw httpError(404, "Task not found");
  const task = await Task.findById(taskId);
  if (!task) throw httpError(404, "Task not found");
  const project = await Project.findById(task.project);
  if (!project || !canViewTask(task, project, userId)) throw httpError(403, "Task access denied");
  return { task, project };
}

async function idempotent(req, work) {
  const key = String(req.get("Idempotency-Key") || "").trim();
  if (!key || key.length > 128) throw httpError(400, "Idempotency-Key is required");
  const existing = await MobileMutationReceipt.findOne({ user: req.user._id, key }).lean();
  if (existing?.state === "complete") return { status: existing.statusCode, body: existing.response };
  if (existing) throw httpError(409, "Mutation is already processing");
  try {
    await MobileMutationReceipt.create({
      user: req.user._id,
      key,
      state: "processing",
      expiresAt: new Date(Date.now() + RECEIPT_TTL_MS)
    });
  } catch (error) {
    if (error.code === 11000) throw httpError(409, "Mutation is already processing");
    throw error;
  }
  try {
    const result = await work();
    await MobileMutationReceipt.updateOne(
      { user: req.user._id, key },
      { state: "complete", statusCode: result.status, response: result.body }
    );
    return result;
  } catch (error) {
    await MobileMutationReceipt.deleteOne({ user: req.user._id, key, state: "processing" });
    throw error;
  }
}

function normalizePlatform(value) {
  return ["ios", "android"].includes(value) ? value : "unknown";
}

mobileRouter.post("/auth/register", authLimiter, asyncRoute(async (req, res) => {
  const { name, lastName, email, password, invitationToken } = req.body;
  if (!name?.trim() || !lastName?.trim() || !email || !password) throw httpError(400, "Name, last name, email and password are required");
  if (!strongPassword(password)) throw httpError(400, "Password must contain at least 8 characters, letters and digits");
  const invited = await findInvitationByToken(invitationToken);
  if (invitationToken && !invited) throw httpError(400, "Invitation is invalid or expired");
  const normalizedEmail = String(email).trim().toLowerCase();
  if (invited && invited.invitation.email !== normalizedEmail) throw httpError(400, "Use the email address from the invitation");
  const exists = await User.findOne({ email: normalizedEmail });
  if (exists) return res.status(409).json({
    message: shouldVerifyEmail(exists) ? "Email is already registered. Please confirm your email." : "Email is already registered",
    requiresEmailVerification: shouldVerifyEmail(exists)
  });
  const user = new User({
    name: name.trim(), lastName: lastName.trim(), email: normalizedEmail,
    passwordHash: await bcrypt.hash(password, 12), emailVerificationStatus: "pending"
  });
  const verificationToken = await setEmailVerificationToken(user);
  const emailResult = await sendVerificationAndSave(user, verificationToken);
  res.status(201).json(publicRegistrationResponse({ user, emailResult, verificationToken }));
}));

mobileRouter.post("/auth/email/verify", authLimiter, asyncRoute(async (req, res) => {
  const { installationId, platform } = installation(req.body);
  if (!req.body.token) throw httpError(400, "Verification token is required");
  const tokenHash = hashEmailVerificationToken(req.body.token);
  const user = await User.db.transaction(async (session) => {
    const candidate = await User.findOne({
      emailVerificationTokenHash: tokenHash,
      emailVerificationExpiresAt: { $gt: new Date() },
      emailVerifiedAt: null
    }).session(session);
    if (!candidate) return null;
    candidate.emailVerifiedAt = new Date();
    candidate.emailVerificationTokenHash = "";
    candidate.emailVerificationExpiresAt = undefined;
    candidate.emailVerificationStatus = "verified";
    candidate.emailVerificationError = "";
    candidate.lastLoginAt = new Date();
    await candidate.save({ session });
    await acceptPendingInvitations(candidate, session);
    return candidate;
  });
  if (!user) throw httpError(400, "Verification link is invalid or expired");
  res.json(await createMobileSession(user, { installationId, platform }));
}));

mobileRouter.post("/auth/email/resend", authLimiter, asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const user = email ? await User.findOne({ email }) : null;
  if (!user || !shouldVerifyEmail(user)) return res.json({ ok: true });
  const verificationToken = await setEmailVerificationToken(user);
  const emailResult = await sendVerificationAndSave(user, verificationToken);
  res.json({
    ok: true,
    emailDeliveryStatus: emailResult.failed ? "failed" : emailResult.queued ? "pending" : emailResult.skipped ? "skipped" : "sent",
    ...(process.env.NODE_ENV === "test" ? { verificationToken } : {})
  });
}));

mobileRouter.post("/auth/login", authLimiter, asyncRoute(async (req, res) => {
  const { installationId, platform } = installation(req.body);
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = req.body.password;
  if (!email || typeof password !== "string" || Buffer.byteLength(password, "utf8") > 72) throw httpError(401, "Invalid email or password");
  const user = await User.findOne({ email });
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) throw httpError(401, "Invalid email or password");
  if (user.status !== "active") throw httpError(403, user.status === "blocked" ? "User is blocked" : "User is inactive");
  if (shouldVerifyEmail(user)) return res.status(403).json({ message: "Подтвердите email, чтобы войти в Taskspot", requiresEmailVerification: true, email });
  if (user.isSuperAdmin) throw httpError(403, "Super admin cannot use mobile workspace");
  user.lastLoginAt = new Date();
  await user.save();
  res.json(await createMobileSession(user, { installationId, platform }));
}));

mobileRouter.post("/auth/refresh", authLimiter, asyncRoute(async (req, res) => {
  const result = await rotateMobileSession(req.body.refreshToken);
  if (!result) throw httpError(401, "Refresh token is invalid or expired");
  res.json(result);
}));

mobileRouter.post("/auth/password/forgot", authLimiter, asyncRoute(async (req, res) => {
  await requestPasswordReset(req.body.email);
  res.status(202).json({ message: "Если адрес зарегистрирован и подтверждён, на него будет отправлена ссылка." });
}));

mobileRouter.post("/auth/password/reset", authLimiter, asyncRoute(async (req, res) => {
  const user = await resetPassword(req.body.token, req.body.password);
  if (!user) throw httpError(400, "Ссылка недействительна или истекла. Запросите новую.");
  res.json({ ok: true });
}));

mobileRouter.use(requireMobileAuth);

mobileRouter.post("/auth/logout", asyncRoute(async (req, res) => {
  await revokeMobileSession({ sessionId: req.mobileSession._id });
  await PushDevice.updateMany({ user: req.user._id, installationId: req.mobileSession.installationId }, { enabled: false, disabledAt: new Date() });
  res.json({ ok: true });
}));

mobileRouter.get("/bootstrap", asyncRoute(async (req, res) => {
  const projects = await Project.find({ "members.user": req.user._id, isArchived: { $ne: true } })
    .select("name description categories members updatedAt")
    .populate("members.user", "name lastName email avatarUrl")
    .sort({ updatedAt: -1 }).lean();
  const visible = taskFilterForProjects(projects, req.user._id);
  const [active, today, overdue, review, unassigned, unread] = await Promise.all([
    Task.countDocuments({ $and: [visible, { status: { $in: ACTIVE_STATUSES } }] }),
    Task.countDocuments({ $and: [visible, { dueDate: { $gte: new Date(new Date().setHours(0, 0, 0, 0)), $lt: new Date(new Date().setHours(24, 0, 0, 0)) }, status: { $in: ACTIVE_STATUSES } }] }),
    Task.countDocuments({ $and: [visible, { dueDate: { $lt: new Date(new Date().setHours(0, 0, 0, 0)) }, status: { $in: ACTIVE_STATUSES } }] }),
    Task.countDocuments({ $and: [visible, { status: { $in: ["review", "done"] } }] }),
    Task.countDocuments({ $and: [visible, { assignee: null, $or: [{ assigneeEmail: null }, { assigneeEmail: "" }], status: { $ne: "closed" } }] }),
    Notification.countDocuments({ ...(await visibleNotificationFilter(req.user._id)), read: false })
  ]);
  res.set("Cache-Control", "no-store");
  res.json({ user: req.user, projects, counts: { active, today, overdue, review, unassigned, unread }, syncedAt: new Date().toISOString() });
}));

mobileRouter.get("/feed", asyncRoute(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 50);
  if (!Number.isSafeInteger(limit)) throw httpError(400, "Некорректный limit");
  const scope = req.query.scope || "all";
  const focus = req.query.focus || "active";
  if (!["all", "assigned", "created", "watching"].includes(scope)) throw httpError(400, "Некорректный scope");
  if (!["all", "active", "today", "overdue", "review", "unassigned"].includes(focus)) throw httpError(400, "Некорректный focus");
  const projects = await Project.find({ "members.user": req.user._id }).select("members name").lean();
  const selected = req.query.projectId ? projects.filter((project) => idOf(project) === req.query.projectId) : projects;
  if (req.query.projectId && !selected.length) throw httpError(403, "Нет доступа к проекту");
  const filters = [taskFilterForProjects(selected, req.user._id)];
  if (scope === "assigned") filters.push({ assignee: req.user._id });
  if (scope === "created") filters.push({ creator: req.user._id });
  if (scope === "watching") filters.push({ observers: req.user._id });
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const endToday = new Date(startToday); endToday.setDate(endToday.getDate() + 1);
  if (focus === "active") filters.push({ status: { $in: ACTIVE_STATUSES } });
  if (focus === "today") filters.push({ dueDate: { $gte: startToday, $lt: endToday }, status: { $in: ACTIVE_STATUSES } });
  if (focus === "overdue") filters.push({ dueDate: { $lt: startToday }, status: { $in: ACTIVE_STATUSES } });
  if (focus === "review") filters.push({ status: { $in: ["review", "done"] } });
  if (focus === "unassigned") filters.push({ assignee: null, $or: [{ assigneeEmail: null }, { assigneeEmail: "" }], status: { $ne: "closed" } });
  const search = String(req.query.search || "").trim();
  if (search.length > 200) throw httpError(400, "Поиск ограничен 200 символами");
  if (search) filters.push({ description: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
  const cursor = decodeCursor(req.query.cursor);
  if (cursor) filters.push({ $or: [{ updatedAt: { $lt: cursor.at } }, { updatedAt: cursor.at, _id: { $lt: cursor.id } }] });
  const tasks = await Task.find({ $and: filters })
    .select("description project creator assignee assigneeEmail observers dueDate status priority categories updatedAt createdAt")
    .populate("project", "name isArchived archivedAt")
    .populate("creator", "name lastName email")
    .populate("assignee", "name lastName email avatarUrl")
    .populate("observers", "name lastName email")
    .sort({ updatedAt: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = tasks.length > limit;
  const items = tasks.slice(0, limit).map(taskDto);
  const last = items.at(-1);
  res.set("Cache-Control", "no-store");
  res.json({ items, nextCursor: hasMore && last ? encodeCursor({ at: last.updatedAt, id: last._id }) : null, syncedAt: new Date().toISOString() });
}));

mobileRouter.post("/tasks", asyncRoute(async (req, res) => {
  const result = await idempotent(req, async () => {
    const { projectId, description, dueDate, priority = "medium", categories = [], assignee, observers = [], checklist = [] } = req.body;
    if (!mongoose.isObjectIdOrHexString(projectId)) throw httpError(400, "Некорректный проект");
    const project = await Project.findById(projectId);
    if (!project || !projectMember(project, req.user._id)) throw httpError(403, "Project access denied");
    if (project.isArchived || project.archivedAt) throw httpError(409, "Archived project does not accept new tasks");
    if (!description?.trim()) throw httpError(400, "Description is required");
    if (!TASK_PRIORITIES.includes(priority)) throw httpError(400, "Unknown task priority");
    const memberIds = new Set(project.members.map((member) => idOf(member.user)));
    if (assignee && !memberIds.has(idOf(assignee))) throw httpError(400, "Assignee must be a project member");
    if (!Array.isArray(observers) || observers.some((userId) => !memberIds.has(idOf(userId)))) throw httpError(400, "Observers must be project members");
    const categoryIds = new Set(project.categories.map((category) => idOf(category)));
    if (!Array.isArray(categories) || categories.some((categoryId) => !categoryIds.has(idOf(categoryId)))) throw httpError(400, "Categories must belong to the project");
    let parsedDueDate;
    if (dueDate) {
      parsedDueDate = new Date(dueDate);
      if (Number.isNaN(parsedDueDate.getTime())) throw httpError(400, "Due date is invalid");
    }
    if (project.organization) {
      const organization = await Organization.findById(project.organization);
      if (organization) {
        const usage = await organizationUsage(organization);
        const plan = planFor(organization);
        if (limitExceeded({ plan, usage, key: "activeTasks" })) {
          return { status: 402, body: limitPayload({ organization, plan, usage, key: "activeTasks", message: "Лимит активных задач исчерпан" }) };
        }
      }
    }
    const task = new Task({
      project: project._id, creator: req.user._id, description: description.trim(), dueDate: parsedDueDate,
      priority, categories, assignee: assignee || undefined, observers,
      checklist: Array.isArray(checklist) ? checklist.filter((item) => item?.text?.trim()).map((item) => ({ text: item.text.trim(), done: Boolean(item.done) })) : [],
      status: "open",
      activities: [{ actor: req.user._id, action: "created", details: "Task created from mobile" }]
    });
    await task.save();
    if (assignee && idOf(assignee) !== idOf(req.user)) await Notification.create({
      user: assignee, project: project._id, task: task._id, kind: "task_assigned",
      message: `Вам назначена задача в проекте «${project.name}»`, data: { taskId: idOf(task), projectId: idOf(project) }
    });
    return { status: 201, body: { task: await populatedTask(task) } };
  });
  res.status(result.status).json(result.body);
}));

mobileRouter.get("/tasks/:taskId", asyncRoute(async (req, res) => {
  const { task } = await loadVisibleTask(req.params.taskId, req.user._id);
  res.set("Cache-Control", "no-store");
  res.json({ task: await populatedTask(task) });
}));

mobileRouter.patch("/tasks/:taskId/status", asyncRoute(async (req, res) => {
  const result = await idempotent(req, async () => {
    const { task, project } = await loadVisibleTask(req.params.taskId, req.user._id);
    if (taskVersion(task) !== expectedVersion(req)) throw httpError(409, "Задача уже изменена", { currentVersion: taskVersion(task) });
    const next = req.body.status === "done" ? "review" : req.body.status;
    const userId = idOf(req.user);
    const creator = idOf(task.creator) === userId;
    const assignee = idOf(task.assignee) === userId;
    const admin = isProjectAdmin(project, userId);
    if (project.isArchived || project.archivedAt) throw httpError(409, "Архивный проект доступен только для просмотра");
    if (task.status === "closed") throw httpError(400, "Closed task status cannot be changed");
    if (next === "review" && !assignee) throw httpError(403, "Only assignee can send task to review");
    if (next === "closed" && (!creator || !["review", "done"].includes(task.status))) throw httpError(403, "Only creator can close a task on review");
    if (["review", "done"].includes(task.status) && next === "in_progress" && (!creator || !req.body.comment?.trim())) {
      throw httpError(400, "Для возврата задачи нужен комментарий инициатора");
    }
    if (!["review", "closed", "in_progress"].includes(next) || (!admin && !creator && !assignee)) throw httpError(403, "Status transition is not allowed");
    const previous = task.status;
    task.status = next;
    task.activities.push({ actor: req.user._id, action: "status_changed", from: previous, to: next, details: req.body.comment?.trim() || "" });
    if (next === "in_progress" && req.body.comment?.trim()) task.comments.push({ author: req.user._id, text: req.body.comment.trim() });
    await task.save();
    let recipient;
    let kind;
    let message;
    if (next === "review") { recipient = task.creator; kind = "task_review"; message = `Задача «${task.description}» ожидает проверки`; }
    if (next === "closed" && task.assignee) { recipient = task.assignee; kind = "task_closed"; message = `Задача «${task.description}» закрыта`; }
    if (next === "in_progress" && task.assignee) { recipient = task.assignee; kind = "task_returned"; message = `Задача «${task.description}» возвращена на доработку`; }
    if (recipient && idOf(recipient) !== userId) await Notification.create({ user: recipient, project: project._id, task: task._id, kind, message, data: { taskId: idOf(task) } });
    return { status: 200, body: { task: await populatedTask(task) } };
  });
  res.status(result.status).json(result.body);
}));

mobileRouter.patch("/tasks/:taskId/checklist/:itemId", asyncRoute(async (req, res) => {
  const result = await idempotent(req, async () => {
    const { task, project } = await loadVisibleTask(req.params.taskId, req.user._id);
    if (taskVersion(task) !== expectedVersion(req)) throw httpError(409, "Задача уже изменена", { currentVersion: taskVersion(task) });
    const canEdit = isProjectAdmin(project, req.user._id) || idOf(task.creator) === idOf(req.user) || idOf(task.assignee) === idOf(req.user);
    if (!canEdit) throw httpError(403, "Checklist update is not allowed");
    const item = task.checklist.id(req.params.itemId);
    if (!item) throw httpError(404, "Checklist item not found");
    item.done = Boolean(req.body.done);
    task.activities.push({ actor: req.user._id, action: "checklist_changed", details: item.text });
    await task.save();
    return { status: 200, body: { task: await populatedTask(task) } };
  });
  res.status(result.status).json(result.body);
}));

mobileRouter.post("/tasks/:taskId/comments", asyncRoute(async (req, res) => {
  const result = await idempotent(req, async () => {
    const { task, project } = await loadVisibleTask(req.params.taskId, req.user._id);
    const text = String(req.body.text || "").trim();
    if (!text) throw httpError(400, "Comment text is required");
    if (project.isArchived || project.archivedAt) throw httpError(409, "Архивный проект доступен только для просмотра");
    task.comments.push({ author: req.user._id, text });
    task.activities.push({ actor: req.user._id, action: "comment_added", details: text });
    await task.save();
    const recipients = [...new Set([task.creator, task.assignee, ...task.observers].map(idOf).filter(Boolean))]
      .filter((userId) => userId !== idOf(req.user));
    await Promise.all(recipients.map((user) => Notification.create({
      user, project: project._id, task: task._id, kind: "task_comment",
      message: `Новый комментарий в задаче «${task.description}»`, data: { taskId: idOf(task) }
    })));
    return { status: 201, body: { task: await populatedTask(task) } };
  });
  res.status(result.status).json(result.body);
}));

mobileRouter.get("/control/summary", asyncRoute(async (req, res) => {
  const projects = await Project.find({ "members.user": req.user._id }).select("members").lean();
  const visible = taskFilterForProjects(projects, req.user._id);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const active = { status: { $in: ACTIVE_STATUSES } };
  const [activeCount, overdueCount, reviewCount, unassignedCount, overdue, waitingReview, unassigned, groups] = await Promise.all([
    Task.countDocuments({ $and: [visible, active] }),
    Task.countDocuments({ $and: [visible, active, { dueDate: { $lt: today } }] }),
    Task.countDocuments({ $and: [visible, { status: { $in: ["review", "done"] } }] }),
    Task.countDocuments({ $and: [visible, { status: { $ne: "closed" }, assignee: null, $or: [{ assigneeEmail: null }, { assigneeEmail: "" }] }] }),
    Task.find({ $and: [visible, active, { dueDate: { $lt: today } }] }).select("description project assignee dueDate status priority").populate("project", "name").populate("assignee", "name lastName avatarUrl").sort({ dueDate: 1 }).limit(10).lean(),
    Task.find({ $and: [visible, { status: { $in: ["review", "done"] } }] }).select("description project assignee dueDate status priority").populate("project", "name").populate("assignee", "name lastName avatarUrl").sort({ updatedAt: -1 }).limit(10).lean(),
    Task.find({ $and: [visible, { status: { $ne: "closed" }, assignee: null, $or: [{ assigneeEmail: null }, { assigneeEmail: "" }] }] }).select("description project dueDate status priority").populate("project", "name").sort({ updatedAt: -1 }).limit(10).lean(),
    Task.aggregate([
      { $match: visible },
      { $group: { _id: "$assignee", active: { $sum: { $cond: [{ $in: ["$status", ACTIVE_STATUSES] }, 1, 0] } }, overdue: { $sum: { $cond: [{ $and: [{ $in: ["$status", ACTIVE_STATUSES] }, { $lt: ["$dueDate", today] }] }, 1, 0] } }, review: { $sum: { $cond: [{ $in: ["$status", ["review", "done"]] }, 1, 0] } } } },
      { $sort: { overdue: -1, active: -1 } }, { $limit: 20 }
    ])
  ]);
  const userIds = groups.map((group) => group._id).filter(Boolean);
  const users = await User.find({ _id: { $in: userIds } }).select("name lastName avatarUrl").lean();
  const people = new Map(users.map((user) => [idOf(user), user]));
  res.json({
    summary: { active: activeCount, overdue: overdueCount, waitingReview: reviewCount, unassigned: unassignedCount },
    overdue: overdue.map(taskDto), waitingReview: waitingReview.map(taskDto), unassigned: unassigned.map(taskDto),
    byAssignee: groups.map((group) => ({ key: group._id ? idOf(group._id) : "unassigned", user: people.get(idOf(group._id)) || null, active: group.active, overdue: group.overdue, review: group.review }))
  });
}));

mobileRouter.get("/control/assignees", asyncRoute(async (req, res) => {
  const projects = await Project.find({ "members.user": req.user._id }).select("members").lean();
  const groups = await Task.aggregate([
    { $match: taskFilterForProjects(projects, req.user._id) },
    { $group: { _id: "$assignee", total: { $sum: 1 }, active: { $sum: { $cond: [{ $in: ["$status", ACTIVE_STATUSES] }, 1, 0] } }, review: { $sum: { $cond: [{ $in: ["$status", ["review", "done"]] }, 1, 0] } } } },
    { $sort: { active: -1, total: -1 } }, { $limit: 50 }
  ]);
  const users = await User.find({ _id: { $in: groups.map((group) => group._id).filter(Boolean) } }).select("name lastName avatarUrl").lean();
  const people = new Map(users.map((user) => [idOf(user), user]));
  res.json({ items: groups.map((group) => ({ ...group, key: group._id ? idOf(group._id) : "unassigned", user: people.get(idOf(group._id)) || null })), nextCursor: null });
}));

mobileRouter.get("/notifications", asyncRoute(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 30), 1), 50);
  const cursor = decodeCursor(req.query.cursor);
  const filters = [await visibleNotificationFilter(req.user._id)];
  if (cursor) filters.push({ $or: [{ createdAt: { $lt: cursor.at } }, { createdAt: cursor.at, _id: { $lt: cursor.id } }] });
  const notifications = await Notification.find({ $and: filters }).populate("project", "name").populate("task", "description status")
    .sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = notifications.length > limit;
  const items = notifications.slice(0, limit);
  const last = items.at(-1);
  res.json({ items, nextCursor: hasMore && last ? encodeCursor({ at: last.createdAt, id: last._id }) : null });
}));

mobileRouter.patch("/notifications/read-all", asyncRoute(async (req, res) => {
  await Notification.updateMany({ ...(await visibleNotificationFilter(req.user._id)), read: false }, { read: true });
  res.json({ ok: true });
}));

mobileRouter.patch("/notifications/:notificationId/read", asyncRoute(async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { ...(await visibleNotificationFilter(req.user._id)), _id: req.params.notificationId }, { read: true }, { new: true }
  );
  if (!notification) throw httpError(404, "Notification not found");
  res.json({ notification });
}));

mobileRouter.put("/devices/:installationId", asyncRoute(async (req, res) => {
  const installationId = String(req.params.installationId || "").trim();
  const token = String(req.body.token || "").trim();
  if (!installationId || installationId.length > 128 || !/^(ExponentPushToken|ExpoPushToken)\[[^\]]+\]$/.test(token)) throw httpError(400, "Некорректный push token");
  await PushDevice.updateMany(
    { user: { $ne: req.user._id }, $or: [{ installationId }, { token }] },
    { enabled: false, disabledAt: new Date() }
  );
  const device = await PushDevice.findOneAndUpdate(
    { user: req.user._id, installationId },
    { token, platform: normalizePlatform(req.body.platform), enabled: req.body.enabled !== false, permission: req.body.permission || "granted", lastSeenAt: new Date(), $unset: { disabledAt: "" } },
    { upsert: true, new: true, runValidators: true }
  );
  res.json({ device });
}));

mobileRouter.delete("/devices/:installationId", asyncRoute(async (req, res) => {
  await PushDevice.updateOne({ user: req.user._id, installationId: req.params.installationId }, { enabled: false, disabledAt: new Date() });
  res.json({ ok: true });
}));

mobileRouter.use((error, req, res, next) => {
  if (!error?.statusCode) return next(error);
  res.status(error.statusCode).json({ message: error.message, ...error.data });
});
