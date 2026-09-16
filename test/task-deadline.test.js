import assert from "node:assert/strict";
import { test } from "node:test";
import {
  effectiveTaskDeadline,
  isTaskPastDeadline,
  overdueTaskFilter,
  parseTaskDeadline
} from "../src/services/taskDeadline.js";

test("date-only task deadlines last until the end of the Moscow calendar day", () => {
  const task = { dueDate: new Date("2026-09-16T00:00:00.000Z"), dueDateHasTime: false };
  assert.equal(effectiveTaskDeadline(task).toISOString(), "2026-09-16T20:59:59.999Z");
  assert.equal(isTaskPastDeadline(task, new Date("2026-09-16T20:00:00.000Z")), false);
  assert.equal(isTaskPastDeadline(task, new Date("2026-09-16T21:00:00.000Z")), true);
});

test("explicit task time is an exact deadline", () => {
  const task = { dueDate: new Date("2026-09-16T10:30:00.000Z"), dueDateHasTime: true };
  assert.equal(effectiveTaskDeadline(task).toISOString(), "2026-09-16T10:30:00.000Z");
  assert.equal(isTaskPastDeadline(task, new Date("2026-09-16T10:29:59.000Z")), false);
  assert.equal(isTaskPastDeadline(task, new Date("2026-09-16T10:30:01.000Z")), true);
});

test("deadline input validates dates and query distinguishes timed legacy tasks", () => {
  assert.deepEqual(parseTaskDeadline(null, true), { dueDate: undefined, dueDateHasTime: false });
  assert.equal(parseTaskDeadline("2026-09-16T10:30:00.000Z", true).dueDateHasTime, true);
  assert.throws(() => parseTaskDeadline("not-a-date"), /Due date is invalid/);

  const now = new Date("2026-09-16T12:00:00.000Z");
  const filter = overdueTaskFilter(now);
  assert.deepEqual(filter.$or[0], { dueDateHasTime: true, dueDate: { $lt: now } });
  assert.equal(filter.$or[1].dueDateHasTime.$ne, true);
  assert.equal(filter.$or[1].dueDate.$lt.toISOString(), "2026-09-15T21:00:00.000Z");
});
