import bcrypt from "bcryptjs";
import crypto from "node:crypto";
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
import { PushJob } from "../models/PushJob.js";
import { Task, TASK_PRIORITIES } from "../models/Task.js";
import { User } from "../models/User.js";
import { strongPassword, requestPasswordReset, resetPassword } from "../services/accountSecurity.js";
import { canViewTask, idOf, isProjectAdmin, projectMember, taskFilterForProjects, visibleNotificationFilter } from "../services/taskAccess.js";
import { limitExceeded, limitPayload, organizationUsage, planFor } from "../services/plans.js";
import { createMobileSession, requireMobileAuth, revokeMobileSession, rotateMobileSession } from "../services/mobileSessions.js";
import { assertMobileStatusTransition, mobileTaskCapabilities } from "../services/mobileTaskCapabilities.js";
import { attachmentKey, downloadUrlForKey, isStorageConfigured, maxUploadSize, safeFileName, uploadUrlForKey } from "../services/storage.js";
import { overdueTaskFilter, parseTaskDeadline, startOfTaskDay } from "../services/taskDeadline.js";
import {
  findInvitationByToken,
  normalizeRegistrationEmail,
  publicRegistrationResponse,
  sendVerificationAndSave,
  setEmailVerificationToken,
  shouldVerifyEmail,
  verifyEmailAndProvision
} from "./auth.js";

export const mobileRouter = express.Router();

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, keyPrefix: "mobile-auth" });
const ACTIVE_STATUSES = ["open", "in_progress"];
const RECEIPT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const RECEIPT_LEASE_MS = 60 * 1000;

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
  delete value.mobileMutationKeys;
  return value;
}

