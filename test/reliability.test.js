import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { nextOccurrence, dateKey } from "../src/services/taskSchedule.js";
import { canViewTask, taskFilterForProjects } from "../src/services/taskAccess.js";
import { retryDelay, retryableEmailError, safeEmailError } from "../src/services/emailQueue.js";
import { EmailJob } from "../src/models/EmailJob.js";
import { User } from "../src/models/User.js";
import { processEmailJob } from "../src/services/emailWorker.js";

test("monthly recurrence clamps February without moving March off the 31st", () => {
  const february = nextOccurrence("2026-01-31T06:00:00Z", "monthly", "Europe/Moscow", 31);
  assert.equal(february.toISOString(), "2026-02-28T06:00:00.000Z");
  assert.equal(nextOccurrence(february, "monthly", "Europe/Moscow", 31).toISOString(), "2026-03-31T06:00:00.000Z");
  assert.equal(nextOccurrence("2028-01-31T06:00:00Z", "monthly", "Europe/Moscow", 31).toISOString(), "2028-02-29T06:00:00.000Z");
});

test("daily and weekly schedules preserve local hour through daylight saving", () => {
  assert.equal(nextOccurrence("2026-03-28T08:00:00Z", "daily", "Europe/Berlin").toISOString(), "2026-03-29T07:00:00.000Z");
  assert.equal(nextOccurrence("2026-10-18T07:00:00Z", "weekly", "Europe/Berlin").toISOString(), "2026-10-25T08:00:00.000Z");
  assert.equal(dateKey(new Date("2026-09-05T22:00:00Z"), "Europe/Moscow"), "2026-09-06");
  assert.throws(() => nextOccurrence("invalid", "daily"));
});

test("task creator loses access when removed; admin-only and observer access remain", () => {
  const task = { creator: "creator", assignee: "assignee", observers: [{ _id: "observer" }] };
  const project = { _id: "project", members: [
    { user: { _id: "admin" }, role: "admin" }, { user: "observer", role: "member" }, { user: "assignee", role: "member" }
  ] };
  assert.equal(canViewTask(task, project, "creator"), false);
  assert.equal(canViewTask(task, project, "admin"), true);
  assert.equal(canViewTask(task, project, "observer"), true);
  assert.equal(canViewTask(task, project, "stranger"), false);
  assert.deepEqual(taskFilterForProjects([], "creator").$or[0].project.$in, []);
});

test("SMTP retry policy retries temporary errors but not bad passwords or rejected addresses", () => {
  assert.equal(retryableEmailError({ code: "ETIMEDOUT" }), true);
  assert.equal(retryableEmailError({ responseCode: 451 }), true);
  assert.equal(retryableEmailError({ responseCode: 550 }), false);
  assert.equal(retryableEmailError({ code: "EAUTH" }), false);
  assert.equal(retryDelay(1), 60000);
  assert.equal(retryDelay(20), 21600000);
  assert.equal(safeEmailError({ message: "password=secret token=secret", code: "ETIMEDOUT" }).includes("secret"), false);
});

test("email worker records acceptance, retry and permanent failure without logging message contents", async () => {
  for (const scenario of ["accepted", "temporary", "permanent", "exhausted", "expired"]) {
    const job = { _id: "job", messageId: "<stable@taskspot.ru>", attempts: scenario === "exhausted" ? 20 : 1,
      mail: { to: "test@example.com", text: "secret" }, context: scenario === "expired" ? { kind: "verification" } : {} };
    let updated;
    let sends = 0;
    mock.method(EmailJob, "findOneAndUpdate", (filter, update, options) => {
      if (options.sort) return { select: async () => job };
      updated = { ...job, ...update.$set };
      return Promise.resolve(updated);
    });
    mock.method(EmailJob, "updateOne", async () => ({}));
    mock.method(User, "exists", async () => null);
    try {
      await processEmailJob({ now: new Date("2026-01-01Z"), send: async (mail) => {
        sends += 1;
        assert.equal(mail.messageId, "<stable@taskspot.ru>");
        if (scenario === "temporary" || scenario === "exhausted") throw { code: "ETIMEDOUT" };
        if (scenario === "permanent") throw { code: "EAUTH" };
      } });
      assert.equal(updated.status, scenario === "accepted" ? "accepted" : scenario === "temporary" ? "queued" : scenario === "expired" ? "cancelled" : "failed");
      assert.equal(sends, scenario === "expired" ? 0 : 1);
    } finally { mock.restoreAll(); }
  }
});
