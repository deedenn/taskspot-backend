import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { Project } from "../src/models/Project.js";
import { Organization } from "../src/models/Organization.js";
import { ensureDefaultOrganization } from "../src/services/plans.js";
import { User } from "../src/models/User.js";
import { sessionToken } from "../src/services/accountSecurity.js";
import { activityActor } from "../src/services/projectActivity.js";

test("project journal API: ACL, actor, mutation persistence, roles and concurrency", {
  skip: !process.env.TEST_MONGODB_URI ? "Set TEST_MONGODB_URI for isolated project journal API tests" : false,
  timeout: 60000
}, async (t) => {
  process.env.JWT_SECRET = "test-project-activity-secret";
  process.env.NODE_ENV = "test";
  const uri = new URL(process.env.TEST_MONGODB_URI);
  uri.pathname = "/ts_activity_" + crypto.randomBytes(6).toString("hex");
  await mongoose.connect(uri.toString());
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  const users = await User.create(["owner", "member", "outsider"].map((name) => ({ name, lastName: "Test", email: name + "@example.test", passwordHash: "unused", emailVerifiedAt: new Date() })));
  const [owner, member, outsider] = users;
  const organization = await ensureDefaultOrganization(owner);
  const project = await Project.create({ organization: organization._id, name: "Project", createdBy: owner._id, members: [{ user: owner._id, role: "admin" }, { user: member._id, role: "member" }] });
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  async function request(path, user = owner, body, method = body ? "POST" : "GET") {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/projects/" + project._id + path, {
      method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + sessionToken(user) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await request("/activity", member)).status, 403);
  assert.equal((await request("/activity", outsider)).status, 403);
  assert.equal((await request("/activity?page=-1")).status, 400);
  assert.equal((await request("")).data.project.auditLog, undefined);
  const category = await request("/categories", owner, { name: "New category", color: "#123456" });
  assert.equal(category.status, 201);
  assert.equal((await request("/categories/" + category.data.categories[0]._id, owner, null, "DELETE")).status, 200);
  assert.equal((await request("/members/" + owner._id, owner, { role: "member" }, "PATCH")).status, 400);
  assert.equal((await request("/members", owner, { email: owner.email, role: "member" })).status, 400);
  assert.equal((await request("/members/" + member._id, owner, { role: "admin" }, "PATCH")).status, 200);
  const journal = await request("/activity?limit=2");
  assert.equal(journal.data.items.length, 2);
  assert.equal(journal.data.items[0].action, "role_changed");
  assert.equal(journal.data.items[0].actorName, "owner Test");
  assert.equal(journal.data.items[0].target, "member Test");
  assert.ok(journal.data.total >= 4);
  const first = await Project.findById(project._id), stale = await Project.findById(project._id);
  first.$locals.auditActor = activityActor(owner);
  first.name = "Updated";
  await first.save();
  stale.name = "Stale";
  await assert.rejects(stale.save(), { name: "VersionError" });
  const stored = await Project.findById(project._id).select("+auditLog");
  assert.equal(stored.name, "Updated");
  assert.equal(stored.auditLog.filter((event) => event.action === "settings_changed").length, 1);
  assert.equal((await request("/activity?page=999")).data.items.length, 0);
  await request("/categories", owner, { name: String(outsider._id) });
  const typed = await request("/activity");
  assert.equal(typed.data.items[0].target, String(outsider._id));

  const originalSave = Project.prototype.save;
  const failing = t.mock.method(Project.prototype, "save", function (...args) {
    if (this.members.some((item) => String(item.user) === String(outsider._id))) {
      throw new mongoose.Error.VersionError(this, this.__v, ["members"]);
    }
    return originalSave.apply(this, args);
  });
  const failed = await request("/members", owner, { email: outsider.email, role: "admin" });
  failing.mock.restore();
  assert.equal(failed.status, 409);
  const orgAfter = await Organization.findById(organization._id);
  const projectAfter = await Project.findById(project._id).select("+auditLog +members.emailOutbox");
  assert.ok(!orgAfter.members.some((item) => String(item.user) === String(outsider._id)));
  assert.ok(!projectAfter.members.some((item) => String(item.user) === String(outsider._id)));
  assert.ok(!projectAfter.auditLog.some((item) => String(item.targetUser) === String(outsider._id)));
});
