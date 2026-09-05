import crypto from "node:crypto";
import { Task } from "../models/Task.js";
import { Project } from "../models/Project.js";
import { Organization } from "../models/Organization.js";
import { Notification } from "../models/Notification.js";
import { User } from "../models/User.js";
import { WorkerLease } from "../models/WorkerLease.js";
import { calendarParts, dateKey, nextOccurrence } from "./taskSchedule.js";
import { idOf, projectMember } from "./taskAccess.js";
import { limitExceeded, notifyOrganizationLimit, organizationUsage, planFor } from "./plans.js";
import { sendTaskNotificationEmail } from "./email.js";

const isArchived = (project) => project.isArchived || project.archivedAt;

async function notifyTaskOnce({ task, project, userId, event, message, dueDate }) {
  const dedupeKey = `${event}:${task._id}:${dueDate || ""}:${userId}`;
  let notification;
  try {
    notification = await Notification.findOneAndUpdate({ dedupeKey }, { $setOnInsert: {
      user: userId, project: project._id, task: task._id, message, dedupeKey
    } }, { upsert: true, new: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
    notification = await Notification.findOne({ dedupeKey });
  }
  const user = await User.findById(userId).select("email status");
  if (!user || user.status === "blocked") return;
  const baseUrl = process.env.CLIENT_URL || "https://taskspot.ru";
  await sendTaskNotificationEmail({ email: user.email, projectName: project.name, taskDescription: task.description,
    message, taskUrl: `${baseUrl.replace(/\/$/, "")}/app/tasks/${task._id}`,
    context: { kind: dueDate ? "reminder" : "task", userId: idOf(user), projectId: idOf(project), taskId: idOf(task),
      dueDate, dedupeKey: `notification:${notification._id}` } });
}

export async function processRecurrences(now = new Date()) {
  const sources = Task.find({ "recurrence.enabled": true, "recurrence.nextRunAt": { $lte: now },
    $or: [{ "recurrence.retryAt": null }, { "recurrence.retryAt": { $lte: now } }] }).sort({ "recurrence.nextRunAt": 1 }).cursor();
  for await (const source of sources) {
    const project = await Project.findById(source.project);
    if (!project || isArchived(project)) continue;
    const runAt = source.recurrence.nextRunAt;
    const timeZone = source.recurrence.timeZone || "Europe/Moscow";
    const anchorDay = source.recurrence.anchorDay || calendarParts(source.dueDate || runAt, timeZone).day;
    if (!source.recurrence.anchorDay && source.dueDate && runAt <= source.dueDate) {
      await Task.updateOne({ _id: source._id, "recurrence.nextRunAt": runAt }, { $set: {
        "recurrence.anchorDay": anchorDay,
        "recurrence.nextRunAt": nextOccurrence(source.dueDate, source.recurrence.frequency, timeZone, anchorDay)
      } });
      continue;
    }
    const key = `${source._id}:${runAt.toISOString()}`;
    let child = await Task.findOne({ recurrenceKey: key });
    if (!child) {
      if (!projectMember(project, source.creator)) {
        await Task.updateOne({ _id: source._id }, { $set: { "recurrence.lastError": "Инициатор больше не участвует в проекте", "recurrence.retryAt": new Date(now.getTime() + 3600000) } });
        continue;
      }
      const organization = await Organization.findById(project.organization);
      if (!organization) continue;
      const usage = await organizationUsage(organization);
      const plan = planFor(organization);
      const blockedKey = limitExceeded({ plan, usage, key: "activeTasks" }) ? "activeTasks"
        : usage.recurringTasks > plan.limits.recurringTasks ? "recurringTasks" : null;
      if (blockedKey) {
        await notifyOrganizationLimit({ organization, plan, usage, key: blockedKey });
        await Task.updateOne({ _id: source._id }, { $set: { "recurrence.lastError": "Повтор приостановлен: лимит тарифа", "recurrence.retryAt": new Date(now.getTime() + 3600000) } });
        continue;
      }
      const categoryIds = new Set(project.categories.map(idOf));
      try {
        child = await Task.create({
          project: project._id, creator: source.creator, description: source.description, priority: source.priority,
          dueDate: runAt, categories: source.categories.filter((category) => categoryIds.has(idOf(category))),
          assignee: projectMember(project, source.assignee) ? source.assignee : undefined,
          assigneeEmail: project.invitations.some((invitation) => invitation.status === "pending" && invitation.email === source.assigneeEmail)
            ? source.assigneeEmail : undefined,
          observers: source.observers.filter((userId) => projectMember(project, userId)),
          checklist: source.checklist.map((item) => ({ text: item.text, done: false })),
          recurrence: { enabled: false }, recurrenceSource: source._id, recurrenceKey: key,
          activities: [{ actor: source.creator, action: "created", details: "Создана по расписанию" }]
        });
      } catch (error) {
        if (error.code !== 11000) throw error;
        child = await Task.findOne({ recurrenceKey: key });
      }
    }
    // Keep the cursor unchanged until notification jobs are persisted; retries reuse the child.
    for (const userId of new Set([idOf(child.assignee), idOf(child.creator)].filter(Boolean))) {
      await notifyTaskOnce({ task: child, project, userId, event: "recurrence_created", message: `Создана задача по расписанию «${child.description}»` });
    }
    const nextRunAt = nextOccurrence(runAt, source.recurrence.frequency, timeZone, anchorDay);
    await Task.updateOne({ _id: source._id, "recurrence.enabled": true, "recurrence.nextRunAt": runAt }, {
      $set: { "recurrence.nextRunAt": nextRunAt, "recurrence.anchorDay": anchorDay, "recurrence.lastError": "" }, $unset: { "recurrence.retryAt": "" }
    });
  }
}

export async function processReminders(now = new Date()) {
  const timeZone = process.env.TASK_TIME_ZONE || "Europe/Moscow";
  const today = dateKey(now, timeZone);
  const tomorrow = dateKey(nextOccurrence(now, "daily", timeZone), timeZone);
  const tasks = Task.find({ status: { $in: ["open", "in_progress"] }, dueDate: { $ne: null, $lte: new Date(now.getTime() + 2 * 86400000) } }).cursor();
  for await (const task of tasks) {
    const project = await Project.findById(task.project);
    if (!project || isArchived(project)) continue;
    const deadline = dateKey(task.dueDate, timeZone);
    if (deadline > tomorrow) continue;
    const overdue = deadline < today;
    const event = overdue ? "task_overdue" : "task_due_soon";
    const recipients = overdue ? [task.assignee, task.creator] : [task.assignee || task.creator];
    for (const userId of new Set(recipients.map(idOf).filter(Boolean))) {
      if (!projectMember(project, userId)) continue;
      await notifyTaskOnce({ task, project, userId, event, dueDate: task.dueDate.toISOString(),
        message: overdue ? `Просрочена задача «${task.description}»` : `Подходит срок задачи «${task.description}»` });
    }
  }
}

export async function runScheduledTasks(now = new Date()) {
  const token = crypto.randomUUID();
  try {
    const lease = await WorkerLease.findOneAndUpdate({ _id: "task-scheduler", expiresAt: { $lte: now } }, {
      $set: { token, expiresAt: new Date(now.getTime() + 300000) }
    }, { upsert: true, new: true });
    if (!lease) return false;
  } catch (error) {
    if (error.code === 11000) return false;
    throw error;
  }
  const heartbeat = setInterval(() => {
    void WorkerLease.updateOne({ _id: "task-scheduler", token }, { $set: { expiresAt: new Date(Date.now() + 300000) } }).catch(() => {});
  }, 30000);
  heartbeat.unref();
  try {
    await processRecurrences(now);
    await processReminders(now);
    return true;
  } finally {
    clearInterval(heartbeat);
    await WorkerLease.deleteOne({ _id: "task-scheduler", token });
  }
}
