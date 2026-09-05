import assert from "node:assert/strict";
import { test } from "node:test";
import { Task } from "../src/models/Task.js";
import { Project } from "../src/models/Project.js";
import { User } from "../src/models/User.js";
import { Organization } from "../src/models/Organization.js";
import { WorkerLease } from "../src/models/WorkerLease.js";
import { nextOccurrence, normalizeRecurrence } from "../src/services/taskSchedule.js";
import { processRecurrence, processRecurrences, recurrenceGuard, runScheduledTasks } from "../src/services/taskScheduler.js";

const now = new Date("2026-09-01T09:00:00Z");
const source = () => ({
  _id: "source", project: "project", creator: "owner", description: "Weekly work", priority: "high",
  dueDate: new Date("2026-08-25T09:00:00Z"),
  assignee: "removed", assigneeEmail: "expired@example.com", observers: ["member", "removed"],
  categories: ["live", "deleted"], checklist: [{ text: "First step", done: true }],
  recurrence: { enabled: true, frequency: "weekly", timeZone: "Europe/Moscow", anchorDay: 25, nextRunAt: now, revision: "v1" }
});
function harness(t, { archived = false, existing = null, fresh = true, plan = "team" } = {}) {
  const project = { _id: "project", organization: "org", name: "Project", isArchived: archived,
    categories: [{ _id: "live" }], members: [{ user: "owner", role: "admin" }, { user: "member", role: "member" }],
    invitations: [{ status: "pending", email: "expired@example.com", expiresAt: new Date("2020-01-01") }] };
  let child = existing;
  const creates = [];
  const updates = [];
  t.mock.method(Project, "findById", async () => project);
  t.mock.method(User, "exists", async () => ({ _id: "owner" }));
  t.mock.method(Organization, "findById", async () => ({ _id: "org", plan }));
  t.mock.method(Task, "exists", async () => fresh ? { _id: "source" } : null);
  t.mock.method(Task, "findOne", async () => child);
  t.mock.method(Task, "create", async (data) => { creates.push(data); child = { ...data, _id: "child" }; return child; });
  t.mock.method(Task, "updateOne", async (filter, update) => { updates.push({ filter, update }); return { modifiedCount: 1 }; });
  const options = { usageFor: async () => ({ activeTasks: 0, recurringTasks: 1 }), notify: async () => {}, notifyLimit: async () => {} };
  return { creates, updates, options, project };
}

test("monthly recurrence retains the 31st and local time across February and leap years", () => {
  const settings = normalizeRecurrence({ enabled: true, frequency: "monthly" }, new Date("2028-01-31T09:00:00Z"));
  assert.equal(settings.nextRunAt.toISOString(), "2028-02-29T09:00:00.000Z");
  assert.equal(nextOccurrence(settings.nextRunAt, "monthly", settings.timeZone, settings.anchorDay, settings.anchorTime).toISOString(),
    "2028-03-31T09:00:00.000Z");
});

test("DST gaps move forward once; subsequent occurrences return to the anchored hour", () => {
  const anchor = { hour: 2, minute: 30, second: 0 };
  const skippedHour = nextOccurrence("2026-03-28T01:30:00Z", "daily", "Europe/Berlin", 28, anchor);
  assert.equal(skippedHour.toISOString(), "2026-03-29T01:30:00.000Z");
  assert.equal(nextOccurrence(skippedHour, "daily", "Europe/Berlin", 28, anchor).toISOString(), "2026-03-30T00:30:00.000Z");
  assert.equal(nextOccurrence("2026-10-24T00:30:00Z", "daily", "Europe/Berlin", 24, anchor).toISOString(), "2026-10-25T00:30:00.000Z");
});

test("rescheduling creates a new version and disabling removes the next occurrence", () => {
  const first = normalizeRecurrence({ enabled: true, frequency: "daily" }, now);
  const second = normalizeRecurrence({ enabled: true, frequency: "daily" }, new Date("2026-09-10T09:00:00Z"));
  assert.notEqual(first.revision, second.revision);
  assert.equal(second.nextRunAt.toISOString(), "2026-09-11T09:00:00.000Z");
  assert.equal(normalizeRecurrence({ enabled: false }).nextRunAt, undefined);
  assert.throws(() => normalizeRecurrence({ enabled: true }), /нужен срок/);
  assert.throws(() => normalizeRecurrence({ enabled: true, frequency: "none" }, now));
  assert.throws(() => nextOccurrence(now, "monthly", "Europe/Moscow", -1));
  assert.throws(() => normalizeRecurrence({ enabled: true, timeZone: "invalid" }, now));
});

test("occurrences copy only current project participants/categories and reset checklist", async (t) => {
  const h = harness(t);
  await processRecurrence(source(), now, h.options);
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0].recurrenceKey, "source:2026-09-01T09:00:00.000Z");
  assert.equal(h.creates[0].assignee, undefined);
  assert.equal(h.creates[0].assigneeEmail, undefined);
  assert.deepEqual(h.creates[0].observers, ["member"]);
  assert.deepEqual(h.creates[0].categories, ["live"]);
  assert.deepEqual(h.creates[0].checklist, [{ text: "First step", done: false }]);
  assert.equal(h.creates[0].recurrence.enabled, false);
  assert.equal(h.creates[0].attachments, undefined);
  assert.equal(h.updates[0].update.$set["recurrence.lastTask"], "child");
  assert.equal(h.updates[0].update.$set["recurrence.nextRunAt"].toISOString(), "2026-09-08T09:00:00.000Z");
});