function taskDtoFor(task, project, userId) {
  return { ...taskDto(task), capabilities: mobileTaskCapabilities(task, project, userId) };
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

async function populatedTask(task, userId) {
  await task.populate([
    { path: "project", select: "name categories members isArchived archivedAt" },
    { path: "creator", select: "name lastName email" },
    { path: "assignee", select: "name lastName email avatarUrl" },
    { path: "observers", select: "name lastName email" },
    { path: "attachments.addedBy", select: "name lastName email" },
  ]);
  await task.project?.populate?.("members.user", "name lastName email avatarUrl");
  const detail = taskDtoFor(task, task.project, userId);
  detail.timelineCounts = { comments: task.comments?.length || 0, activities: task.activities?.length || 0 };
  detail.comments = [];
  detail.activities = [];
  return detail;
}

async function loadVisibleTask(taskId, userId, { omitTimeline = false } = {}) {
  if (!mongoose.isObjectIdOrHexString(taskId)) throw httpError(404, "Task not found");
  const task = await Task.findById(taskId).select(omitTimeline ? "-comments -activities" : "+mobileMutationKeys");
  if (!task) throw httpError(404, "Task not found");
  const project = await Project.findById(task.project);
  if (!project || !canViewTask(task, project, userId)) throw httpError(403, "Task access denied");
  return { task, project };
}

function requestHash(req) {
  return crypto.createHash("sha256").update(`${req.method}\n${req.originalUrl}\n${JSON.stringify(req.body || {})}`).digest("hex");
}

function mutationMarker(userId, key) {
  return `${idOf(userId)}:${key}`;
}

function hasMutation(task, userId, key) {
  return Array.isArray(task.mobileMutationKeys) && task.mobileMutationKeys.includes(mutationMarker(userId, key));
}

function rememberMutation(task, userId, key) {
  task.mobileMutationKeys = [...new Set([...(task.mobileMutationKeys || []), mutationMarker(userId, key)])].slice(-200);
}

async function ensureNotification({ dedupeKey, user, project, task, kind, message, data = {} }) {
  if (!user) return null;
  const notification = await Notification.findOneAndUpdate(
    { dedupeKey },
    { $setOnInsert: { dedupeKey, user, project, task, kind, message, data } },
    { upsert: true, new: true, runValidators: true }
  );
  await PushJob.updateOne(
    { notification: notification._id },
    { $setOnInsert: {
      notification: notification._id, user, project, task, kind, title: "Taskspot", body: message,
      data: { ...data, ...(task ? { url: `taskspot://tasks/${idOf(task)}` } : {}) }
    } },
    { upsert: true }
  );
  return notification;
}

async function ensureStatusNotification({ task, project, next, userId, mutationKey }) {
  let recipient;
  let kind;
  let message;
  if (next === "review") { recipient = task.creator; kind = "task_review"; message = `Задача «${task.description}» ожидает проверки`; }
  if (next === "closed" && task.assignee) { recipient = task.assignee; kind = "task_closed"; message = `Задача «${task.description}» закрыта`; }
  if (next === "in_progress" && task.assignee) { recipient = task.assignee; kind = "task_returned"; message = `Задача «${task.description}» возвращена на доработку`; }
  if (!recipient || idOf(recipient) === userId) return;
  await ensureNotification({
    dedupeKey: `mobile:${userId}:${mutationKey}:status:${kind}:${idOf(recipient)}`,
    user: recipient, project: project._id, task: task._id, kind, message, data: { taskId: idOf(task) }
  });
}

async function idempotent(req, work) {
  const key = String(req.get("Idempotency-Key") || "").trim();
  if (!key || key.length > 128) throw httpError(400, "Idempotency-Key is required");
  const digest = requestHash(req);
  const now = new Date();
  const stale = new Date(now.getTime() - RECEIPT_LEASE_MS);
  let receipt = await MobileMutationReceipt.findOne({ user: req.user._id, key });
  if (receipt?.requestHash && receipt.requestHash !== digest) throw httpError(409, "Idempotency-Key уже использован для другого запроса", { code: "IDEMPOTENCY_KEY_REUSED" });
  if (receipt?.state === "complete") return { status: receipt.statusCode, body: receipt.response };
  if (receipt) {
    const reclaimed = await MobileMutationReceipt.findOneAndUpdate(
      { _id: receipt._id, state: "processing", lockedAt: { $lt: stale } },
      { $set: { lockedAt: now, requestHash: digest, expiresAt: new Date(Date.now() + RECEIPT_TTL_MS) } },
      { new: true }
    );
    if (!reclaimed) throw httpError(409, "Mutation is already processing", { code: "MUTATION_IN_PROGRESS" });
    receipt = reclaimed;
  } else {
    try {
      receipt = await MobileMutationReceipt.create({
        user: req.user._id, key, requestHash: digest, lockedAt: now,
        state: "processing", expiresAt: new Date(Date.now() + RECEIPT_TTL_MS)
      });
    } catch (error) {
      if (error.code === 11000) throw httpError(409, "Mutation is already processing", { code: "MUTATION_IN_PROGRESS" });
      throw error;
    }
  }
  try {
    const result = await work(key);
    await MobileMutationReceipt.updateOne(
      { user: req.user._id, key },
      { state: "complete", statusCode: result.status, response: result.body }
    );
    return result;
  } catch (error) {
    await MobileMutationReceipt.deleteOne({ _id: receipt._id, state: "processing" });
    throw error;
  }
}

function normalizePlatform(value) {
  return ["ios", "android"].includes(value) ? value : "unknown";
}

mobileRouter.post("/auth/register", authLimiter, asyncRoute(async (req, res) => {
  const { name, lastName, email, password, invitationToken } = req.body;
  const normalizedEmail = normalizeRegistrationEmail(email);
  if (!name?.trim() || !lastName?.trim() || !normalizedEmail || !password) throw httpError(400, "Name, last name, email and password are required");
  if (!strongPassword(password)) throw httpError(400, "Password must contain at least 8 characters, letters and digits");
  const invited = await findInvitationByToken(invitationToken);
  if (invitationToken && !invited) throw httpError(400, "Invitation is invalid or expired");
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
  const result = await verifyEmailAndProvision(req.body.token);
  if (!result) throw httpError(400, "Verification link is invalid or expired");
  res.json(await createMobileSession(result.user, { installationId, platform }));
}));

mobileRouter.post("/auth/email/resend", authLimiter, asyncRoute(async (req, res) => {
  const email = normalizeRegistrationEmail(req.body.email);
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
  const now = new Date();
  const [active, today, overdue, review, unassigned, unread] = await Promise.all([
    Task.countDocuments({ $and: [visible, { status: { $in: ACTIVE_STATUSES } }] }),
    Task.countDocuments({ $and: [visible, { dueDate: { $gte: new Date(new Date().setHours(0, 0, 0, 0)), $lt: new Date(new Date().setHours(24, 0, 0, 0)) }, status: { $in: ACTIVE_STATUSES } }] }),
    Task.countDocuments({ $and: [visible, overdueTaskFilter(now), { status: { $in: ACTIVE_STATUSES } }] }),
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
  if (!["all", "active", "today", "overdue", "review", "unassigned", "closed"].includes(focus)) throw httpError(400, "Некорректный focus");
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
  if (focus === "overdue") filters.push(overdueTaskFilter(new Date()), { status: { $in: ACTIVE_STATUSES } });
  if (focus === "review") filters.push({ status: { $in: ["review", "done"] } });
  if (focus === "closed") filters.push({ status: "closed" });
  if (focus === "unassigned") filters.push({ assignee: null, $or: [{ assigneeEmail: null }, { assigneeEmail: "" }], status: { $ne: "closed" } });
  const search = String(req.query.search || "").trim();
  if (search.length > 200) throw httpError(400, "Поиск ограничен 200 символами");
  if (search) filters.push({ description: new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
  const cursor = decodeCursor(req.query.cursor);
  if (cursor) filters.push({ $or: [{ updatedAt: { $lt: cursor.at } }, { updatedAt: cursor.at, _id: { $lt: cursor.id } }] });
  const tasks = await Task.find({ $and: filters })
    .select("description project creator assignee assigneeEmail observers dueDate dueDateHasTime status priority categories updatedAt createdAt")
    .populate("project", "name isArchived archivedAt")
    .populate("creator", "name lastName email")
    .populate("assignee", "name lastName email avatarUrl")
    .populate("observers", "name lastName email")
    .sort({ updatedAt: -1, _id: -1 }).limit(limit + 1).lean();
  const hasMore = tasks.length > limit;
  const projectById = new Map(selected.map((project) => [idOf(project), project]));
  const items = tasks.slice(0, limit).map((task) => taskDtoFor(task, projectById.get(idOf(task.project)), req.user._id));
  const last = items.at(-1);
  res.set("Cache-Control", "no-store");
  res.json({ items, nextCursor: hasMore && last ? encodeCursor({ at: last.updatedAt, id: last._id }) : null, syncedAt: new Date().toISOString() });
}));

mobileRouter.post("/tasks", asyncRoute(async (req, res) => {
  const result = await idempotent(req, async (mutationKey) => {
    const { projectId, description, dueDate, dueDateHasTime = false, priority = "medium", categories = [], assignee, observers = [], checklist = [] } = req.body;
    if (!mongoose.isObjectIdOrHexString(projectId)) throw httpError(400, "Некорректный проект");
    const project = await Project.findById(projectId);
    if (!project || !projectMember(project, req.user._id)) throw httpError(403, "Project access denied");
    if (project.isArchived || project.archivedAt) throw httpError(409, "Archived project does not accept new tasks");
    const marker = mutationMarker(req.user._id, mutationKey);
    const existingTask = await Task.findOne({ creator: req.user._id, mobileMutationKeys: marker }).select("+mobileMutationKeys");
    if (existingTask) {
      if (existingTask.assignee && idOf(existingTask.assignee) !== idOf(req.user)) await ensureNotification({
        dedupeKey: `mobile:${idOf(req.user)}:${mutationKey}:assigned`, user: existingTask.assignee,
        project: project._id, task: existingTask._id, kind: "task_assigned",
        message: `Вам назначена задача в проекте «${project.name}»`, data: { taskId: idOf(existingTask), projectId: idOf(project) }
      });
      return { status: 201, body: { task: await populatedTask(existingTask, req.user._id) } };
    }
    if (!description?.trim()) throw httpError(400, "Description is required");
    if (!TASK_PRIORITIES.includes(priority)) throw httpError(400, "Unknown task priority");
    const memberIds = new Set(project.members.map((member) => idOf(member.user)));
    if (assignee && !memberIds.has(idOf(assignee))) throw httpError(400, "Assignee must be a project member");
    if (!Array.isArray(observers) || observers.some((userId) => !memberIds.has(idOf(userId)))) throw httpError(400, "Observers must be project members");
    const categoryIds = new Set(project.categories.map((category) => idOf(category)));
    if (!Array.isArray(categories) || categories.some((categoryId) => !categoryIds.has(idOf(categoryId)))) throw httpError(400, "Categories must belong to the project");
    const parsedDeadline = parseTaskDeadline(dueDate, dueDateHasTime);
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
      project: project._id, creator: req.user._id, description: description.trim(),
      dueDate: parsedDeadline.dueDate, dueDateHasTime: parsedDeadline.dueDateHasTime,
      priority, categories, assignee: assignee || undefined, observers,
      checklist: Array.isArray(checklist) ? checklist.filter((item) => item?.text?.trim()).map((item) => ({ text: item.text.trim(), done: Boolean(item.done) })) : [],
      status: "open",
      mobileMutationKeys: [marker],
      activities: [{ actor: req.user._id, action: "created", details: "Task created from mobile" }]
    });
    await task.save();
    if (assignee && idOf(assignee) !== idOf(req.user)) await ensureNotification({
      dedupeKey: `mobile:${idOf(req.user)}:${mutationKey}:assigned`, user: assignee, project: project._id, task: task._id, kind: "task_assigned",
      message: `Вам назначена задача в проекте «${project.name}»`, data: { taskId: idOf(task), projectId: idOf(project) }
    });
    return { status: 201, body: { task: await populatedTask(task, req.user._id) } };
  });
  res.status(result.status).json(result.body);
}));

mobileRouter.get("/tasks/:taskId", asyncRoute(async (req, res) => {
  const { task } = await loadVisibleTask(req.params.taskId, req.user._id, { omitTimeline: true });
  const [timeline] = await Task.aggregate([
    { $match: { _id: task._id } },
    { $project: { comments: { $size: "$comments" }, activities: { $size: "$activities" } } }
  ]);
  res.set("Cache-Control", "no-store");
  const detail = await populatedTask(task, req.user._id);
  detail.comments = [];
  detail.activities = [];
  detail.timelineCounts = { comments: timeline?.comments || 0, activities: timeline?.activities || 0 };
  res.json({ task: detail });
}));

function timelineCursor(value) {
  if (!value) return null;
  if (!mongoose.isObjectIdOrHexString(value)) throw httpError(400, "Некорректный cursor");
  return new mongoose.Types.ObjectId(value);
}

async function timelinePage(taskId, kind, cursor, limit) {
  const conditions = cursor ? { $lt: ["$$entry._id", cursor] } : { $literal: true };
  const [result] = await Task.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(taskId) } },
    { $project: { items: { $slice: [{ $reverseArray: { $filter: { input: `$${kind}`, as: "entry", cond: conditions } } }, limit + 1] } } }
  ]);
  const raw = result?.items || [];
  const ids = [...new Set(raw.map((item) => idOf(kind === "comments" ? item.author : item.actor)).filter(Boolean))];
  const people = await User.find({ _id: { $in: ids } }).select("name lastName email avatarUrl").lean();
  const byId = new Map(people.map((person) => [idOf(person), person]));
  const items = raw.slice(0, limit).map((item) => ({ ...item, [kind === "comments" ? "author" : "actor"]: byId.get(idOf(kind === "comments" ? item.author : item.actor)) || null }));
  return { items, nextCursor: raw.length > limit ? idOf(items.at(-1)) : null };
}

