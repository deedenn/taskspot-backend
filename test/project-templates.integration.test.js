import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { Project } from "../src/models/Project.js";
import { ProjectTemplate } from "../src/models/ProjectTemplate.js";
import { Task } from "../src/models/Task.js";
import { User } from "../src/models/User.js";
import { Organization } from "../src/models/Organization.js";
import { ensureDefaultOrganization, organizationUsage } from "../src/services/plans.js";
import { sessionToken } from "../src/services/accountSecurity.js";

test("project templates: creation, ownership, limits, atomic rollback and idempotency", {
  skip: !process.env.TEST_MONGODB_URI, timeout: 60000
}, async (t) => {
  process.env.JWT_SECRET = "test-project-template-secret";
  process.env.NODE_ENV = "test";
  const uri = new URL(process.env.TEST_MONGODB_URI);
  uri.pathname = "/ts_templates_" + crypto.randomBytes(6).toString("hex");
  await mongoose.connect(uri.toString());
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await Project.init(); await ProjectTemplate.init(); await Task.init(); await Organization.init();
  const [owner, outsider] = await User.create(["owner", "outsider"].map((name) => ({
    name, lastName: "Test", email: name + "@example.test", passwordHash: "unused", emailVerifiedAt: new Date()
  })));
  const organization = await ensureDefaultOrganization(owner);
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  async function request(path = "", body, user = owner, method = body ? "POST" : "GET") {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/project-templates" + path, {
      method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken(user) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, data: await response.json() };
  }
  const payload = (name = "New project") => ({ name, startDate: "2026-09-07", requestId: crypto.randomUUID() });
  assert.equal((await request()).data.templates.length, 3);
  const firstBody = payload();
  const first = await request("/weekly-manager/projects", firstBody);
  assert.equal(first.status, 201, JSON.stringify(first.data));
  const id = first.data.project._id;
  assert.equal(first.data.project.templateCreationKey, undefined);
  assert.equal(first.data.project.templateCreationDigest, undefined);
  assert.equal(await Task.countDocuments({ project: id }), 3);
  assert.equal((await request("/weekly-manager/projects", firstBody)).data.project._id, id);
  assert.equal((await request("/weekly-manager/projects", { ...firstBody, name: "Changed" })).status, 409);
  const task = await Task.findOne({ project: id });
  task.checklist[0].done = true; await task.save();
  const saved = await request("", { projectId: id, name: "My blueprint" });
  assert.equal(saved.status, 201);
  const templateId = saved.data.template._id;
  assert.equal(saved.data.template.tasks[0].checklist[0].done, undefined);
  assert.equal((await request("", { projectId: id, name: "Not mine" }, outsider)).status, 403);
  assert.equal((await request("/" + templateId + "/projects", payload(), outsider)).status, 404);
  assert.equal((await request("/" + templateId, null, outsider, "DELETE")).status, 404);

  const concurrentBody = payload("Second");
  const results = await Promise.all([
    request("/" + templateId + "/projects", concurrentBody),
    request("/" + templateId + "/projects", concurrentBody)
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 201]);
  assert.equal(results[0].data.project._id, results[1].data.project._id);
  assert.equal(await Project.countDocuments({ organization: organization._id }), 2);
  const blocked = await request("/weekly-manager/projects", payload());
  assert.equal(blocked.status, 402);
  assert.equal(blocked.data.key, "projects");
  assert.equal(await Task.countDocuments({}), 6);

  await request("", { projectId: id, name: "Two" });
  await request("", { projectId: id, name: "Three" });
  assert.equal((await request("", { projectId: id, name: "Four" })).status, 402);
  assert.equal((await organizationUsage(organization)).templates, 3);
  assert.equal((await request("/" + templateId, null, owner, "DELETE")).status, 200);
  assert.equal(await Project.countDocuments({}), 2);

  await Project.updateOne({ _id: results[0].data.project._id }, { isArchived: true });
  await Task.insertMany(Array.from({ length: 46 }, (_, i) => ({ project: id, creator: owner._id, description: "Filler " + i })));
  const taskLimit = await request("/weekly-manager/projects", payload());
  assert.equal(taskLimit.status, 402);
  assert.equal(taskLimit.data.key, "activeTasks");
  assert.equal(await Project.countDocuments({}), 2);

  await Task.deleteMany({ description: /^Filler/ });
  const failing = t.mock.method(Task, "insertMany", async () => { throw new Error("injected template failure"); });
  const rollback = await request("/weekly-manager/projects", payload());
  failing.mock.restore();
  assert.equal(rollback.status, 500);
  assert.equal(await Project.countDocuments({}), 2);
  assert.equal(await Task.countDocuments({}), 6);
  const retry = await request("/weekly-manager/projects", payload("After failure"));
  assert.equal(retry.status, 201);
});