test("notification failure preserves the cursor and retry reuses the created task", async (t) => {
  const h = harness(t);
  let attempts = 0;
  const options = { ...h.options, notify: async () => { if (++attempts === 1) throw new Error("queue offline"); } };
  await assert.rejects(processRecurrence(source(), now, options));
  assert.equal(h.updates.length, 0);
  await processRecurrence(source(), now, options);
  assert.equal(h.creates.length, 1);
  assert.equal(h.updates.length, 1);
});

test("a concurrent duplicate insert is recovered using the unique occurrence key", async (t) => {
  const h = harness(t);
  let reads = 0;
  t.mock.method(Task, "findOne", async () => ++reads === 1 ? null : { _id: "other-child", creator: "owner" });
  t.mock.method(Task, "create", async () => { throw { code: 11000 }; });
  await processRecurrence(source(), now, h.options);
  assert.equal(h.updates[0].update.$set["recurrence.lastTask"], "other-child");
});

test("archived projects and exhausted plans pause without moving the scheduled date", async (t) => {
  for (const scenario of ["archive", "task-limit", "free"]) {
    await t.test(scenario, async (t) => {
      const h = harness(t, { archived: scenario === "archive", plan: scenario === "free" ? "free" : "team" });
      await processRecurrence(source(), now, { ...h.options,
        usageFor: async () => ({ activeTasks: scenario === "task-limit" ? 1000 : 0, recurringTasks: 1 }) });
      assert.equal(h.creates.length, 0);
      assert.ok(h.updates[0].update.$set["recurrence.retryAt"] > now);
      assert.equal(h.updates[0].update.$set["recurrence.nextRunAt"], undefined);
    });
  }
});

test("removed or blocked initiators cannot create automatic tasks", async (t) => {
  const h = harness(t);
  t.mock.method(User, "exists", async () => null);
  await processRecurrence(source(), now, h.options);
  assert.equal(h.creates.length, 0);
  assert.match(h.updates[0].update.$set["recurrence.lastError"], /инициатор/);
});

test("edited/disabled schedules cannot be advanced by an old snapshot", async (t) => {
  const h = harness(t, { fresh: false });
  await processRecurrence(source(), now, h.options);
  assert.equal(h.creates.length, 0);
  assert.equal(h.updates.length, 0);
  assert.equal(recurrenceGuard(source())["recurrence.revision"], "v1");
  const legacy = source();
  delete legacy.recurrence.revision;
  assert.deepEqual(recurrenceGuard(legacy)["recurrence.revision"], { $exists: false });
});

test("one broken recurrence does not starve following sources; the cursor is closed", async (t) => {
  const h = harness(t);
  let closed = false;
  const bad = source();
  bad.recurrence.timeZone = "not-a-time-zone";
  const good = { ...source(), _id: "healthy" };
  const cursor = { async *[Symbol.asyncIterator]() { yield bad; yield good; }, close: async () => { closed = true; } };
  t.mock.method(Task, "find", () => ({ sort: () => ({ limit: (value) => {
    assert.equal(value, 100);
    return { cursor: () => cursor };
  } }) }));
  await processRecurrences(now, h.options);
  assert.equal(h.creates.length, 1);
  assert.equal(h.creates[0].recurrenceSource, "healthy");
  assert.equal(closed, true);
  assert.ok(h.updates.some((item) => item.filter._id === "source" && item.update.$set["recurrence.retryAt"]));
});

test("another scheduler owns the lease: no work is started", async (t) => {
  t.mock.method(WorkerLease, "findOneAndUpdate", async () => { throw { code: 11000 }; });
  assert.equal(await runScheduledTasks(now, { recurrences: async () => assert.fail("lease is busy") }), false);
});

test("lost lease stops further processing and token-fenced release cannot delete another owner", async (t) => {
  let token;
  t.mock.method(WorkerLease, "findOneAndUpdate", async (filter, update) => {
    token = update.$set.token;
    return { token };
  });
  let checks = 0;
  t.mock.method(WorkerLease, "updateOne", async (filter) => {
    assert.equal(filter.token, token);
    assert.deepEqual(filter.expiresAt, { $gt: now });
    return { matchedCount: ++checks === 1 ? 1 : 0 };
  });
  const releases = t.mock.method(WorkerLease, "deleteOne", async (filter) => assert.equal(filter.token, token));
  await assert.rejects(runScheduledTasks(now, {
    clock: () => now,
    recurrences: async (_now, { assertLease }) => { await assertLease(); assert.fail("lost lease"); },
    reminders: async () => assert.fail("reminders after lease loss")
  }), (error) => error.code === "SCHEDULER_LEASE_LOST");
  assert.equal(releases.mock.callCount(), 1);
});
