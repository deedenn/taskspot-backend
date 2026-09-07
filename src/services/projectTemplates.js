import mongoose from "mongoose";

export function templateError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function templateName(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 160) {
    throw templateError("Введите название длиной от 1 до 160 символов");
  }
  return value.trim();
}

function text(value, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw templateError("Шаблон содержит пустой или слишком длинный текст");
  }
  return value.trim();
}

export function normalizeBlueprint(input) {
  if (!Array.isArray(input.categories) || input.categories.length > 30 ||
      !Array.isArray(input.tasks) || input.tasks.length > 50) {
    throw templateError("В шаблоне допускается до 30 категорий и до 50 задач");
  }
  const categories = input.categories.map((item) => ({
    key: text(item.key, 100), name: text(item.name, 160),
    color: /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : "#1677ff"
  }));
  const keys = new Set(categories.map((item) => item.key));
  if (keys.size !== categories.length) throw templateError("Категории шаблона должны иметь уникальные ключи");
  const tasks = input.tasks.map((item) => {
    const checklist = item.checklist || [];
    if (!Array.isArray(checklist) || checklist.length > 40) throw templateError("В чек-листе допускается до 40 пунктов");
    if (!Array.isArray(item.categoryKeys) || item.categoryKeys.some((key) => !keys.has(key))) {
      throw templateError("Задача ссылается на отсутствующую категорию");
    }
    if (!["low", "medium", "high", "urgent"].includes(item.priority)) throw templateError("Некорректный приоритет");
    const dueOffsetDays = item.dueOffsetDays;
    if (dueOffsetDays != null && (!Number.isInteger(dueOffsetDays) || dueOffsetDays < 0 || dueOffsetDays > 3650)) {
      throw templateError("Некорректный относительный срок задачи");
    }
    return {
      description: text(item.description, 10000), priority: item.priority,
      categoryKeys: [...new Set(item.categoryKeys)],
      checklist: checklist.map((entry) => ({ text: text(entry.text, 1000) })),
      ...(dueOffsetDays == null ? {} : { dueOffsetDays })
    };
  });
  return { categories, tasks };
}

export function calendarDay(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Moscow", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(value));
}

export function startDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw templateError("Укажите дату начала");
  const date = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw templateError("Некорректная дата начала");
  return date;
}

export function snapshotBlueprint(project, tasks, today = calendarDay()) {
  const known = new Set(project.categories.map((entry) => String(entry._id)));
  return normalizeBlueprint({
    categories: project.categories.map((entry) => ({ key: String(entry._id), name: entry.name, color: entry.color })),
    tasks: tasks.map((entry) => ({
      description: entry.description, priority: entry.priority,
      categoryKeys: entry.categories.map(String).filter((key) => known.has(key)),
      checklist: entry.checklist.map((item) => ({ text: item.text })),
      ...(entry.dueDate ? { dueOffsetDays: Math.max(0, Math.round((startDay(calendarDay(entry.dueDate)) - startDay(today)) / 86400000)) } : {})
    }))
  });
}

export function materializeBlueprint(template, projectId, userId, startDate) {
  const blueprint = normalizeBlueprint(template);
  const mapping = new Map(blueprint.categories.map((entry) => [entry.key, new mongoose.Types.ObjectId()]));
  const categories = blueprint.categories.map((entry) => ({ _id: mapping.get(entry.key), name: entry.name, color: entry.color }));
  const start = startDay(startDate);
  const tasks = blueprint.tasks.map((entry) => ({
    project: projectId, creator: userId, description: entry.description, priority: entry.priority,
    categories: entry.categoryKeys.map((key) => mapping.get(key)),
    checklist: entry.checklist.map((item) => ({ text: item.text, done: false })),
    ...(entry.dueOffsetDays == null ? {} : { dueDate: new Date(start.getTime() + entry.dueOffsetDays * 86400000 + 15 * 3600000) }),
    status: "open", observers: [], attachments: [], comments: [],
    activities: [{ actor: userId, action: "created", details: "Создана из шаблона проекта" }]
  }));
  return { categories, tasks };
}

function builtin(id, name, description, categoryName, rows) {
  return {
    _id: id, builtin: true, name, description,
    categories: [{ key: "work", name: categoryName, color: "#1677ff" }],
    tasks: rows.map(([description, dueOffsetDays, checklist]) => ({
      description, dueOffsetDays, priority: "medium", categoryKeys: ["work"],
      checklist: checklist.map((text) => ({ text }))
    }))
  };
}

export const BUILTIN_PROJECT_TEMPLATES = [
  builtin("weekly-manager", "Неделя руководителя", "Планирование, проверка поручений и итоги недели.", "Управление", [
    ["Согласовать приоритеты недели", 0, ["Собрать открытые вопросы", "Выбрать три главных результата"]],
    ["Проверить просроченные поручения", 2, ["Уточнить причины задержек", "Согласовать новые сроки"]],
    ["Подвести итоги недели", 4, ["Проверить результаты", "Записать решения на следующую неделю"]]
  ]),
  builtin("client-launch", "Запуск клиентского проекта", "От первого обсуждения до передачи результата.", "Клиент", [
    ["Согласовать задачу с клиентом", 0, ["Зафиксировать требования", "Согласовать критерии приёмки"]],
    ["Подготовить результат", 3, ["Проверить требования", "Подготовить материалы для передачи"]],
    ["Передать результат клиенту", 5, ["Получить обратную связь", "Зафиксировать итог"]]
  ]),
  builtin("retail-shift", "Рабочая смена магазина", "Открытие, контроль в течение дня и закрытие смены.", "Смена", [
    ["Открыть смену", 0, ["Проверить рабочие места", "Проверить наличие товара"]],
    ["Проверить зал и остатки", 0, ["Пополнить витрины", "Записать недостающие позиции"]],
    ["Закрыть смену", 0, ["Сверить результаты", "Передать вопросы следующей смене"]]
  ])
];