for (const kind of ["comments", "activities"]) {
  mobileRouter.get(`/tasks/:taskId/${kind}`, asyncRoute(async (req, res) => {
    await loadVisibleTask(req.params.taskId, req.user._id, { omitTimeline: true });
    const limit = Number(req.query.limit || 20);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw httpError(400, "Некорректный limit");
    res.set("Cache-Control", "no-store");
    res.json(await timelinePage(req.params.taskId, kind, timelineCursor(req.query.cursor), limit));
  }));
}

mobileRouter.patch("/tasks/:taskId/fields", asyncRoute(async (req, res) => {
  const { task, project } = await loadVisibleTask(req.params.taskId, req.user._id);
  const previousAssignee = idOf(task.assignee);
  if (!mobileTaskCapabilities(task, project, req.user._id).canEditFields) throw httpError(403, "Редактирование задачи недоступно");
  if (taskVersion(task) !== expectedVersion(req)) throw httpError(409, "Задача уже изменена", { code: "VERSION_CONFLICT", currentVersion: taskVersion(task) });
  const allowed = ["dueDate", "priority", "assignee", "categories", "observers"];
  const keys = Object.keys(req.body || {});
  if (!keys.length || keys.some((key) => !allowed.includes(key))) throw httpError(400, "Некорректные поля задачи");
  const members = new Set(project.members.map((member) => idOf(member.user)));
  const categories = new Set(project.categories.map((category) => idOf(category)));
  if (Object.hasOwn(req.body, "dueDate")) {
    if (req.body.dueDate) {
      const deadline = new Date(req.body.dueDate);
      if (typeof req.body.dueDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(req.body.dueDate) || !Number.isFinite(deadline.getTime()) || deadline.toISOString().slice(0, 10) !== req.body.dueDate) throw httpError(400, "Некорректный срок задачи");
    }
    const parsed = req.body.dueDate ? parseTaskDeadline(req.body.dueDate, false) : { dueDate: null, dueDateHasTime: false };
    task.dueDate = parsed.dueDate;
    task.dueDateHasTime = parsed.dueDateHasTime;
    task.activities.push({ actor: req.user._id, action: "due_date_changed", details: parsed.dueDate ? parsed.dueDate.toISOString() : "Срок снят" });
  }
  if (Object.hasOwn(req.body, "priority")) {
    if (!TASK_PRIORITIES.includes(req.body.priority)) throw httpError(400, "Некорректный приоритет");
    task.priority = req.body.priority;
    task.activities.push({ actor: req.user._id, action: "priority_changed", details: req.body.priority });
  }
  if (Object.hasOwn(req.body, "assignee")) {
    if (req.body.assignee && !members.has(idOf(req.body.assignee))) throw httpError(400, "Исполнитель должен быть участником проекта");
    task.assignee = req.body.assignee || null;
    task.assigneeEmail = undefined;
    task.activities.push({ actor: req.user._id, action: "assignee_changed", details: req.body.assignee || "Не назначен" });
  }
  for (const field of ["categories", "observers"]) {
    if (!Object.hasOwn(req.body, field)) continue;
    const values = req.body[field];
    const valid = field === "categories" ? categories : members;
    if (!Array.isArray(values) || values.some((value) => !valid.has(idOf(value)))) throw httpError(400, `Некорректные ${field}`);
    task[field] = values;
    task.activities.push({ actor: req.user._id, action: `${field}_changed`, details: values.join(", ") });
  }
  await task.save();
  if (task.assignee && idOf(task.assignee) !== previousAssignee && idOf(task.assignee) !== idOf(req.user)) await ensureNotification({
    dedupeKey: `mobile:fields:${idOf(task)}:${taskVersion(task)}:assigned`, user: task.assignee, project: project._id,
    task: task._id, kind: "task_assigned", message: `Вам назначена задача «${task.description}»`
  });
  res.json({ task: await populatedTask(task, req.user._id) });
}));

