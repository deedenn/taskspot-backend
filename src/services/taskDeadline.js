import { calendarParts, fromCalendar } from "./taskSchedule.js";

export const TASK_TIME_ZONE = process.env.TASK_TIME_ZONE || "Europe/Moscow";

export function parseTaskDeadline(value, hasTime = false) {
  if (value === undefined || value === null || value === "") {
    return { dueDate: undefined, dueDateHasTime: false };
  }

  const dueDate = new Date(value);
  if (!Number.isFinite(dueDate.getTime())) {
    throw Object.assign(new Error("Due date is invalid"), { statusCode: 400 });
  }

  return { dueDate, dueDateHasTime: Boolean(hasTime) };
}

export function effectiveTaskDeadline(task, timeZone = TASK_TIME_ZONE) {
  if (!task?.dueDate) return null;
  const dueDate = new Date(task.dueDate);
  if (!Number.isFinite(dueDate.getTime())) return null;
  if (task.dueDateHasTime) return dueDate;

  const { year, month, day } = calendarParts(dueDate, timeZone);
  const lastSecond = fromCalendar({ year, month, day, hour: 23, minute: 59, second: 59 }, timeZone);
  return new Date(lastSecond.getTime() + 999);
}

export function isTaskPastDeadline(task, now = new Date(), timeZone = TASK_TIME_ZONE) {
  const deadline = effectiveTaskDeadline(task, timeZone);
  return Boolean(deadline && deadline < now);
}

export function startOfTaskDay(now = new Date(), timeZone = TASK_TIME_ZONE) {
  const { year, month, day } = calendarParts(now, timeZone);
  return fromCalendar({ year, month, day, hour: 0, minute: 0, second: 0 }, timeZone);
}

export function overdueTaskFilter(now = new Date(), timeZone = TASK_TIME_ZONE) {
  const startOfToday = startOfTaskDay(now, timeZone);

  return {
    $or: [
      { dueDateHasTime: true, dueDate: { $lt: now } },
      { dueDateHasTime: { $ne: true }, dueDate: { $lt: startOfToday } }
    ]
  };
}
