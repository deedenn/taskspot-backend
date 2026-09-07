import assert from "node:assert/strict";
import { test } from "node:test";
import mongoose from "mongoose";
import { BUILTIN_PROJECT_TEMPLATES, normalizeBlueprint, snapshotBlueprint, materializeBlueprint, startDay, calendarDay } from "../src/services/projectTemplates.js";

test("blueprints validate categories, limits and dates", () => {
  for (const template of BUILTIN_PROJECT_TEMPLATES) assert.equal(normalizeBlueprint(template).tasks.length, 3);
  assert.throws(() => normalizeBlueprint({ categories: [], tasks: Array(51).fill({}) }));
  assert.throws(() => normalizeBlueprint({ ...BUILTIN_PROJECT_TEMPLATES[0], categories: [] }));
  assert.throws(() => startDay("2026-02-30"));
  assert.throws(() => startDay({}));
  assert.equal(calendarDay("2026-09-07T22:00:00Z"), "2026-09-08");
});

test("snapshot copies only structure and materialization resets state and identities", () => {
  const category = new mongoose.Types.ObjectId();
  const snapshot = snapshotBlueprint({ categories: [{ _id: category, name: "Work", color: "#123456" }] }, [{
    description: "Do it", priority: "high", categories: [category], checklist: [{ text: "Step", done: true }],
    attachments: [{ key: "secret" }], comments: [{ text: "private" }], assignee: new mongoose.Types.ObjectId(),
    dueDate: new Date("2026-09-10T15:00:00Z")
  }], "2026-09-07");
  assert.equal(snapshot.tasks[0].dueOffsetDays, 3);
  assert.equal(snapshot.tasks[0].assignee, undefined);
  assert.equal(snapshot.tasks[0].attachments, undefined);
  const project = new mongoose.Types.ObjectId(), user = new mongoose.Types.ObjectId();
  const first = materializeBlueprint(snapshot, project, user, "2026-10-01");
  const second = materializeBlueprint(snapshot, project, user, "2026-10-01");
  assert.notEqual(String(first.categories[0]._id), String(category));
  assert.notEqual(String(first.categories[0]._id), String(second.categories[0]._id));
  assert.equal(String(first.tasks[0].categories[0]), String(first.categories[0]._id));
  assert.equal(first.tasks[0].status, "open");
  assert.equal(first.tasks[0].checklist[0].done, false);
  assert.equal(first.tasks[0].dueDate.toISOString(), "2026-10-04T15:00:00.000Z");
});