mobileRouter.post("/tasks/:taskId/attachments/presign", asyncRoute(async (req, res) => {
  const { task, project } = await loadVisibleTask(req.params.taskId, req.user._id);
  const allowed = mobileTaskCapabilities(task, project, req.user._id).canAttach;
  if (!allowed) throw httpError(403, "Нет прав на добавление вложения");
  if (!isStorageConfigured()) throw httpError(503, "Файловое хранилище не настроено");
  const name = safeFileName(req.body.name);
  const size = Number(req.body.size);
  if (!name || !Number.isFinite(size) || size <= 0 || size > maxUploadSize()) throw httpError(400, "Недопустимый файл");
  const key = attachmentKey({ projectId: project._id, taskId: task._id, userId: req.user._id, fileName: name });
  res.json({ uploadUrl: uploadUrlForKey(key), attachment: { key, name, size, mimeType: String(req.body.mimeType || "application/octet-stream") } });
}));

mobileRouter.post("/tasks/:taskId/attachments", asyncRoute(async (req, res) => {
  const { task, project } = await loadVisibleTask(req.params.taskId, req.user._id);
  if (!mobileTaskCapabilities(task, project, req.user._id).canAttach) throw httpError(403, "Нет прав на добавление вложения");
  if (taskVersion(task) !== expectedVersion(req)) throw httpError(409, "Задача уже изменена", { code: "VERSION_CONFLICT", currentVersion: taskVersion(task) });
  const { key, name, size, mimeType } = req.body;
  const prefix = `attachments/${idOf(project)}/${idOf(task)}/${idOf(req.user)}/`;
  if (typeof key !== "string" || !key.startsWith(prefix) || !name || !Number.isFinite(Number(size)) || Number(size) <= 0 || Number(size) > maxUploadSize()) throw httpError(400, "Некорректное вложение");
  task.attachments.push({ key, name: safeFileName(name), size: Number(size), mimeType: String(mimeType || "application/octet-stream"), addedBy: req.user._id });
  task.activities.push({ actor: req.user._id, action: "attachment_added", details: safeFileName(name) });
  await task.save();
  res.status(201).json({ task: await populatedTask(task, req.user._id) });
}));

