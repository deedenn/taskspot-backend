import express from "express";
import mongoose from "mongoose";
import { requireRegularUser } from "../middleware/auth.js";
import { Notification } from "../models/Notification.js";
import { Organization } from "../models/Organization.js";
import { Project } from "../models/Project.js";
import { Task, TASK_PRIORITIES, TASK_STATUSES } from "../models/Task.js";
import { User } from "../models/User.js";
import { sendTaskNotificationEmail } from "../services/email.js";
import { limitExceeded, limitPayload, notifyOrganizationLimit, organizationUsage, planFor } from "../services/plans.js";
import { deleteObjectForKey, downloadUrlForKey } from "../services/storage.js";
import { canViewTask, projectMember, isProjectAdmin } from "../services/taskAccess.js";
import { taskSearchFilter } from "../services/taskSearch.js";
import { parseTaskListQuery } from "../services/taskListQuery.js";
import { taskFilterForProjects } from "../services/taskAccess.js";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { calendarParts, nextOccurrence, validTimeZone } from "../services/taskSchedule.js";

export const tasksRouter = express.Router();

tasksRouter.use(requireRegularUser);

const RECURRENCE_FREQUENCIES = ["none", "daily", "weekly", "monthly"];

function asString(value) {
  return value?.toString();
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isArchivedProject(project) {
  return Boolean(project?.isArchived || project?.archivedAt);
}

function canUpdateTaskAttachments(task, project, userId) {
  return (
    isProjectAdmin(project, userId) ||
    asString(task.creator) === asString(userId) ||
    asString(task.assignee) === asString(userId)
  );
}

function ensureProjectUsers(project, userIds) {
  if (!Array.isArray(userIds)) {
    return false;
  }

  const memberIds = new Set(project.members.map((member) => asString(member.user)));
  return userIds.every((userId) => memberIds.has(asString(userId)));
}

function normalizePendingAssignee(value) {
  const text = String(value || "").trim().toLowerCase();
  return text.startsWith("pending:") ? text.slice("pending:".length) : text;
}

function resolveAssignee(project, value) {
  if (value === null || value === "") {
    return { assignee: undefined, assigneeEmail: undefined };
  }

  if (mongoose.isValidObjectId(value) && ensureProjectUsers(project, [value])) {
    return { assignee: value, assigneeEmail: undefined };
  }

  const email = normalizePendingAssignee(value);
  const pendingInvitation = project.invitations?.find(
    (invitation) => invitation.email === email && invitation.status === "pending"
  );

  if (pendingInvitation) {
    return { assignee: undefined, assigneeEmail: email };
  }

  return null;
}

function addActivity(task, actor, action, fields = {}) {
  task.activities.push({
    actor,
    action,
    from: fields.from || "",
    to: fields.to || "",
    details: fields.details || ""
  });
}

function normalizeStatus(status) {
  return status === "done" ? "review" : status;
}

function frontendUrl() {
  return process.env.CLIENT_URL || (process.env.NODE_ENV === "production" ? "https://taskspot.ru" : "http://localhost:5173");
}

async function notifyUser({ user, project, task, message }) {
  if (!user) return;

  const notification = await Notification.create({
    user,
    project,
    task,
    message
  });

  await sendTaskEmail({ user, project, task, message, notificationId: notification._id });
}

async function sendLimitResponse(res, { organization, plan, usage, key, increment = 1, message }) {
  await notifyOrganizationLimit({ organization, plan, usage, key });
  return res.status(402).json(limitPayload({ organization, plan, usage, key, increment, message }));
}

async function sendTaskEmail({ user, project, task, message, notificationId }) {
  try {
    const recipient = await User.findById(user);
    if (!recipient) return;

    const projectDoc = await Project.findById(project).select("name");
    const taskDoc = await Task.findById(task).select("description");

    await sendTaskNotificationEmail({
      email: recipient.email,
      projectName: projectDoc?.name || "Taskspot",
      taskDescription: taskDoc?.description || "Задача",
      message,
      taskUrl: `${frontendUrl().replace(/\/$/, "")}/app/tasks/${task}`,
      context: { kind: "task", userId: String(user), projectId: String(project), taskId: String(task),
        dedupeKey: `notification:${notificationId}` }
    });
  } catch (error) {
    console.error("Failed to send task email", error);
  }
}

function uniqueUserIds(userIds) {
  return [...new Set(userIds.filter(Boolean).map((userId) => asString(userId)))];
}

function ensureArray(value, message) {
  if (!Array.isArray(value)) {
    const error = new Error(message);
    error.statusCode = 400;
    throw error;
  }

  return value;
}

function normalizeCategories(project, categories) {
  const categoryList = ensureArray(categories, "Categories must be an array");
  const projectCategoryIds = new Set(project.categories.map((category) => asString(category._id)));
  const invalidCategory = categoryList.find((categoryId) => !projectCategoryIds.has(asString(categoryId)));

  if (invalidCategory) {
    const error = new Error("Categories must belong to the project");
    error.statusCode = 400;
    throw error;
  }

  return categoryList;
}

function normalizeChecklist(checklist) {
  return ensureArray(checklist, "Checklist must be an array")
    .filter((item) => item?.text?.trim())
    .map((item) => ({
      ...(item._id ? { _id: item._id } : {}),
      text: item.text.trim(),
      done: Boolean(item.done)
    }));
}

function normalizeAttachments(attachments, existingAttachments, userId, { projectId, taskId } = {}) {
  const existingById = new Map(
    existingAttachments.map((item) => [asString(item._id), item])
  );
  const requiredPrefix = projectId && taskId ? `attachments/${projectId}/${taskId}/` : "";

  return ensureArray(attachments, "Attachments must be an array")
    .filter((item) => item?.name?.trim() && (item?.url?.trim() || item?.key?.trim()))
    .map((item) => {
      const existing = item._id ? existingById.get(asString(item._id)) : null;
      const key = String(item.key || existing?.key || "").trim();
      const url = String(item.url || existing?.url || "").trim();

      if (!existing && !key) {
        const error = new Error("New attachments must be uploaded as files");
        error.statusCode = 400;
        throw error;
      }

      if (key && requiredPrefix && !key.startsWith(requiredPrefix)) {
        const error = new Error("Attachment key does not belong to this task");
        error.statusCode = 400;
        throw error;
      }

      return {
        ...(item._id ? { _id: item._id } : {}),
        name: item.name.trim(),
        url,
        key,
        mimeType: String(item.mimeType || existing?.mimeType || "").trim(),
        size: Number(item.size || existing?.size || 0),
        addedBy: existing?.addedBy || userId
      };
    });
}

function normalizeNewAttachment(attachment, userId, { projectId, taskId }) {
  const [normalized] = normalizeAttachments([attachment], [], userId, { projectId, taskId });

  if (!normalized) {
    const error = new Error("Attachment name and file key are required");
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function normalizeRecurrence(recurrence, fallbackDueDate) {
  const enabled = Boolean(recurrence?.enabled);
  const frequency = enabled ? recurrence.frequency || "weekly" : "none";

  if (!RECURRENCE_FREQUENCIES.includes(frequency)) {
    const error = new Error("Unknown recurrence frequency");
    error.statusCode = 400;
    throw error;
  }

  if (enabled && !recurrence.nextRunAt && !fallbackDueDate) {
    const error = new Error("Due date is required for recurring tasks");
    error.statusCode = 400;
    throw error;
  }

  const timeZone = recurrence?.timeZone || process.env.TASK_TIME_ZONE || "Europe/Moscow";
  if (!validTimeZone(timeZone)) throw Object.assign(new Error("Некорректный часовой пояс"), { statusCode: 400 });
  const firstDate = new Date(recurrence?.nextRunAt || fallbackDueDate || Date.now());
  if (!Number.isFinite(firstDate.getTime())) throw Object.assign(new Error("Некорректная дата повтора"), { statusCode: 400 });
  const anchorDay = calendarParts(firstDate, timeZone).day;
  return {
    timeZone,
    anchorDay,
    lastError: "",
    enabled,
    frequency,
    nextRunAt: enabled ? (recurrence.nextRunAt ? firstDate : nextOccurrence(firstDate, frequency, timeZone, anchorDay)) : undefined
  };
}

function parseOptionalDueDate(dueDate) {
  if (dueDate === undefined || dueDate === null || dueDate === "") {
    return undefined;
  }

  const parsedDueDate = new Date(dueDate);
  if (Number.isNaN(parsedDueDate.getTime())) {
    const error = new Error("Due date is invalid");
    error.statusCode = 400;
    throw error;
  }

  return parsedDueDate;
}

async function loadTask(req, res, next) {
  const task = await Task.findById(req.params.taskId);

  if (!task) {
    return res.status(404).json({ message: "Task not found" });
  }

  const project = await Project.findById(task.project);
  if (!project || !projectMember(project, req.user._id)) {
    return res.status(403).json({ message: "Task access denied" });
  }

  if (!canViewTask(task, project, req.user._id)) {
    return res.status(403).json({ message: "Task is not visible for this user" });
  }

  req.task = task;
  req.project = project;
  next();
}

async function respondWithTask(res, task) {
  await task.populate([
    { path: "project", select: "name categories members isArchived archivedAt archivedBy" },
    { path: "creator", select: "name lastName email" },
    { path: "assignee", select: "name lastName email" },
    { path: "observers", select: "name lastName email" },
    { path: "attachments.addedBy", select: "name lastName email" },
    { path: "comments.author", select: "name lastName email" },
    { path: "activities.actor", select: "name lastName email" }
  ]);
  await task.project?.populate?.("members.user", "name lastName email");
  res.json({ task });
}

tasksRouter.get("/:taskId", loadTask, async (req, res) => {
  await respondWithTask(res, req.task);
});

tasksRouter.get("/:taskId/attachments/:attachmentId/download-url", loadTask, async (req, res) => {
  const attachment = req.task.attachments.id(req.params.attachmentId);

  if (!attachment) {
    return res.status(404).json({ message: "Attachment not found" });
  }

  if (attachment.key) {
    try {
      return res.json({ url: downloadUrlForKey(attachment.key) });
    } catch (error) {
      return res.status(error.statusCode || 500).json({ message: error.message });
    }
  }

  if (attachment.url) {
    return res.json({ url: attachment.url });
  }

  res.status(404).json({ message: "Attachment URL not found" });
});

tasksRouter.post("/:taskId/attachments", loadTask, async (req, res) => {
  const userId = req.user._id;

  if (isArchivedProject(req.project)) {
    return res.status(409).json({ message: "Archived project tasks are available for viewing only" });
  }

  if (!canUpdateTaskAttachments(req.task, req.project, userId)) {
    return res.status(403).json({ message: "Only project admin, task creator or assignee can add attachments" });
  }

  let attachment;
  try {
    attachment = normalizeNewAttachment(req.body, userId, {
      projectId: req.project._id,
      taskId: req.task._id
    });
  } catch (error) {
    return res.status(error.statusCode || 400).json({ message: error.message });
  }

  if (req.project.organization) {
    const organization = await Organization.findById(req.project.organization);
    if (organization) {
      const usage = await organizationUsage(organization);
      const plan = planFor(organization);

      if (limitExceeded({ plan, usage, key: "attachments" })) {
        return res.status(402).json({ message: "Вложения доступны на платных тарифах" });
      }
    }
  }

  const now = new Date();
  const task = await Task.findByIdAndUpdate(
    req.task._id,
    {
      $push: {
        attachments: {
          ...attachment,
          createdAt: now,
          updatedAt: now
        },
        activities: {
          actor: userId,
          action: "attachment_added",
          details: attachment.name,
          createdAt: now,
          updatedAt: now
        }
      }
    },
    { new: true, runValidators: true }
  );

  await respondWithTask(res, task);
});

tasksRouter.delete("/:taskId/attachments/:attachmentId", loadTask, async (req, res) => {
  const userId = req.user._id;

  if (isArchivedProject(req.project)) {
    return res.status(409).json({ message: "Archived project tasks are available for viewing only" });
  }

  if (!canUpdateTaskAttachments(req.task, req.project, userId)) {
    return res.status(403).json({ message: "Only project admin, task creator or assignee can delete attachments" });
  }

  const attachment = req.task.attachments.id(req.params.attachmentId);

  if (!attachment) {
    return res.status(404).json({ message: "Attachment not found" });
  }

  const attachmentName = attachment.name;
  const attachmentKey = attachment.key;
  req.task.attachments.pull(attachment._id);
  addActivity(req.task, userId, "attachment_removed", {
    details: attachmentName
  });
  await req.task.save();

  if (attachmentKey) {
    deleteObjectForKey(attachmentKey).catch((error) => {
      console.error("Failed to delete attachment object", error);
    });
  }

  await respondWithTask(res, req.task);
});

tasksRouter.get("/", asyncRoute(async (req, res) => {
  const { projectId } = req.query;
  let options;
  try {
    options = parseTaskListQuery(req.query);
  } catch (error) {
    if (error.statusCode === 400) return res.status(400).json({ message: error.message });
    throw error;
  }
  const { page: requestedPage, limit, sort } = options;
  if (!mongoose.isObjectIdOrHexString(projectId)) {
    return res.status(400).json({ message: "Некорректные параметры списка задач" });
  }
  const project = await Project.findById(projectId).select("members categories");

  if (!project || !projectMember(project, req.user._id)) {
    return res.status(403).json({ message: "Project access denied" });
  }

  let searchFilter;
  try {
    searchFilter = await taskSearchFilter(project, req.query);
  } catch (error) {
    if (error.statusCode === 400) return res.status(400).json({ message: error.message });
    throw error;
  }
  const filter = { $and: [taskFilterForProjects([project], req.user._id), searchFilter] };
  const total = await Task.countDocuments(filter);
  const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / limit)));
  const tasks = await Task.find(filter)
      .select("-activities -attachments -checklist -recurrence")
      .populate("creator", "name lastName email")
      .populate("assignee", "name lastName email")
      .populate("observers", "name lastName email")
      .populate("comments.author", "name lastName email")
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit);

  res.json({ tasks, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } });
}));

