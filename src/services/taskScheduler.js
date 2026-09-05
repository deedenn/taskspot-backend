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
  if (!projectMember(project, userId)) return;
  const user = await User.findById(userId).select("email status");
  if (!user || user.status === "blocked") return;
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
  const baseUrl = process.env.CLIENT_URL || "https://taskspot.ru";
  await sendTaskNotificationEmail({ email: user.email, projectName: project.name, taskDescription: task.description,
    message, taskUrl: `${baseUrl.replace(/\/$/, "")}/app/tasks/${task._id}`,
    context: { kind: dueDate ? "reminder" : "task", userId: idOf(user), projectId: idOf(project), taskId: idOf(task),
      dueDate, dedupeKey: `notification:${notification._id}` } });
}

export function recurrenceGuard(source) {
  return { _id: source._id, "recurrence.enabled": true, "recurrence.nextRunAt": source.recurrence.nextRunAt,
    "recurrence.revision": source.recurrence.revision || { $exists: false } };
}

async function deferRecurrence(source, now, message, assertLease, delay = 3600000) {
  await assertLease();
  await Task.updateOne(recurrenceGuard(source), { $set: {
    "recurrence.lastError": message, "recurrence.retryAt": new Date(now.getTime() + delay)
  } });
}

export async function processRecurrence(source, now, {
  assertLease = async () => {}, notify = notifyTaskOnce, usageFor = organizationUsage, notifyLimit = notifyOrganizationLimit
} = {}) {
  await assertLease();
  const guard = recurrenceGuard(source);
  const project = await Project.findById(source.project);
  if (!project || isArchived(project)) {
    await deferRecurrence(source, now, !project ? "Проект не найден" : "Повтор приостановлен: проект в архиве", assertLease, 300000);
    return;
  }
  const runAt = source.recurrence.nextRunAt;
  const timeZone = source.recurrence.timeZone || "Europe/Moscow";
  const anchor = calendarParts(source.dueDate || runAt, timeZone);
  const anchorDay = source.recurrence.anchorDay || anchor.day;
  const anchorTime = Number.isInteger(source.recurrence.anchorTime?.hour)
    ? { hour: source.recurrence.anchorTime.hour, minute: source.recurrence.anchorTime.minute, second: source.recurrence.anchorTime.second }
    : { hour: anchor.hour, minute: anchor.minute, second: anchor.second };
  const nextRunAt = nextOccurrence(runAt, source.recurrence.frequency, timeZone, anchorDay, anchorTime);
  if (!source.recurrence.anchorDay && source.dueDate && runAt <= source.dueDate) {
    await assertLease();
    await Task.updateOne(guard, { $set: {
      "recurrence.anchorDay": anchorDay, "recurrence.anchorTime": anchorTime,
      "recurrence.nextRunAt": nextOccurrence(source.dueDate, source.recurrence.frequency, timeZone, anchorDay, anchorTime)
    } });
    return;
  }
  const key = `${source._id}:${runAt.toISOString()}`;
  let child = await Task.findOne({ recurrenceKey: key });
  if (!child) {
    if (!projectMember(project, source.creator) || !await User.exists({ _id: source.creator, status: { $ne: "blocked" } })) {
      await deferRecurrence(source, now, "Повтор приостановлен: инициатор недоступен", assertLease);
      return;
    }
    const organization = await Organization.findById(project.organization);
    if (!organization) {
      await deferRecurrence(source, now, "Не удалось определить тариф проекта", assertLease);
      return;
    }
    const usage = await usageFor(organization);
    const plan = planFor(organization);
    const blockedKey = limitExceeded({ plan, usage, key: "activeTasks" }) ? "activeTasks"
      : usage.recurringTasks > plan.limits.recurringTasks ? "recurringTasks" : null;
    if (blockedKey) {
      await deferRecurrence(source, now, "Повтор приостановлен: лимит тарифа", assertLease);
      await assertLease();
      await notifyLimit({ organization, plan, usage, key: blockedKey });
      return;
    }
    await assertLease();
    if (!await Task.exists(guard)) return;
    const categoryIds = new Set(project.categories.map(idOf));
    try {
      child = await Task.create({
        project: project._id, creator: source.creator, description: source.description, priority: source.priority,
        dueDate: runAt, categories: source.categories.filter((category) => categoryIds.has(idOf(category))),
        assignee: projectMember(project, source.assignee) ? source.assignee : undefined,
        assigneeEmail: project.invitations.some((invitation) => invitation.status === "pending" &&
          invitation.email === source.assigneeEmail && invitation.expiresAt > now) ? source.assigneeEmail : undefined,
        observers: source.observers.filter((userId) => projectMember(project, userId)),
        checklist: source.checklist.map((item) => ({ text: item.text, done: false })),
        recurrence: { enabled: false }, recurrenceSource: source._id, recurrenceKey: key,
        activities: [{ actor: source.creator, action: "created", details: "Создана по расписанию" }]
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
      child = await Task.findOne({ recurrenceKey: key });
      if (!child) throw error;
    }
  }
  // The occurrence is reused after a crash; advance only after durable notifications.
  for (const userId of new Set([idOf(child.assignee), idOf(child.creator)].filter(Boolean))) {
    if (!projectMember(project, userId)) continue;
    await assertLease();
    await notify({ task: child, project, userId, event: "recurrence_created",
      message: `Создана задача по расписанию «${child.description}»` });
  }
  await assertLease();
  const result = await Task.updateOne(guard, {
    $set: { "recurrence.nextRunAt": nextRunAt, "recurrence.anchorDay": anchorDay, "recurrence.anchorTime": anchorTime,
      "recurrence.lastRunAt": runAt, "recurrence.lastTask": child._id, "recurrence.lastError": "" },
    $unset: { "recurrence.retryAt": "" }
  });
  console.info("[taskspot:scheduler]", { event: "recurrence_processed", sourceId: String(source._id),
    taskId: String(child._id), runAt, nextRunAt, advanced: result.modifiedCount === 1 });
}

export async function processRecurrences(now = new Date(), options = {}) {
  const assertLease = options.assertLease || (async () => {});
  const sources = Task.find({ "recurrence.enabled": true, "recurrence.nextRunAt": { $lte: now },
    $or: [{ "recurrence.retryAt": null }, { "recurrence.retryAt": { $lte: now } }] })
    .sort({ "recurrence.nextRunAt": 1, _id: 1 }).limit(100).cursor();
  try {
    for await (const source of sources) {
      try { await processRecurrence(source, now, options); }
      catch (error) {
        if (error.code === "SCHEDULER_LEASE_LOST") throw error;
        console.error("[taskspot:scheduler]", { event: "recurrence_failed", sourceId: String(source._id) });
        try { await deferRecurrence(source, now, "Не удалось выполнить повтор. Следующая попытка через 15 минут.", assertLease, 900000); }
        catch (deferError) {
          if (deferError.code === "SCHEDULER_LEASE_LOST") throw deferError;
          console.error("[taskspot:scheduler]", { event: "recurrence_retry_save_failed", sourceId: String(source._id) });
        }
      }
    }
  } finally { await sources.close(); }
}

export async function processReminders(now = new Date(), { assertLease = async () => {} } = {}) {
  const timeZone = process.env.TASK_TIME_ZONE || "Europe/Moscow";
  const today = dateKey(now, timeZone);
  const tomorrow = dateKey(nextOccurrence(now, "daily", timeZone), timeZone);
  const tasks = Task.find({ status: { $in: ["open", "in_progress"] }, dueDate: { $ne: null, $lte: new Date(now.getTime() + 2 * 86400000) } }).cursor();
  try {
    for await (const task of tasks) {
      try {
        await assertLease();
        const project = await Project.findById(task.project);
        if (!project || isArchived(project)) continue;
        const deadline = dateKey(task.dueDate, timeZone);
        if (deadline > tomorrow) continue;
        const overdue = deadline < today;
        const event = overdue ? "task_overdue" : "task_due_soon";
        const recipients = overdue ? [task.assignee, task.creator] : [task.assignee || task.creator];
        for (const userId of new Set(recipients.map(idOf).filter(Boolean))) {
          if (!projectMember(project, userId)) continue;
          await assertLease();
          await notifyTaskOnce({ task, project, userId, event, dueDate: task.dueDate.toISOString(),
            message: overdue ? `Просрочена задача «${task.description}»` : `Подходит срок задачи «${task.description}»` });
        }
      } catch (error) {
        if (error.code === "SCHEDULER_LEASE_LOST") throw error;
        console.error("[taskspot:scheduler]", { event: "reminder_failed", taskId: String(task._id) });
      }
    }
  } finally { await tasks.close(); }
}

export async function runScheduledTasks(now = new Date(), {
  recurrences = processRecurrences, reminders = processReminders, clock = () => new Date()
} = {}) {
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
  let lost = false;
  async function assertLease() {
    if (lost) throw Object.assign(new Error("Scheduler lease lost"), { code: "SCHEDULER_LEASE_LOST" });
    const instant = clock();
    try {
      const result = await WorkerLease.updateOne({ _id: "task-scheduler", token, expiresAt: { $gt: instant } }, {
        $set: { expiresAt: new Date(instant.getTime() + 300000) }
      });
      if (result.matchedCount !== 1) throw new Error("Lease expired");
    } catch {
      lost = true;
      throw Object.assign(new Error("Scheduler lease lost"), { code: "SCHEDULER_LEASE_LOST" });
    }
  }
  const heartbeat = setInterval(() => { void assertLease().catch(() => {}); }, 30000);
  heartbeat.unref();
  try {
    await assertLease();
    await recurrences(now, { assertLease });
    await assertLease();
    await reminders(now, { assertLease });
    return true;
  } finally {
    clearInterval(heartbeat);
    await WorkerLease.deleteOne({ _id: "task-scheduler", token }).catch(() => {
      console.error("[taskspot:scheduler]", { event: "lease_release_failed" });
    });
  }
}