mobileRouter.get("/tasks/:taskId/attachments/:attachmentId/download-url", asyncRoute(async (req, res) => {
  const { task } = await loadVisibleTask(req.params.taskId, req.user._id);
  const attachment = task.attachments.id(req.params.attachmentId);
  if (!attachment) throw httpError(404, "Вложение не найдено");
  if (!attachment.key && !attachment.url) throw httpError(404, "Файл недоступен");
  res.json({ url: attachment.key ? downloadUrlForKey(attachment.key) : attachment.url });
}));

mobileRouter.patch("/tasks/:taskId/status", asyncRoute(async (req, res) => {
  const result = await idempotent(req, async (mutationKey) => {
    const { task, project } = await loadVisibleTask(req.params.taskId, req.user._id);
    const next = req.body.status === "done" ? "review" : req.body.status;
    const userId = idOf(req.user);
    if (hasMutation(task, req.user._id, mutationKey)) {
      await ensureStatusNotification({ task, project, next, userId, mutationKey });
      return { status: 200, body: { task: await populatedTask(task, req.user._id) } };
    }
    if (taskVersion(task) !== expectedVersion(req)) throw httpError(409, "Задача уже изменена", { currentVersion: taskVersion(task), code: "VERSION_CONFLICT" });
    const transition = assertMobileStatusTransition(task, project, req.user._id, next, req.body.comment);
    if (!transition.allowed) throw httpError(transition.message.includes("комментарий") ? 400 : 403, transition.message);
    const previous = task.status;
    task.status = next;
    task.activities.push({ actor: req.user._id, action: "status_changed", from: previous, to: next, details: req.body.comment?.trim() || "" });
    if (next === "in_progress" && req.body.comment?.trim()) task.comments.push({ author: req.user._id, text: req.body.comment.trim() });
    rememberMutation(task, req.user._id, mutationKey);
    await task.save();
    await ensureStatusNotification({ task, project, next, userId, mutationKey });
    return { status: 200, body: { task: await populatedTask(task, req.user._id) } };
  });
  res.status(result.status).json(result.body);
}));

