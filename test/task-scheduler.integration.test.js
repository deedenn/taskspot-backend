import assert from "node:assert/strict";
import { test } from "node:test";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { createApp } from "../src/app.js";
import { Task } from "../src/models/Task.js";
import { User } from "../src/models/User.js";
import { Project } from "../src/models/Project.js";
import { Organization } from "../src/models/Organization.js";
import { processRecurrence } from "../src/services/taskScheduler.js";
import { normalizeRecurrence } from "../src/services/taskSchedule.js";

test("MongoDB recurrence dedupe, crash recovery, and deadline editing", {
  skip: !process.env.TEST_MONGODB_URI && "Set TEST_MONGODB_URI for isolated scheduler integration tests",
  timeout: 60000
}, async (t) => {
  const uri = new URL(process.env.TEST_MONGODB_URI);
  uri.pathname = `/ts_schedule_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  process.env.JWT_SECRET ||= "test-secret";
  await mongoose.connect(uri.toString(), { serverSelectionTimeoutMS: 10000 });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await Task.init();
  const user = await User.create({ name: "Scheduler", email: "scheduler@example.com", passwordHash: "unused" });
  const organization = await Organization.create({ name: "Test", plan: "team", members: [{ user: user._id, role: "owner" }] });
  const project = await Project.create({ name: "Test", organization: organization._id, createdBy: user._id,
    members: [{ user: user._id, role: "admin" }] });
  const deadline = new Date("2026-08-25T09:00:00Z");
  const now = new Date("2026-09-01T09:00:00Z");
  const source = await Task.create({ project: project._id, creator: user._id, description: "Repeat", dueDate: deadline,
    recurrence: normalizeRecurrence({ enabled: true, frequency: "weekly" }, deadline),
    checklist: [{ text: "Step", done: true }] });
  const options = { notify: async () => {} };

  await Promise.all([processRecurrence(source, now, options), processRecurrence(source, now, options)]);
  assert.equal(await Task.countDocuments({ recurrenceSource: source._id }), 1);
  let fresh = await Task.findById(source._id);
  assert.equal(fresh.recurrence.nextRunAt.toISOString(), "2026-09-08T09:00:00.000Z");
  await assert.rejects(processRecurrence(fresh, new Date("2026-09-08T09:00:00Z"), {
    notify: async () => { throw new Error("queue offline"); }
  }));
  assert.equal(await Task.countDocuments({ recurrenceSource: source._id }), 2);
  assert.equal((await Task.findById(source._id)).recurrence.nextRunAt.toISOString(), "2026-09-08T09:00:00.000Z");
  await processRecurrence(fresh, new Date("2026-09-08T09:00:00Z"), options);
  assert.equal(await Task.countDocuments({ recurrenceSource: source._id }), 2);

  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const token = jwt.sign({ userId: String(user._id) }, process.env.JWT_SECRET, { algorithm: "HS256" });
  const patch = async (body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/${source._id}`, {
      method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return { response, data: await response.json() };
  };
  const changed = await patch({ dueDate: "2026-10-01T09:00:00Z" });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.data));
  assert.equal(changed.data.task.recurrence.nextRunAt, "2026-10-08T09:00:00.000Z");
  assert.notEqual(changed.data.task.recurrence.revision, source.recurrence.revision);
  const missingDeadline = await patch({ dueDate: null });
  assert.equal(missingDeadline.response.status, 400);
  assert.equal((await Task.findById(source._id)).dueDate.toISOString(), "2026-10-01T09:00:00.000Z");
  const stopped = await patch({ recurrence: { enabled: false } });
  assert.equal(stopped.response.status, 200, JSON.stringify(stopped.data));
  assert.equal(stopped.data.task.recurrence.enabled, false);
  await processRecurrence(fresh, new Date("2026-10-08T09:00:00Z"), options);
  assert.equal((await Task.findById(source._id)).recurrence.enabled, false);
  assert.equal(await Task.countDocuments({ recurrenceSource: source._id }), 2);
});
