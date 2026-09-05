function invalidQuery() {
  throw Object.assign(new Error("Некорректные параметры списка задач"), { statusCode: 400 });
}

export function parseTaskListQuery(query) {
  const keys = ["projectId", "page", "limit", "search", "hideClosed", "status", "category", "assignee", "sort", "order"];
  for (const key of keys) {
    if (query[key] !== undefined && typeof query[key] !== "string") invalidQuery();
  }
  const positiveInteger = (value, fallback) => {
    if (value === undefined) return fallback;
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) invalidQuery();
    return Number(value);
  };
  const page = positiveInteger(query.page, 1);
  const limit = Math.min(positiveInteger(query.limit, 25), 100);
  const sort = query.sort ?? "updatedAt";
  const order = query.order ?? "desc";
  if (!["updatedAt", "createdAt", "description", "dueDate", "status"].includes(sort)) invalidQuery();
  if (!["asc", "desc"].includes(order)) invalidQuery();
  if (query.hideClosed !== undefined && !["true", "false"].includes(query.hideClosed)) invalidQuery();
  if ((query.search || "").length > 200) invalidQuery();
  const direction = order === "asc" ? 1 : -1;
  return { page, limit, sort: { [sort]: direction, _id: direction } };
}