mobileRouter.patch("/tasks/:taskId/checklist/:itemId", asyncRoute(async (req, res) => {
  const result = await idempotent(req, async (mutationKey) => {
    const { task, project } = await loadVisibleTask(req.params.taskId, req.user._id);
    if (hasMutation(task, req.user._id, mutationKey)) return { status: 200, body: { task: await populatedTask(task, req.user._id) } };
    if (taskVersion(task) !== expectedVersion(req)) throw httpError(409, "Задача уже изменена", { currentVersion: taskVersion(task), code: "VERSION_CONFLICT" });
    if (!mobileTaskCapabilities(task, project, req.user._id).canEditChecklist) throw httpError(403, "Checklist update is not allowed");
    const item = task.checklist.id(req.params.itemId);
    if (!item) throw httpError(404, "Checklist item not found");
    item.done = Boolean(req.body.done);
    task.activities.push({ actor: req.user._id, action: "checklist_changed", details: item.text });
    rememberMutation(task, req.user._id, mutationKey);
    await task.save();
    return { status: 200, body: { task: await populatedTask(task, req.user._id) } };
  });
  res.status(result.status).json(result.body);
}));

mobileRouter.post("/tasks/:taskId/comments", asyncRoute(async (req, res) => {
  const result = await idempotent(req, async (mutationKey) => {
    const { task, project } = await loadVisibleTask(req.params.taskId, req.user._id);
    const text = String(req.body.text || "").trim();
    if (!text) throw httpError(400, "Comment text is required");
    if (!mobileTaskCapabilities(task, project, req.user._id).canComment) throw httpError(409, "Архивный проект доступен только для просмотра");
    const alreadyApplied = hasMutation(task, req.user._id, mutationKey);
    if (!alreadyApplied) {
      if (taskVersion(task) !== expectedVersion(req)) throw httpError(409, "Задача уже изменена", { currentVersion: taskVersion(task), code: "VERSION_CONFLICT" });
      task.comments.push({ author: req.user._id, text });
      task.activities.push({ actor: req.user._id, action: "comment_added", details: text });
      rememberMutation(task, req.user._id, mutationKey);
      await task.save();
    }
    const recipients = [...new Set([task.creator, task.assignee, ...task.observers].map(idOf).filter(Boolean))]
      .filter((userId) => userId !== idOf(req.user));
    await Promise.all(recipients.map((user) => ensureNotification({
      dedupeKey: `mobile:${idOf(req.user)}:${mutationKey}:comment:${user}`, user, project: project._id, task: task._id, kind: "task_comment",
      message: `Новый комментарий в задаче «${task.description}»`, data: { taskId: idOf(task) }
    })));
    return { status: 201, body: { task: await populatedTask(task, req.user._id) } };
  });
  res.status(result.status).json(result.body);
}));

