import assert from "node:assert/strict";
import { test } from "node:test";
import { parseTaskListQuery } from "../src/services/taskListQuery.js";
import { taskSearchFilter } from "../src/services/taskSearch.js";
import { User } from "../src/models/User.js";

test("task pages are bounded and sorting has a stable tie breaker", () => {
  assert.deepEqual(parseTaskListQuery({}), { page: 1, limit: 25, sort: { updatedAt: -1, _id: -1 } });
  assert.deepEqual(parseTaskListQuery({ page: "2", limit: "1000", sort: "dueDate", order: "asc" }),
    { page: 2, limit: 100, sort: { dueDate: 1, _id: 1 } });
});

test("invalid pagination and structured query injection return a validation error", () => {
  for (const query of [
    { page: "NaN" }, { page: "Infinity" }, { page: "-1" }, { page: "1.5" }, { page: "9007199254740992" },
    { limit: "0" }, { limit: "-1" }, { limit: "2.5" }, { sort: "$where" }, { order: "sideways" },
    { hideClosed: "yes" }, { search: "a".repeat(201) }, { search: { $ne: "" } },
    { page: ["1", "2"] }, { category: { $ne: "" } }, { projectId: ["a", "b"] }
  ]) assert.throws(() => parseTaskListQuery(query), { statusCode: 400 }, JSON.stringify(query));
});

test("review includes legacy completed tasks; hiding closed never exposes closed tasks", async () => {
  const project = { categories: [{ _id: "category" }] };
  assert.deepEqual(await taskSearchFilter(project, { status: "review" }), { status: { $in: ["review", "done"] } });
  const closed = await taskSearchFilter(project, { status: "closed", hideClosed: "true" });
  assert.deepEqual(closed._id, { $in: [] });
  await assert.rejects(taskSearchFilter(project, { category: "foreign" }), { statusCode: 400 });
});

test("search treats regex symbols literally and restricts people to project membership", async (t) => {
  const memberId = "6a000000000000000000000001";
  const project = { categories: [{ _id: "cat", name: "[invoice]" }], members: [{ user: memberId }] };
  let userFilter;
  t.mock.method(User, "find", (filter) => {
    userFilter = filter;
    return { distinct: async () => [memberId] };
  });
  const filter = await taskSearchFilter(project, { search: "[invoice]" });
  assert.deepEqual(userFilter._id.$in, [memberId]);
  const expression = filter.$or[0].description;
  assert.equal(expression.test("upload [invoice] file"), true);
  assert.equal(expression.test("invoice"), false);
  assert.deepEqual(filter.$or.at(-1).categories.$in, ["cat"]);
});