tasksRouter.post("/", async (req, res) => {
  const {
    projectId,
    description,
    dueDate,
    categories = [],
    assignee,
    observers = [],
    priority = "medium",
    checklist = [],
    attachments = [],
    recurrence = {},
    templateId
  } = req.body;
  const project = await Project.findById(projectId);

  if (!project || !projectMember(project, req.user._id)) {
    return res.status(403).json({ message: "Project access denied" });
  }

  if (isArchivedProject(project)) {
    return res.status(409).json({ message: "Archived project does not accept new tasks" });
  }

  if (!description?.trim()) {
    return res.status(400).json({ message: "Description is required" });
  }

  if (!TASK_PRIORITIES.includes(priority)) {
    return res.status(400).json({ message: "Unknown task priority" });
  }

  let validCategories;
  let normalizedChecklist;
  let normalizedAttachments;
  let normalizedRecurrence;
  let parsedDueDate;

  try {
    parsedDueDate = parseOptionalDueDate(dueDate);
    validCategories = normalizeCategories(project, categories);
    normalizedChecklist = normalizeChecklist(checklist);
    normalizedAttachments = normalizeAttachments(attachments, [], req.user._id);
    normalizedRecurrence = normalizeRecurrence(recurrence, parsedDueDate);
  } catch (error) {
    return res.status(error.statusCode || 400).json({ message: error.message });
  }

  const organization = project.organization ? await Organization.findById(project.organization) : null;
  if (organization) {
    const usage = await organizationUsage(organization);
    const plan = planFor(organization);

    if (limitExceeded({ plan, usage, key: "activeTasks" })) {
      return sendLimitResponse(res, {
        organization,
        plan,
        usage,
        key: "activeTasks",
        message: "Лимит активных задач на текущем тарифе исчерпан"
      });
    }

    if (
      normalizedAttachments.length &&
      limitExceeded({ plan, usage, key: "attachments", increment: normalizedAttachments.length })
    ) {
      return sendLimitResponse(res, {
        organization,
        plan,
        usage,
        key: "attachments",
        increment: normalizedAttachments.length,
        message: "Лимит вложений на текущем тарифе исчерпан"
      });
    }

    if (normalizedRecurrence.enabled && limitExceeded({ plan, usage, key: "recurringTasks" })) {
      return sendLimitResponse(res, {
        organization,
        plan,
        usage,
        key: "recurringTasks",
        message: "Повторяющиеся задачи недоступны на текущем тарифе"
      });
    }
  }

  const resolvedAssignee = assignee ? resolveAssignee(project, assignee) : { assignee: undefined, assigneeEmail: undefined };

  if (!resolvedAssignee || !ensureProjectUsers(project, observers)) {
    return res.status(400).json({
      message: "Assignee must be a project member or pending invitation, observers must be project members"
    });
  }

  const task = new Task({
    project: project._id,
    creator: req.user._id,
    description,
    dueDate: parsedDueDate,
    categories: validCategories,
    assignee: resolvedAssignee.assignee,
    assigneeEmail: resolvedAssignee.assigneeEmail,
    observers,
    priority,
    checklist: normalizedChecklist,
    attachments: normalizedAttachments,
    recurrence: normalizedRecurrence,
    status: "open"
  });
  addActivity(task, req.user._id, "created", {
    details: templateId ? "Task created from template" : "Task created"
  });
  await task.save();

  if (resolvedAssignee.assignee && asString(resolvedAssignee.assignee) !== asString(req.user._id)) {
    await notifyUser({
      user: resolvedAssignee.assignee,
      project: project._id,
      task: task._id,
      message: `Вам назначена задача в проекте «${project.name}»`
    });
  }

  await respondWithTask(res.status(201), task);
});

