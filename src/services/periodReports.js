import { dateKey } from "./taskSchedule.js";
const DAY = 86400000;
export function parsePeriod(query, now = new Date()) {
  const today = dateKey(now, "Europe/Moscow");
  const from = query.from ?? today.slice(0, 7) + "-01";
  const to = query.to ?? today;
  const parse = (value) => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw Object.assign(new Error("Укажите даты в формате ГГГГ-ММ-ДД"), { statusCode: 400 });
    const date = new Date(value + "T00:00:00+03:00");
    if (!Number.isFinite(date.getTime()) || dateKey(date, "Europe/Moscow") !== value) throw Object.assign(new Error("Некорректная дата"), { statusCode: 400 });
    return date;
  };
  const start = parse(from), end = new Date(parse(to).getTime() + DAY);
  const days = (end - start) / DAY;
  if (days < 1 || days > 92) throw Object.assign(new Error("Выберите период от 1 до 92 дней"), { statusCode: 400 });
  return { from, to, start, end, previousStart: new Date(start.getTime() - days * DAY), days, timeZone: "Europe/Moscow" };
}
const id = (value) => String(value?._id || value || "");
const name = (user) => [user?.name, user?.lastName].filter(Boolean).join(" ") || user?.email || "Без ответственного";
const within = (date, start, end) => date && new Date(date) >= start && new Date(date) < end;
export function closedAt(task) {
  const entries = (task.activities || []).filter((event) => event.action === "status_changed" && event.to === "closed" && event.createdAt);
  return entries.length ? new Date(entries.reduce((latest, event) => new Date(event.createdAt) > new Date(latest.createdAt) ? event : latest).createdAt) : null;
}
export function buildPeriodReport(tasks, projects, period, now = new Date()) {
  const groups = { projects: new Map(), assignees: new Map(), categories: new Map(), daily: new Map() };
  const projectMap = new Map(projects.map((project) => [id(project), project]));
  const empty = (key, label) => ({ key, name: label, created: 0, closed: 0, previousCreated: 0, previousClosed: 0, active: 0, overdue: 0, review: 0, cycleDays: 0 });
  for (let offset = 0; offset < period.days; offset += 1) {
    const day = dateKey(new Date(period.start.getTime() + offset * DAY), "Europe/Moscow");
    groups.daily.set(day, empty(day, day));
  }
  const summary = empty("total", "Всего");
  let unknownClosureDates = 0;
  const rows = [];
  for (const task of tasks) {
    const project = projectMap.get(id(task.project));
    const closure = closedAt(task);
    if (task.status === "closed" && !closure) unknownClosureDates += 1;
    const created = Number(within(task.createdAt, period.start, period.end));
    const closed = Number(within(closure, period.start, period.end));
    const previousCreated = Number(within(task.createdAt, period.previousStart, period.start));
    const previousClosed = Number(within(closure, period.previousStart, period.start));
    const active = Number(!project?.isArchived && !project?.archivedAt && !["closed", "review", "done"].includes(task.status));
    const overdue = Number(Boolean(active && task.dueDate && dateKey(new Date(task.dueDate), "Europe/Moscow") < dateKey(now, "Europe/Moscow")));
    const review = Number(!project?.isArchived && !project?.archivedAt && ["review", "done"].includes(task.status));
    const cycleDays = closed && task.createdAt ? Math.max(0, (closure - new Date(task.createdAt)) / DAY) : 0;
    const measures = { created, closed, previousCreated, previousClosed, active, overdue, review, cycleDays };
    const categories = (task.categories || []).map((key) => ({ key: id(key), name: project?.categories?.find((category) => id(category) === id(key))?.name || "Удалённая категория" }));
    const destinations = [
      ["projects", id(task.project), project?.name || "Проект"],
      ["assignees", id(task.assignee) || task.assigneeEmail || "unassigned", task.assignee ? name(task.assignee) : task.assigneeEmail || "Без ответственного"],
      ...(categories.length ? categories.map((category) => ["categories", id(task.project) + ":" + category.key, (project?.name || "Проект") + " · " + category.name]) : [["categories", "none", "Без категории"]])
    ];
    for (const [group, key, label] of destinations) {
      const row = groups[group].get(key) || empty(key, label);
      for (const field of Object.keys(measures)) row[field] += measures[field];
      groups[group].set(key, row);
    }
    for (const field of Object.keys(measures)) summary[field] += measures[field];
    if (created) groups.daily.get(dateKey(new Date(task.createdAt), "Europe/Moscow")).created += 1;
    if (closed) {
      const day = groups.daily.get(dateKey(closure, "Europe/Moscow"));
      day.closed += 1; day.cycleDays += cycleDays;
    }
    if (previousCreated) groups.daily.get(dateKey(new Date(new Date(task.createdAt).getTime() + period.days * DAY), "Europe/Moscow")).previousCreated += 1;
    if (previousClosed) groups.daily.get(dateKey(new Date(closure.getTime() + period.days * DAY), "Europe/Moscow")).previousClosed += 1;
    if (created || closed) rows.push({ task: task.description, project: project?.name || "", assignee: task.assignee ? name(task.assignee) : task.assigneeEmail || "",
      createdAt: task.createdAt, closedAt: closure, dueDate: task.dueDate || "", status: task.status, priority: task.priority,
      categories: categories.map((category) => category.name).join(", ") });
  }
  const finish = (row) => ({ ...row, closedDelta: row.closed - row.previousClosed, averageCloseDays: row.closed ? Math.round(row.cycleDays / row.closed * 10) / 10 : null });
  return { period, summary: finish(summary), unknownClosureDates, rows,
    ...Object.fromEntries(Object.entries(groups).map(([key, map]) => [key, [...map.values()].map(finish)])) };
}
export function csvCell(value) {
  let text = value == null ? "" : value instanceof Date ? value.toISOString() : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = "'" + text;
  return '"' + text.replaceAll('"', '""') + '"';
}
export function reportCsv(report, group) {
  const taskColumns = { task: "Задача", project: "Проект", assignee: "Ответственный", createdAt: "Создана", closedAt: "Закрыта", dueDate: "Срок", status: "Статус", priority: "Приоритет", categories: "Категории" };
  const columns = group === "tasks" ? taskColumns : { name: "Название", created: "Создано", closed: "Закрыто", previousClosed: "Закрыто в предыдущем периоде", closedDelta: "Изменение", active: "Активно сейчас", overdue: "Просрочено сейчас", review: "На проверке сейчас", averageCloseDays: "Среднее время закрытия, дней" };
  if (!["tasks", "projects", "assignees", "categories", "daily"].includes(group)) throw Object.assign(new Error("Неизвестный вид отчёта"), { statusCode: 400 });
  const rows = group === "tasks" ? report.rows : report[group];
  if (!Array.isArray(rows)) throw Object.assign(new Error("Неизвестный вид отчёта"), { statusCode: 400 });
  const status = { open: "Открыта", in_progress: "В работе", review: "На проверке", done: "На проверке", closed: "Закрыта" };
  const priority = { low: "Низкий", medium: "Обычный", high: "Высокий", urgent: "Срочный" };
  return "\ufeff" + [Object.values(columns), ...rows.map((row) => Object.keys(columns).map((key) =>
    key === "status" ? status[row[key]] || row[key] : key === "priority" ? priority[row[key]] || row[key] : row[key]
  ))].map((row) => row.map(csvCell).join(";")).join("\r\n");
}
