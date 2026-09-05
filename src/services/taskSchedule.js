import crypto from "node:crypto";

export function validTimeZone(timeZone) {
  try { new Intl.DateTimeFormat("en", { timeZone }).format(new Date()); return true; } catch { return false; }
}

export function calendarParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

export function dateKey(date, timeZone) {
  const { year, month, day } = calendarParts(date, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Convert calendar time to UTC, preserving local time across offset changes.
function fromCalendar(parts, timeZone) {
  const asUtc = (value) => Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
  const target = asUtc(parts);
  const offsets = new Set();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const probe = target + hours * 3600000;
    offsets.add(asUtc(calendarParts(new Date(probe), timeZone)) - probe);
  }
  const candidates = [...offsets].map((offset) => target - offset).sort((a, b) => a - b);
  // Ambiguous local times use the earlier instant; nonexistent times move forward by the gap.
  const exact = candidates.find((value) => asUtc(calendarParts(new Date(value), timeZone)) === target);
  if (exact !== undefined) return new Date(exact);
  const forward = candidates.filter((value) => asUtc(calendarParts(new Date(value), timeZone)) > target);
  if (!forward.length) throw new Error("Некорректное календарное время");
  return new Date(forward[0]);
}

export function nextOccurrence(date, frequency, timeZone = "Europe/Moscow", anchorDay, anchorTime) {
  if (!["daily", "weekly", "monthly"].includes(frequency) || !validTimeZone(timeZone) || !Number.isFinite(new Date(date).getTime())) {
    throw new Error("Некорректное расписание задачи");
  }
  if (anchorDay !== undefined && (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31)) {
    throw new Error("Некорректный день повтора");
  }
  if (anchorTime && [["hour", 23], ["minute", 59], ["second", 59]].some(([key, max]) =>
    !Number.isInteger(anchorTime[key]) || anchorTime[key] < 0 || anchorTime[key] > max)) {
    throw new Error("Некорректное время повтора");
  }
  const parts = { ...calendarParts(new Date(date), timeZone), ...(anchorTime || {}) };
  const calendar = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  if (frequency === "monthly") {
    calendar.setUTCDate(1);
    calendar.setUTCMonth(calendar.getUTCMonth() + 1);
    const lastDay = new Date(Date.UTC(calendar.getUTCFullYear(), calendar.getUTCMonth() + 1, 0)).getUTCDate();
    calendar.setUTCDate(Math.min(anchorDay || parts.day, lastDay));
  } else {
    calendar.setUTCDate(calendar.getUTCDate() + (frequency === "weekly" ? 7 : 1));
  }
  return fromCalendar({ ...parts, year: calendar.getUTCFullYear(), month: calendar.getUTCMonth() + 1, day: calendar.getUTCDate() }, timeZone);
}

export function normalizeRecurrence(recurrence, fallbackDueDate) {
  if (!recurrence || typeof recurrence !== "object" || Array.isArray(recurrence)) {
    throw Object.assign(new Error("Некорректное расписание"), { statusCode: 400 });
  }
  const enabled = Boolean(recurrence.enabled);
  const frequency = enabled ? recurrence.frequency || "weekly" : "none";
  if (enabled && !["daily", "weekly", "monthly"].includes(frequency)) {
    throw Object.assign(new Error("Некорректная частота повтора"), { statusCode: 400 });
  }
  if (enabled && !recurrence.nextRunAt && !fallbackDueDate) {
    throw Object.assign(new Error("Для повторяющейся задачи нужен срок"), { statusCode: 400 });
  }
  const timeZone = recurrence.timeZone || process.env.TASK_TIME_ZONE || "Europe/Moscow";
  if (!validTimeZone(timeZone)) throw Object.assign(new Error("Некорректный часовой пояс"), { statusCode: 400 });
  const firstDate = new Date(recurrence.nextRunAt || fallbackDueDate || Date.now());
  if (!Number.isFinite(firstDate.getTime())) throw Object.assign(new Error("Некорректная дата повтора"), { statusCode: 400 });
  const { day: anchorDay, hour, minute, second } = calendarParts(firstDate, timeZone);
  const anchorTime = { hour, minute, second };
  return { enabled, frequency, timeZone, anchorDay, anchorTime, revision: crypto.randomUUID(), lastError: "",
    nextRunAt: enabled ? (recurrence.nextRunAt ? firstDate : nextOccurrence(firstDate, frequency, timeZone, anchorDay, anchorTime)) : undefined };
}
