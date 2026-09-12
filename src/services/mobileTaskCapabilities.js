import { idOf, isProjectAdmin } from "./taskAccess.js";

export function mobileTaskCapabilities(task, project, userId) {
  const archived = Boolean(project?.isArchived || project?.archivedAt);
  const creator = idOf(task?.creator) === idOf(userId);
  const assignee = idOf(task?.assignee) === idOf(userId);
  const admin = isProjectAdmin(project, userId);
  const statusTransitions = [];

  if (!archived && assignee && task.status === "open") {
    statusTransitions.push({ status: "in_progress" }, { status: "review" });
  } else if (!archived && assignee && task.status === "in_progress") {
    statusTransitions.push({ status: "review" });
  }
  if (!archived && creator && ["review", "done"].includes(task.status)) {
    statusTransitions.push({ status: "closed" }, { status: "in_progress", requiresComment: true });
  }

  return {
    statusTransitions,
    canEditChecklist: !archived && (admin || creator || assignee),
    canComment: !archived,
    canEditFields: !archived && (admin || creator),
    ...(archived ? { readOnlyReason: "Архивный проект доступен только для просмотра" } : {})
  };
}

export function assertMobileStatusTransition(task, project, userId, next, comment) {
  const capabilities = mobileTaskCapabilities(task, project, userId);
  const transition = capabilities.statusTransitions.find((item) => item.status === next);
  if (!transition) return { allowed: false, message: "Status transition is not allowed" };
  if (transition.requiresComment && !String(comment || "").trim()) {
    return { allowed: false, message: "Для возврата задачи нужен комментарий инициатора" };
  }
  return { allowed: true, capabilities };
}
