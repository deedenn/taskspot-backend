import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { Project } from "../src/models/Project.js";
import { Task } from "../src/models/Task.js";
import { User } from "../src/models/User.js";
import { ensureDefaultOrganization } from "../src/services/plans.js";
import { sessionToken } from "../src/services/accountSecurity.js";

test("document improvements: global search ACL, assignee control and atomic category deletion", {
  skip: !process.env.TEST_MONGODB_URI, timeout: 60000
}, async (t) => {
  process.env.NODE_ENV = "test"; process.env.JWT_SECRET = "document-improvements-test-secret";
  const uri = new URL(process.env.TEST_MONGODB_URI);
  uri.pathname = "/ts_document_" + crypto.randomBytes(6).toString("hex");
  await mongoose.connect(uri.toString());
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const [owner, member, outsider] = await User.create(["Owner", "Member", "Outsider"].map((name) => ({
    name, lastName: "Test", email: name.toLowerCase() + "@example.test", passwordHash: "unused",
    avatarUrl: "https://example.test/avatar.png", emailVerifiedAt: new Date()
  })));
  const org = await ensureDefaultOrganization(owner);
  const project = await Project.create({ name: "Альфа", organization: org._id, createdBy: owner._id,
    members: [{ user: owner._id, role: "admin" }, { user: member._id, role: "member" }],
    categories: [{ name: "Документы", color: "#123456" }, { name: "Работа", color: "#654321" }]
  });
  const hiddenProject = await Project.create({ name: "Secret", createdBy: outsider._id, members: [{ user: outsider._id, role: "admin" }] });
  const [assigned, observed, hidden, external, unassigned] = await Task.create([
    { project: project._id, creator: owner._id, assignee: member._id, description: "Проверить договор", status: "open",
      categories: [project.categories[0]._id, project.categories[1]._id], checklist: [{ text: "Сверить реквизиты", done: false }],
      comments: [{ author: owner._id, text: "Уточнение поставщика" }], attachments: [{ name: "Смета.pdf", key: "test" }] },
    { project: project._id, creator: owner._id, assignee: owner._id, observers: [member._id], description: "Бюджет", status: "closed" },
    { project: project._id, creator: owner._id, assignee: owner._id, description: "Приватная задача", status: "review" },
    { project: hiddenProject._id, creator: outsider._id, description: "Приватная задача другого проекта" },
    { project: project._id, creator: owner._id, description: "Без исполнителя", status: "in_progress" }
  ]);
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  async function request(path, user = owner, method = "GET", body) {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api" + path, {
      method, headers: { Authorization: "Bearer " + sessionToken(user), "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, data: await response.json() };
  }
  const search = (q, user = member) => request("/workspace/tasks?" + new URLSearchParams({ q }), user);
  for (const word of ["договор", "реквизиты", "поставщика", "Смета.pdf", "Документы", "альфа договор"]) {
    const result = await search(word);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.ok(result.data.tasks.some((task) => task._id === String(assigned._id)), word);
  }
  assert.equal((await search("Приватная")).data.pagination.total, 0);
  assert.equal((await search("Приватная", owner)).data.pagination.total, 1);
  assert.equal((await search(".*")).data.pagination.total, 0);
  assert.equal((await request("/workspace/tasks?q[x]=1")).status, 400);
  assert.equal((await request("/workspace/tasks?projectId=" + hiddenProject._id, member)).status, 403);
  const paged = await request("/workspace/tasks?limit=1", member);
  assert.equal(paged.data.pagination.total, 2);
  assert.equal(paged.data.tasks.length, 1);
  assert.equal((await request("/workspace/tasks?assignee=" + member._id, member)).data.tasks[0].assignee.avatarUrl, member.avatarUrl);
  const memberGroups = await request("/workspace/assignees", member);
  assert.equal(memberGroups.status, 200);
  assert.equal(memberGroups.data.groups.reduce((sum, group) => sum + group.total, 0), 2);
  assert.ok(!JSON.stringify(memberGroups.data).includes(String(hidden._id)));
  const ownerGroups = await request("/workspace/assignees");
  assert.equal(ownerGroups.data.groups.reduce((sum, group) => sum + group.total, 0), 4);
  const filtered = await request("/workspace/assignees?assignee=" + member._id);
  assert.equal(filtered.data.groups.length, 1);
  assert.equal(filtered.data.people.length, ownerGroups.data.people.length);
  assert.equal(filtered.data.groups[0].user.avatarUrl, member.avatarUrl);
  const categoryPath = "/projects/" + project._id + "/categories/" + project.categories[0]._id;
  assert.equal((await request(categoryPath, member, "DELETE")).status, 403);
  const before = await Task.findById(assigned._id).lean();
  const failedUpdate = t.mock.method(Task, "updateMany", async () => { throw new Error("category failure injection"); });
  assert.equal((await request(categoryPath, owner, "DELETE")).status, 500);
  failedUpdate.mock.restore();
  assert.equal((await Project.findById(project._id)).categories.length, 2);
  assert.deepEqual(await Task.findById(assigned._id).lean(), before);
  const deleted = await request(categoryPath, owner, "DELETE");
  assert.equal(deleted.status, 200);
  const after = await Task.findById(assigned._id).lean();
  assert.deepEqual(after.categories.map(String), [String(project.categories[1]._id)]);
  assert.deepEqual({ ...after, categories: before.categories }, before);
  assert.equal(await Task.countDocuments({}), 5);
  assert.equal((await request(categoryPath, owner, "DELETE")).status, 404);
  assert.equal((await search("Документы", owner)).data.pagination.total, 0);
  assert.equal((await request("/tasks/" + assigned._id, member, "PATCH", { status: "in_progress" })).status, 200);
  const review = await request("/tasks/" + assigned._id, member, "PATCH", { status: "review" });
  assert.equal(review.status, 200);
  assert.equal(review.data.task.status, "review");
  assert.notEqual((await request("/tasks/" + assigned._id, member, "PATCH", { status: "closed", confirmed: true })).status, 200);
});
