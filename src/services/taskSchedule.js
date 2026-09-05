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
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let timestamp = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const actual = calendarParts(new Date(timestamp), timeZone);
    const delta = target - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    if (!delta) break;
    timestamp += delta;
  }
  return new Date(timestamp);
}

export function nextOccurrence(date, frequency, timeZone = "Europe/Moscow", anchorDay) {
  if (!["daily", "weekly", "monthly"].includes(frequency) || !validTimeZone(timeZone) || !Number.isFinite(new Date(date).getTime())) {
    throw new Error("Некорректное расписание задачи");
  }
  const parts = calendarParts(new Date(date), timeZone);
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
