import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEfficiency, efficiencyPeriod } from "../src/services/efficiency.js";

const userId = "user-1";

function status(actor, from, to, createdAt) {
  return { action: "status_changed", actor, from, to, createdAt };
}

test("efficiency combines deadlines, delivery, checklists and review quality", () => {
  const result = buildEfficiency({
    userId,
    periodKey: "week",
    now: new Date("2026-09-12T12:00:00.000Z"),
    ownedProjects: [{ _id: "project-1" }],
    tasks: [
      {
        _id: "task-1",
        project: "project-1",
        assignee: userId,
        createdAt: "2026-09-01T00:00:00.000Z",
        dueDate: "2026-09-10T00:00:00.000Z",
        checklist: [{ done: true }, { done: true }],
        activities: [
          { action: "checklist_changed", actor: userId, createdAt: "2026-09-09T09:00:00.000Z" },
          { action: "checklist_changed", actor: userId, createdAt: "2026-09-10T09:00:00.000Z" },
          status(userId, "in_progress", "review", "2026-09-10T10:00:00.000Z")
        ]
      },
      {
        _id: "task-2",
        project: "project-1",
        assignee: userId,
        createdAt: "2026-09-01T00:00:00.000Z",
        dueDate: "2026-09-11T00:00:00.000Z",
        checklist: [],
        activities: []
      },
      {
        _id: "task-previous",
        project: "project-1",
        assignee: userId,
        createdAt: "2026-08-20T00:00:00.000Z",
        dueDate: "2026-09-03T00:00:00.000Z",
        checklist: [],
        activities: [status(userId, "in_progress", "review", "2026-09-04T10:00:00.000Z")]
      },
      {
        _id: "team-task",
        project: "project-1",
        assignee: "user-2",
        createdAt: "2026-09-01T00:00:00.000Z",
        dueDate: "2026-09-09T00:00:00.000Z",
        checklist: [],
        activities: [status("user-2", "in_progress", "review", "2026-09-09T10:00:00.000Z")]
      }
    ]
  });

  assert.equal(result.period.days, 7);
  assert.equal(result.personal.score, 67.5);
  assert.equal(result.personal.previousScore, 50);
  assert.equal(result.personal.delta, 17.5);
  assert.deepEqual(
    result.personal.factors.map(({ key, value }) => [key, value]),
    [["timeliness", 50], ["delivery", 50], ["checklist", 100], ["quality", 100]]
  );
  assert.equal(result.personal.stats.checklistActions, 2);
  assert.equal(result.team.projects, 1);
  assert.equal(result.team.stats.commitments, 3);
  assert.equal(result.rhythm.length, 7);
  assert.equal(result.personal.xp, 34);
});

test("efficiency restores an assignee and due date as of the compared period", () => {
  const result = buildEfficiency({
    userId,
    periodKey: "week",
    now: new Date("2026-09-12T12:00:00.000Z"),
    tasks: [{
      _id: "historical-task",
      project: "project-2",
      assignee: "user-2",
      createdAt: "2026-09-01T00:00:00.000Z",
      dueDate: "2026-09-20T00:00:00.000Z",
      checklist: [],
      activities: [
        status(userId, "in_progress", "review", "2026-09-08T10:00:00.000Z"),
        { action: "due_date_changed", from: "2026-09-09T00:00:00.000Z", to: "2026-09-20T00:00:00.000Z", createdAt: "2026-09-13T10:00:00.000Z" },
        { action: "assignee_changed", from: userId, to: "user-2", createdAt: "2026-09-13T10:00:00.000Z" }
      ]
    }]
  });

  assert.equal(result.personal.stats.commitments, 1);
  assert.equal(result.personal.stats.onTime, 1);
  assert.equal(result.personal.score, 100);
});

test("an expired commitment is not erased by moving its due date later", () => {
  const result = buildEfficiency({
    userId,
    periodKey: "week",
    now: new Date("2026-09-12T12:00:00.000Z"),
    tasks: [{
      _id: "rescheduled-after-expiry",
      project: "project-2",
      assignee: userId,
      createdAt: "2026-09-01T00:00:00.000Z",
      dueDate: "2026-09-20T00:00:00.000Z",
      checklist: [],
      activities: [{
        action: "due_date_changed",
        from: "2026-09-08T00:00:00.000Z",
        to: "2026-09-20T00:00:00.000Z",
        createdAt: "2026-09-10T10:00:00.000Z"
      }]
    }]
  });

  assert.equal(result.personal.stats.commitments, 1);
  assert.equal(result.personal.stats.onTime, 0);
  assert.equal(result.personal.score, 0);
});

test("efficiency rejects unsupported periods and keeps no-data scores empty", () => {
  assert.throws(() => efficiencyPeriod("quarter"), (error) => error.statusCode === 400);
  const result = buildEfficiency({ tasks: [], userId, periodKey: "month" });
  assert.equal(result.personal.score, null);
  assert.equal(result.personal.confidence.key, "none");
  assert.equal(result.rhythm.length, 5);
});
