import { idOf, isProjectAdmin } from "./taskAccess.js";

export function mobileTaskCapabilities(task, project, userId) {
  const archived = Boolean(project?.isArchived || project?.archivedAt);
  const creator = idOf(task?.creator) === idOf(userId);
  const assignee = idOf(task?.assignee) === idOf(userId);
  const admin = isProjectAdmin(project, userId);
  const statusTransitions = [];

  if (!archived && task.status !== "cancelled" && (admin || creator) && task.status === "open") {
    statusTransitions.push({ status: "in_progress" }, { status: "review" });
  } else if (!archived && task.status !== "cancelled" && (admin || creator) && task.status === "in_progress") {
    statusTransitions.push({ status: "open" }, { status: "review" });
  } else if (!archived && assignee && task.status === "open") {
    statusTransitions.push({ status: "in_progress" }, { status: "review" });
  } else if (!archived && assignee && task.status === "in_progress") {
    statusTransitions.push({ status: "review" });
  }
  if (!archived && (admin || creator) && ["review", "done"].includes(task.status)) {
    statusTransitions.push({ status: "closed" }, { status: "in_progress", requiresComment: true });
  }
  if (!archived && admin && task.status !== "cancelled") {
    statusTransitions.push({ status: "cancelled", requiresConfirmation: true });
  }

  return {
    statusTransitions,
    canEditChecklist: !archived && (admin || creator || assignee),
    canComment: !archived,
    canEditFields: !archived && (admin || creator),
    canAttach: !archived && (admin || creator || assignee),
    ...(archived ? { readOnlyReason: "Архивный проект доступен только для просмотра" } : {})
  };
}

export function assertMobileStatusTransition(task, project, userId, next, comment, confirmed = false) {
  const capabilities = mobileTaskCapabilities(task, project, userId);
  const transition = capabilities.statusTransitions.find((item) => item.status === next);
  if (!transition) return { allowed: false, message: "Status transition is not allowed" };
  if (transition.requiresComment && !String(comment || "").trim()) {
    return { allowed: false, message: "Для возврата задачи нужен комментарий инициатора" };
  }
  if (transition.requiresConfirmation && confirmed !== true) {
    return { allowed: false, message: "Подтвердите отмену задачи" };
  }
  return { allowed: true, capabilities };
}
