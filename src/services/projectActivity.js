const id = (value) => String(value?._id || value || "");
const text = (value) => String(value || "").slice(0, 500);
const roles = { admin: "Администратор", member: "Участник" };

export const ACTIVITY_FIELDS = ["name", "description", "avatar", "isArchived", "members", "invitations", "categories", "templates"];

// Whitelisted business fields only: tokens and email payloads must never enter the journal.
export function projectChanges(before, after, fields = ACTIVITY_FIELDS) {
  if (!before) return [{ action: "project_created", target: text(after.name) }];
  const events = [];
  const add = (action, target, previous = "", value = "", targetUser) => events.push({
    action, target: text(target), before: text(previous), after: text(value), ...(targetUser ? { targetUser } : {})
  });
  for (const field of ["name", "description"]) {
    if (fields.includes(field) && String(before[field] || "") !== String(after[field] || "")) {
      add("settings_changed", field === "name" ? "Название проекта" : "Описание проекта", before[field], after[field]);
    }
  }
  if (fields.includes("isArchived") && Boolean(before.isArchived) !== Boolean(after.isArchived)) add(after.isArchived ? "project_archived" : "project_restored", after.name);
  if (fields.includes("avatar") && before.avatar?.key !== after.avatar?.key) add("avatar_changed", after.avatar?.name || "Аватар удалён");
  for (const [field, key, kind] of [["members", "user", "member"], ["invitations", "_id", "invitation"], ["categories", "_id", "category"], ["templates", "_id", "task_template"]]) {
    if (!fields.includes(field)) continue;
    const oldItems = new Map((before[field] || []).map((item) => [id(item[key]), item]));
    const newItems = new Map((after[field] || []).map((item) => [id(item[key]), item]));
    const label = (item) => item.email || item.name || item.title || id(item.user);
    for (const [itemId, item] of newItems) {
      const old = oldItems.get(itemId);
      if (!old) { add(kind + "_added", label(item), "", roles[item.role] || item.color, field === "members" ? id(item.user) : undefined); continue; }
      if (item.role !== old.role) add("role_changed", label(item), roles[old.role], roles[item.role], field === "members" ? id(item.user) : undefined);
      if (field === "invitations") {
        if (item.status !== old.status && item.status === "accepted") add("invitation_accepted", label(item));
        else if (item.token !== old.token) add("invitation_resent", label(item));
      }
      if (field === "categories" && (item.name !== old.name || item.color !== old.color)) add("category_changed", item.name, old.name + " " + old.color, item.name + " " + item.color);
    }
    for (const [itemId, item] of oldItems) if (!newItems.has(itemId)) add(kind + "_removed", label(item), "", "", field === "members" ? id(item.user) : undefined);
  }
  return events;
}

export function activityActor(user) {
  return { user: user?._id, name: text([user?.name, user?.lastName].filter(Boolean).join(" ") || user?.email || "Система") };
}