mobileRouter.get("/control/summary", asyncRoute(async (req, res) => {
  const projects = await Project.find({ "members.user": req.user._id, isArchived: { $ne: true } }).select("members name").lean();
  const administered = projects.filter((project) => isProjectAdmin(project, req.user._id));
  const teamMode = administered.length > 0;
  const selected = req.query.projectId ? administered.filter((project) => idOf(project) === req.query.projectId) : administered;
  if (req.query.projectId && !selected.length) throw httpError(403, "Нет прав на командный контроль проекта");
  const assigneeId = req.query.assigneeId ? String(req.query.assigneeId) : null;
  if (assigneeId && (!teamMode || !mongoose.isObjectIdOrHexString(assigneeId) || !selected.some((project) => project.members.some((member) => idOf(member.user) === assigneeId)))) throw httpError(403, "Нет прав на контроль участника");
  const visible = teamMode
    ? { project: { $in: selected.map((project) => project._id) }, ...(assigneeId ? { assignee: new mongoose.Types.ObjectId(assigneeId) } : {}) }
    : { $and: [taskFilterForProjects(projects, req.user._id), { assignee: req.user._id }] };
  const now = new Date();
  const startToday = startOfTaskDay(now);
  const active = { status: { $in: ACTIVE_STATUSES } };
  const endToday = startOfTaskDay(new Date(startToday.getTime() + 26 * 60 * 60 * 1000));
  const [activeCount, overdueCount, reviewCount, unassignedCount, overdue, waitingReview, unassigned, today, groups] = await Promise.all([
    Task.countDocuments({ $and: [visible, active] }),
    Task.countDocuments({ $and: [visible, active, overdueTaskFilter(now)] }),
    Task.countDocuments({ $and: [visible, { status: { $in: ["review", "done"] } }] }),
    Task.countDocuments({ $and: [visible, { status: { $ne: "closed" }, assignee: null, $or: [{ assigneeEmail: null }, { assigneeEmail: "" }] }] }),
    Task.find({ $and: [visible, active, overdueTaskFilter(now)] }).select("description project assignee dueDate dueDateHasTime status priority").populate("project", "name").populate("assignee", "name lastName avatarUrl").sort({ dueDate: 1 }).limit(10).lean(),
    Task.find({ $and: [visible, { status: { $in: ["review", "done"] } }] }).select("description project assignee dueDate dueDateHasTime status priority").populate("project", "name").populate("assignee", "name lastName avatarUrl").sort({ updatedAt: -1 }).limit(10).lean(),
    Task.find({ $and: [visible, { status: { $ne: "closed" }, assignee: null, $or: [{ assigneeEmail: null }, { assigneeEmail: "" }] }] }).select("description project dueDate dueDateHasTime status priority").populate("project", "name").sort({ updatedAt: -1 }).limit(10).lean(),
    Task.find({ $and: [visible, active, { dueDate: { $gte: startToday, $lt: endToday } }] }).select("description project assignee dueDate dueDateHasTime status priority").populate("project", "name").sort({ dueDate: 1 }).limit(20).lean(),
    Task.aggregate([
      { $match: visible },
      { $group: { _id: "$assignee", active: { $sum: { $cond: [{ $in: ["$status", ACTIVE_STATUSES] }, 1, 0] } }, overdue: { $sum: { $cond: [{ $and: [
        { $in: ["$status", ACTIVE_STATUSES] },
        { $or: [
          { $and: [{ $eq: ["$dueDateHasTime", true] }, { $lt: ["$dueDate", now] }] },
          { $and: [{ $ne: ["$dueDateHasTime", true] }, { $lt: ["$dueDate", startToday] }] }
        ] }
      ] }, 1, 0] } }, review: { $sum: { $cond: [{ $in: ["$status", ["review", "done"]] }, 1, 0] } } } },
      { $sort: { overdue: -1, active: -1 } }, { $limit: 20 }
    ])
  ]);
  const userIds = groups.map((group) => group._id).filter(Boolean);
  const users = await User.find({ _id: { $in: userIds } }).select("name lastName avatarUrl").lean();
  const people = new Map(users.map((user) => [idOf(user), user]));
  res.json({
    mode: teamMode ? "team" : "personal",
    projects: administered.map((project) => ({ _id: project._id, name: project.name })),
    selectedAssignee: assigneeId ? people.get(assigneeId) || null : null,
    summary: { active: activeCount, overdue: overdueCount, waitingReview: reviewCount, unassigned: unassignedCount },
    overdue: overdue.map(taskDto), waitingReview: waitingReview.map(taskDto), unassigned: unassigned.map(taskDto), today: today.map(taskDto),
    byAssignee: teamMode ? groups.map((group) => ({ key: group._id ? idOf(group._id) : "unassigned", user: people.get(idOf(group._id)) || null, active: group.active, overdue: group.overdue, review: group.review })) : []
  });
}));

mobileRouter.get("/control/assignees", asyncRoute(async (req, res) => {
  const projects = (await Project.find({ "members.user": req.user._id, isArchived: { $ne: true } }).select("members").lean()).filter((project) => isProjectAdmin(project, req.user._id));
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
