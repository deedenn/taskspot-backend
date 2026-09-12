import { dateKey } from "./taskSchedule.js";

const DAY = 24 * 60 * 60 * 1000;
const PERIOD_DAYS = { week: 7, month: 30 };
const FACTOR_WEIGHTS = {
  timeliness: 40,
  delivery: 25,
  checklist: 20,
  quality: 15
};

function idOf(value) {
  return String(value?._id || value || "");
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function percent(part, total) {
  return total ? round((part / total) * 100) : null;
}

function within(value, start, end) {
  if (!value) return false;
  const date = new Date(value);
  return date >= start && date < end;
}

function sortedActivities(task) {
  return [...(task.activities || [])]
    .filter((event) => event.createdAt)
    .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt));
}

function historicalValue(task, { action, current, at }) {
  let value = current;
  const activities = sortedActivities(task).filter(
    (event) => event.action === action && new Date(event.createdAt) >= at
  );

  for (let index = activities.length - 1; index >= 0; index -= 1) {
    value = activities[index].from || "";
  }

  return value;
}

function assigneeAt(task, at) {
  return historicalValue(task, {
    action: "assignee_changed",
    current: idOf(task.assignee) || task.assigneeEmail || "",
    at
  });
}

function dueDateAt(task, at) {
  const value = historicalValue(task, {
    action: "due_date_changed",
    current: task.dueDate || "",
    at
  });
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function committedDueDate(task, period) {
  const current = dueDateAt(task, period.end);
  const missedBeforeReplanning = sortedActivities(task)
    .filter((event) => event.action === "due_date_changed" && within(event.createdAt, period.start, period.end))
    .map((event) => ({ dueDate: event.from ? new Date(event.from) : null, changedAt: new Date(event.createdAt) }))
    .filter(({ dueDate, changedAt }) =>
      dueDate && Number.isFinite(dueDate.getTime()) && within(dueDate, period.start, period.end) &&
      changedAt >= new Date(dueDate.getTime() + DAY)
    )
    .map(({ dueDate }) => dueDate);
  const candidates = [current, ...missedBeforeReplanning].filter(Boolean);
  return candidates.length
    ? candidates.reduce((earliest, candidate) => candidate < earliest ? candidate : earliest)
    : null;
}

function deliveryEvents(task, actorId) {
  const actor = idOf(actorId);
  const reviewEvents = sortedActivities(task).filter(
    (event) =>
      event.action === "status_changed" &&
      ["review", "done"].includes(event.to) &&
      (!actor || idOf(event.actor) === actor)
  );

  if (reviewEvents.length || actor) return reviewEvents;

  return sortedActivities(task).filter(
    (event) => event.action === "status_changed" && event.to === "closed"
  );
}

function firstDeliveryBefore(task, end, actorId) {
  return deliveryEvents(task, actorId).find((event) => new Date(event.createdAt) < end) || null;
}

function scoreBand(score) {
  if (score == null) return { key: "no_data", label: "Нужны данные" };
  if (score >= 90) return { key: "master", label: "Мастер потока" };
  if (score >= 75) return { key: "strong", label: "Высокий темп" };
  if (score >= 60) return { key: "steady", label: "Уверенный ритм" };
  if (score >= 40) return { key: "growing", label: "Набирает темп" };
  return { key: "start", label: "Точка роста" };
}

function confidence(sampleSize) {
  if (!sampleSize) return { key: "none", label: "Нет выборки" };
  if (sampleSize < 3) return { key: "low", label: "Предварительно" };
  if (sampleSize < 8) return { key: "medium", label: "Средняя точность" };
  return { key: "high", label: "Высокая точность" };
}

function factor(key, value, evidence) {
  return { key, value, weight: FACTOR_WEIGHTS[key], evidence };
}

function nextActionFor(factors, stats) {
  if (!stats.sampleSize) {
    return {
      factor: "timeliness",
      title: "Создайте измеримый ритм",
      description: "Назначайте задачам реалистичные сроки и переводите готовые задачи на проверку — после первых событий появится объективный индекс."
    };
  }

  if (!stats.commitments) {
    return {
      factor: "timeliness",
      title: "Добавьте реалистичные сроки",
      description: "Без задач со сроком индекс не может оценить своевременность и доведение обязательств до результата."
    };
  }

  const available = factors.filter((item) => item.value != null).sort((a, b) => a.value - b.value);
  const weakest = available[0]?.key;
  const actions = {
    timeliness: {
      title: "Сфокусируйтесь на ближайших сроках",
      description: "Начните с задач, срок которых наступает первым, и отправляйте результат на проверку до конца дня срока."
    },
    delivery: {
      title: "Сократите незавершённую работу",
      description: "Выберите одну задачу со сроком и доведите её до проверки прежде, чем брать следующую."
    },
    checklist: {
      title: "Используйте чек-лист как маршрут",
      description: "Отмечайте выполненные пункты по ходу работы и завершайте чек-лист перед отправкой задачи на проверку."
    },
    quality: {
      title: "Добавьте финальную самопроверку",
      description: "Перед сдачей сверьте результат с описанием и чек-листом — это снижает число возвратов на доработку."
    }
  };

  return { factor: weakest || "delivery", ...(actions[weakest] || actions.delivery) };
}

function calculateScope(tasks, period, { actorId = "", projectIds = null } = {}) {
  const actor = idOf(actorId);
  const projectSet = projectIds ? new Set(projectIds.map(idOf)) : null;
  const scopedTasks = tasks.filter((task) => {
    if (task.createdAt && new Date(task.createdAt) >= period.end) return false;
    if (projectSet) return projectSet.has(idOf(task.project));
    return true;
  });

  const commitments = scopedTasks
    .map((task) => ({ task, dueDate: committedDueDate(task, period) }))
    .filter(({ task, dueDate }) =>
      within(dueDate, period.start, period.end) &&
      (!actor || assigneeAt(task, new Date(dueDate.getTime() + DAY)) === actor)
    );

  const deliveredCommitments = commitments.filter(({ task }) =>
    firstDeliveryBefore(task, period.end, actor)
  );
  const onTime = commitments.filter(({ task, dueDate }) => {
    const delivery = firstDeliveryBefore(task, period.end, actor);
    return delivery && new Date(delivery.createdAt) < new Date(dueDate.getTime() + DAY);
  });

  const submissions = scopedTasks.flatMap((task) =>
    deliveryEvents(task, actor)
      .filter((event) => within(event.createdAt, period.start, period.end))
      .map((event) => ({ task, event }))
  );
  const submittedTaskEntries = [...new Map(submissions.map(({ task, event }) => [idOf(task._id), { task, event }])).values()];
  const submittedTasks = submittedTaskEntries.map(({ task }) => task);
  const returns = scopedTasks.flatMap((task) => {
    const activities = sortedActivities(task);
    return activities.filter((event, index) => {
      if (
        event.action !== "status_changed" ||
        !["review", "done"].includes(event.from) ||
        event.to !== "in_progress" ||
        !within(event.createdAt, period.start, period.end)
      ) return false;
      if (!actor) return true;
      const previousDelivery = activities.slice(0, index).reverse().find(
        (candidate) => candidate.action === "status_changed" && ["review", "done"].includes(candidate.to)
      );
      return idOf(previousDelivery?.actor) === actor;
    });
  });

  const checklistTasks = submittedTaskEntries
    .map(({ task, event }) => ({
      task,
      items: (task.checklist || []).filter((item) => !item.createdAt || new Date(item.createdAt) <= new Date(event.createdAt)),
      deliveredAt: new Date(event.createdAt)
    }))
    .filter(({ items }) => items.length);
  const checklistItems = checklistTasks.reduce((sum, entry) => sum + entry.items.length, 0);
  const checklistCompleted = checklistTasks.reduce(
    (sum, entry) => sum + entry.items.filter((item) => item.done && (!item.updatedAt || new Date(item.updatedAt) <= entry.deliveredAt)).length,
    0
  );
  const checklistActions = scopedTasks.reduce(
    (sum, task) =>
      sum +
      sortedActivities(task).filter(
        (event) =>
          event.action === "checklist_changed" &&
          (!actor || (idOf(event.actor) === actor && assigneeAt(task, new Date(new Date(event.createdAt).getTime() + 1)) === actor)) &&
          within(event.createdAt, period.start, period.end)
      ).length,
    0
  );
  const checklistCompletion = percent(checklistCompleted, checklistItems);
  const checklistActivity = checklistTasks.length
    ? Math.min(100, round((checklistActions / checklistTasks.length) * 50))
    : null;
  const checklistScore = checklistCompletion == null
    ? null
    : round(checklistCompletion * 0.85 + (checklistActivity || 0) * 0.15);

  const factors = [
    factor("timeliness", percent(onTime.length, commitments.length), {
      positive: onTime.length,
      total: commitments.length
    }),
    factor("delivery", percent(deliveredCommitments.length, commitments.length), {
      positive: deliveredCommitments.length,
      total: commitments.length
    }),
    factor("checklist", checklistScore, {
      positive: checklistCompleted,
      total: checklistItems,
      actions: checklistActions
    }),
    factor("quality", submissions.length ? Math.max(0, round(100 - (returns.length / submissions.length) * 100)) : null, {
      positive: Math.max(0, submissions.length - returns.length),
      total: submissions.length,
      returns: returns.length
    })
  ];

  const available = factors.filter((item) => item.value != null);
  const availableWeight = available.reduce((sum, item) => sum + item.weight, 0);
  const score = availableWeight
    ? round(available.reduce((sum, item) => sum + item.value * item.weight, 0) / availableWeight)
    : null;
  const sampleTaskIds = new Set([
    ...commitments.map(({ task }) => idOf(task._id)),
    ...submittedTasks.map((task) => idOf(task._id))
  ]);
  const stats = {
    sampleSize: sampleTaskIds.size,
    commitments: commitments.length,
    deliveredCommitments: deliveredCommitments.length,
    onTime: onTime.length,
    submissions: submissions.length,
    returns: returns.length,
    checklistItems,
    checklistCompleted,
    checklistActions
  };

  return {
    score,
    band: scoreBand(score),
    confidence: confidence(stats.sampleSize),
    factors,
    stats,
    nextAction: nextActionFor(factors, stats),
    xp: onTime.length * 20 + submissions.length * 10 + Math.min(checklistCompleted, 25) * 2 +
      (submissions.length >= 3 && returns.length === 0 ? 20 : 0)
  };
}

function buildRhythm(tasks, period, options) {
  const bucketDays = period.key === "month" ? 6 : 1;
  const count = Math.ceil(period.days / bucketDays);
  const actor = idOf(options.actorId);
  const scoped = tasks.filter((task) => !task.createdAt || new Date(task.createdAt) < period.end);

  return Array.from({ length: count }, (_, index) => {
    const start = new Date(period.start.getTime() + index * bucketDays * DAY);
    const end = new Date(Math.min(period.end.getTime(), start.getTime() + bucketDays * DAY));
    const commitments = scoped
      .map((task) => ({ task, dueDate: committedDueDate(task, period) }))
      .filter(({ task, dueDate }) =>
        within(dueDate, start, end) && assigneeAt(task, new Date(dueDate.getTime() + DAY)) === actor
      );
    const onTime = commitments.filter(({ task, dueDate }) => {
      const delivery = firstDeliveryBefore(task, period.end, actor);
      return delivery && new Date(delivery.createdAt) < new Date(dueDate.getTime() + DAY);
    }).length;
    const submissions = scoped.reduce(
      (sum, task) => sum + deliveryEvents(task, actor).filter((event) => within(event.createdAt, start, end)).length,
      0
    );
    const checklistActions = scoped.reduce(
      (sum, task) => sum + sortedActivities(task).filter(
        (event) => event.action === "checklist_changed" && idOf(event.actor) === actor &&
          assigneeAt(task, new Date(new Date(event.createdAt).getTime() + 1)) === actor && within(event.createdAt, start, end)
      ).length,
      0
    );

    return {
      key: `${dateKey(start, "Europe/Moscow")}:${dateKey(new Date(end.getTime() - 1), "Europe/Moscow")}`,
      from: start,
      to: end,
      commitments: commitments.length,
      onTime,
      submissions,
      checklistActions,
      activity: submissions + checklistActions
    };
  });
}

function achievement({ key, title, description, current, target, progress, progressLabel, unlocked }) {
  return {
    key,
    title,
    description,
    current,
    target,
    progress: progress == null ? Math.min(100, round((current / target) * 100)) : Math.min(100, round(progress)),
    progressLabel: progressLabel || `${current} из ${target}`,
    unlocked
  };
}

function buildAchievements(personal, team) {
  const timeliness = personal.factors.find((item) => item.key === "timeliness")?.value || 0;
  const checklist = personal.factors.find((item) => item.key === "checklist")?.value || 0;
  return [
    achievement({
      key: "deadline",
      title: "Хранитель сроков",
      description: "Не менее 3 обязательств и 85% выполнено вовремя",
      current: Math.min(personal.stats.commitments, 3),
      target: 3,
      progress: Math.min((personal.stats.commitments / 3) * 100, (timeliness / 85) * 100),
      progressLabel: `${Math.min(personal.stats.commitments, 3)} из 3 · ${Math.round(timeliness)}% вовремя`,
      unlocked: personal.stats.commitments >= 3 && timeliness >= 85
    }),
    achievement({
      key: "checklist",
      title: "Мастер чек-листов",
      description: "Завершить 5 пунктов с дисциплиной не ниже 90%",
      current: Math.min(personal.stats.checklistCompleted, 5),
      target: 5,
      progress: Math.min((personal.stats.checklistCompleted / 5) * 100, (checklist / 90) * 100),
      progressLabel: `${Math.min(personal.stats.checklistCompleted, 5)} из 5 · индекс ${Math.round(checklist)}%`,
      unlocked: personal.stats.checklistCompleted >= 5 && checklist >= 90
    }),
    achievement({
      key: "quality",
      title: "С первого раза",
      description: "Сдать 3 задачи без возврата на доработку",
      current: Math.min(personal.stats.submissions, 3),
      target: 3,
      progress: personal.stats.returns ? Math.min(75, (personal.stats.submissions / 3) * 100) : (personal.stats.submissions / 3) * 100,
      progressLabel: `${Math.min(personal.stats.submissions, 3)} из 3 · возвратов ${personal.stats.returns}`,
      unlocked: personal.stats.submissions >= 3 && personal.stats.returns === 0
    }),
    achievement({
      key: "captain",
      title: "Командный капитан",
      description: "Командный индекс от 80% на выборке из 5 задач",
      current: Math.min(team.stats.sampleSize, 5),
      target: 5,
      progress: Math.min((team.stats.sampleSize / 5) * 100, ((team.score || 0) / 80) * 100),
      progressLabel: `${Math.min(team.stats.sampleSize, 5)} из 5 · индекс ${Math.round(team.score || 0)}%`,
      unlocked: team.stats.sampleSize >= 5 && team.score >= 80
    })
  ];
}

export function efficiencyPeriod(key = "week", now = new Date()) {
  if (!PERIOD_DAYS[key]) {
    throw Object.assign(new Error("Неизвестный период эффективности"), { statusCode: 400 });
  }
  const days = PERIOD_DAYS[key];
  const end = new Date(now);
  const start = new Date(end.getTime() - days * DAY);
  return {
    key,
    days,
    start,
    end,
    previousStart: new Date(start.getTime() - days * DAY)
  };
}

export function buildEfficiency({ tasks, ownedProjects = [], userId, periodKey = "week", now = new Date() }) {
  const period = efficiencyPeriod(periodKey, now);
  const previousPeriod = {
    key: period.key,
    days: period.days,
    start: period.previousStart,
    end: period.start
  };
  const ownedProjectIds = ownedProjects.map((project) => idOf(project._id));
  const personal = calculateScope(tasks, period, { actorId: userId });
  const previousPersonal = calculateScope(tasks, previousPeriod, { actorId: userId });
  const team = calculateScope(tasks, period, { projectIds: ownedProjectIds });
  const previousTeam = calculateScope(tasks, previousPeriod, { projectIds: ownedProjectIds });

  const withComparison = (current, previous) => ({
    ...current,
    previousScore: previous.score,
    delta: current.score == null || previous.score == null ? null : round(current.score - previous.score),
    previousFactors: previous.factors
  });

  return {
    period: {
      key: period.key,
      days: period.days,
      start: period.start,
      end: period.end,
      previousStart: period.previousStart
    },
    personal: withComparison(personal, previousPersonal),
    team: {
      ...withComparison(team, previousTeam),
      projects: ownedProjects.length
    },
    rhythm: buildRhythm(tasks, period, { actorId: userId }),
    achievements: buildAchievements(personal, team),
    methodology: {
      weights: FACTOR_WEIGHTS,
      comparison: "equal_previous_period",
      checklistHistory: "delivery_snapshot_when_metadata_available",
      overdueReplanning: "expired_commitment_is_preserved"
    }
  };
}