tasksRouter.patch("/:taskId", loadTask, async (req, res) => {
  const {
    description,
    dueDate,
    categories,
    assignee,
    observers,
    status: rawStatus,
    priority,
    comment,
    checklist,
    attachments,
    recurrence
  } = req.body;
  const userId = req.user._id;
  const isAdmin = isProjectAdmin(req.project, userId);
  const isCreator = asString(req.task.creator) === asString(userId);
  const isAssignee = asString(req.task.assignee) === asString(userId);
  const canEditDetails = isAdmin || isCreator;
  const canUpdateChecklist = canEditDetails || isAssignee;
  const canUpdateAttachments = canUpdateTaskAttachments(req.task, req.project, userId);
  const detailFields = ["description", "dueDate", "categories", "assignee", "observers", "priority", "recurrence"];
  const hasDetailChanges = detailFields.some((field) => hasOwn(req.body, field));

  if (isArchivedProject(req.project)) {
    return res.status(409).json({ message: "Archived project tasks are available for viewing only" });
  }

  if (hasDetailChanges && !canEditDetails) {
    return res.status(403).json({ message: "Only project admin or task creator can edit task details" });
  }

  if (hasOwn(req.body, "checklist") && !canUpdateChecklist) {
    return res.status(403).json({ message: "Only project admin, task creator or assignee can edit checklist" });
  }

  if (hasOwn(req.body, "attachments") && !canUpdateAttachments) {
    return res.status(403).json({ message: "Only project admin, task creator or assignee can edit attachments" });
  }

  if (hasOwn(req.body, "priority")) {
    if (!TASK_PRIORITIES.includes(priority)) {
      return res.status(400).json({ message: "Unknown task priority" });
    }

    if (priority !== req.task.priority) {
      addActivity(req.task, userId, "priority_changed", {
        from: req.task.priority,
        to: priority
      });
      req.task.priority = priority;
    }
  }

  if (hasOwn(req.body, "status")) {
    const status = normalizeStatus(rawStatus);

    if (!TASK_STATUSES.includes(status)) {
      return res.status(400).json({ message: "Unknown task status" });
    }

    if (status !== req.task.status && req.task.status === "closed") {
      return res.status(400).json({ message: "Closed task status cannot be changed" });
    }

    if (status === "review") {
      if (!isAssignee) {
        return res.status(403).json({ message: "Only assignee can send task to review" });
      }

      if (req.task.status === "closed") {
        return res.status(400).json({ message: "Closed task cannot be sent to review" });
      }
    } else if (status === "closed") {
      if (!isCreator) {
        return res.status(403).json({ message: "Only task creator can confirm and close the task" });
      }

      if (!["review", "done"].includes(req.task.status)) {
        return res.status(400).json({ message: "Only tasks on review can be closed" });
      }
    } else if (["review", "done"].includes(req.task.status) && status === "in_progress") {
      if (!isCreator) {
        return res.status(403).json({ message: "Only task creator can send task back to work" });
      }

      if (!comment?.trim()) {
        return res.status(400).json({ message: "Comment is required when sending task back to work" });
      }
    } else if (["review", "done"].includes(req.task.status) && status !== req.task.status) {
      return res.status(400).json({ message: "Task on review can only be closed or sent back to work" });
    } else if (!isAdmin && !isCreator && !isAssignee) {
      return res.status(403).json({ message: "You cannot change this task status" });
    }

    if (req.task.status !== status) {
      addActivity(req.task, userId, "status_changed", {
        from: req.task.status,
        to: status,
        details: comment?.trim() || ""
      });
    }

    req.task.status = status;

    if (status === "in_progress" && comment?.trim()) {
      req.task.comments.push({ author: userId, text: comment.trim() });
    }
  }

  if (hasOwn(req.body, "description")) {
    if (!description?.trim()) {
      return res.status(400).json({ message: "Description is required" });
    }

    if (description !== req.task.description) {
      addActivity(req.task, userId, "description_changed", {
        from: req.task.description,
        to: description
      });
      req.task.description = description;
    }
  }

  if (hasOwn(req.body, "dueDate")) {
    let parsedDueDate;
    try {
      parsedDueDate = parseOptionalDueDate(dueDate);
    } catch (error) {
      return res.status(error.statusCode || 400).json({ message: error.message });
    }

    const previousDueDate = req.task.dueDate?.toISOString();
    const nextDueDate = parsedDueDate?.toISOString();

    if (previousDueDate !== nextDueDate) {
      addActivity(req.task, userId, "due_date_changed", {
        from: previousDueDate,
        to: nextDueDate
      });
      req.task.dueDate = parsedDueDate;
    }
  }

  if (hasOwn(req.body, "categories")) {
    let validCategories;
    try {
      validCategories = normalizeCategories(req.project, categories);
    } catch (error) {
      return res.status(error.statusCode || 400).json({ message: error.message });
    }

    const previousCategories = req.task.categories.map((categoryId) => asString(categoryId)).join(",");
    const nextCategories = validCategories.map((categoryId) => asString(categoryId)).join(",");

    if (previousCategories !== nextCategories) {
      addActivity(req.task, userId, "categories_changed", {
        from: previousCategories,
        to: nextCategories
      });
      req.task.categories = validCategories;
    }
  }

  if (hasOwn(req.body, "assignee")) {
    const resolvedAssignee = resolveAssignee(req.project, assignee);

    if (!resolvedAssignee) {
      return res.status(400).json({ message: "Assignee must be a project member or pending invitation" });
    }

    const changedAssignee =
      asString(req.task.assignee) !== asString(resolvedAssignee.assignee) ||
      req.task.assigneeEmail !== resolvedAssignee.assigneeEmail;

    if (changedAssignee) {
      addActivity(req.task, userId, "assignee_changed", {
        from: req.task.assigneeEmail || asString(req.task.assignee),
        to: resolvedAssignee.assigneeEmail || asString(resolvedAssignee.assignee)
      });

      req.task.assignee = resolvedAssignee.assignee;
      req.task.assigneeEmail = resolvedAssignee.assigneeEmail;
    }

    if (changedAssignee && resolvedAssignee.assignee) {
      await notifyUser({
        user: resolvedAssignee.assignee,
        project: req.project._id,
        task: req.task._id,
        message: `Вам назначена задача в проекте «${req.project.name}»`
      });
    }
  }

  if (hasOwn(req.body, "observers")) {
    if (!ensureProjectUsers(req.project, observers)) {
      return res.status(400).json({ message: "Observers must be project members" });
    }

    const previousObservers = req.task.observers.map((observer) => asString(observer)).join(",");
    const nextObservers = observers.map((observer) => asString(observer)).join(",");

    if (previousObservers !== nextObservers) {
      addActivity(req.task, userId, "observers_changed", {
        from: previousObservers,
        to: nextObservers
      });
      req.task.observers = observers;
    }
  }

  if (hasOwn(req.body, "checklist")) {
    let nextChecklist;
    try {
      nextChecklist = normalizeChecklist(checklist);
    } catch (error) {
      return res.status(error.statusCode || 400).json({ message: error.message });
    }

    addActivity(req.task, userId, "checklist_changed", { details: "Checklist updated" });
    req.task.checklist = nextChecklist;
  }

  if (hasOwn(req.body, "attachments")) {
    let nextAttachments;
    try {
      nextAttachments = normalizeAttachments(attachments, req.task.attachments, userId, {
        projectId: req.project._id,
        taskId: req.task._id
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({ message: error.message });
    }

    const previousCount = req.task.attachments.length;

    if (nextAttachments.length > previousCount && req.project.organization) {
      const organization = await Organization.findById(req.project.organization);
      if (organization) {
        const usage = await organizationUsage(organization);
        const plan = planFor(organization);
        const addedCount = nextAttachments.length - previousCount;

        if (limitExceeded({ plan, usage, key: "attachments", increment: addedCount })) {
          return sendLimitResponse(res, {
            organization,
            plan,
            usage,
            key: "attachments",
            increment: addedCount,
            message: "Лимит вложений на текущем тарифе исчерпан"
          });
        }
      }
    }

    req.task.attachments = nextAttachments;

    if (nextAttachments.length > previousCount) {
      addActivity(req.task, userId, "attachment_added", {
        details: "Attachment added"
      });
    }
  }

  if (hasOwn(req.body, "recurrence")) {
    let nextRecurrence;
    try {
      nextRecurrence = normalizeRecurrence(recurrence, req.task.dueDate);
    } catch (error) {
      return res.status(error.statusCode || 400).json({ message: error.message });
    }

    if (nextRecurrence.enabled && !req.task.recurrence?.enabled && req.project.organization) {
      const organization = await Organization.findById(req.project.organization);
      if (organization) {
        const usage = await organizationUsage(organization);
        const plan = planFor(organization);

        if (limitExceeded({ plan, usage, key: "recurringTasks" })) {
          return sendLimitResponse(res, {
            organization,
            plan,
            usage,
            key: "recurringTasks",
            message: "Повторяющиеся задачи недоступны на текущем тарифе"
          });
        }
      }
    }

    req.task.recurrence = nextRecurrence;
    addActivity(req.task, userId, "recurrence_changed", {
      details: req.task.recurrence.enabled ? req.task.recurrence.frequency : "none"
    });
  }

  await req.task.save();

  const requestedStatus = hasOwn(req.body, "status") ? normalizeStatus(rawStatus) : undefined;

  if (requestedStatus === "review") {
    await notifyUser({
      user: req.task.creator,
      project: req.project._id,
      task: req.task._id,
      message: `Задача «${req.task.description}» ожидает проверки`
    });
  }

  if (requestedStatus === "closed" && req.task.assignee) {
    await notifyUser({
      user: req.task.assignee,
      project: req.project._id,
      task: req.task._id,
      message: `Задача «${req.task.description}» закрыта`
    });
  }

  if (requestedStatus === "in_progress" && req.task.assignee) {
    await notifyUser({
      user: req.task.assignee,
      project: req.project._id,
      task: req.task._id,
      message: `Задача «${req.task.description}» возвращена на доработку`
    });
  }

  await respondWithTask(res, req.task);
});

tasksRouter.post("/:taskId/comments", loadTask, async (req, res) => {
  const { text } = req.body;

  if (isArchivedProject(req.project)) {
    return res.status(409).json({ message: "Archived project tasks are available for viewing only" });
  }

  if (!text) {
    return res.status(400).json({ message: "Comment text is required" });
  }

  req.task.comments.push({ author: req.user._id, text });
  addActivity(req.task, req.user._id, "comment_added", { details: text });
  await req.task.save();

  const recipients = uniqueUserIds([
    req.task.creator,
    req.task.assignee,
    ...req.task.observers
  ]).filter((recipientId) => recipientId !== asString(req.user._id));

  await Promise.all(
    recipients.map((recipientId) =>
      notifyUser({
        user: recipientId,
        project: req.project._id,
        task: req.task._id,
        message: `Новый комментарий в задаче «${req.task.description}»`
      })
    )
  );

  await respondWithTask(res.status(201), req.task);
});
