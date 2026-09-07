import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import bcrypt from "bcryptjs";
import express from "express";
import mongoose from "mongoose";
import { authRouter } from "../src/routes/auth.js";
import { Notification } from "../src/models/Notification.js";
import { Organization } from "../src/models/Organization.js";
import { Project } from "../src/models/Project.js";
import { Task } from "../src/models/Task.js";
import { User } from "../src/models/User.js";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

test("isolated replica set: atomic email verification and login invitation repair", {
  skip: !process.env.TEST_MONGODB_URI ? "Set TEST_MONGODB_URI to a local replica set" : false,
  timeout: 60000
}, async (t) => {
  const uri = new URL(process.env.TEST_MONGODB_URI);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(uri.hostname), "Use a local test replica set only");
  assert.ok(uri.searchParams.get("replicaSet"), "Transactions require a replica set");
  uri.pathname = "/ts_auth_invite_" + crypto.randomBytes(8).toString("hex");
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "isolated-auth-invitations-secret";
  await mongoose.connect(uri.toString(), { serverSelectionTimeoutMS: 5000 });
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    try { await mongoose.connection.dropDatabase(); }
    finally { await mongoose.disconnect(); }
  });
  for (const Model of [User, Organization, Project, Task, Notification]) await Model.init();
  const app = express();
  app.use(express.json());
  app.use("/auth", authRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const password = "Strong-password-123!";
  const passwordHash = await bcrypt.hash(password, 4);
  const owner = await User.create({ name: "Owner", email: "owner@example.test", passwordHash, emailVerifiedAt: new Date() });

  async function request(path, body, token) {
    const response = await fetch(base + "/auth" + path, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    return { status: response.status, data: await response.json() };
  }

  async function fixture(overrides = {}, projectCount = 2) {
    const token = crypto.randomBytes(24).toString("hex");
    const user = await User.create({
      name: "Invitee", lastName: "Test", email: token + "@example.test", passwordHash,
      emailVerificationStatus: "pending", emailVerificationTokenHash: hash(token),
      emailVerificationExpiresAt: new Date(Date.now() + 60000), ...overrides
    });
    const organization = await Organization.create({ name: "Invited organization", members: [{ user: owner._id, role: "owner" }] });
    const projects = [];
    for (let index = 0; index < projectCount; index += 1) {
      const project = await Project.create({
        name: "Invited project " + index, organization: organization._id, createdBy: owner._id,
        members: [{ user: owner._id, role: "admin" }],
        invitations: [{ email: user.email, invitedBy: owner._id, role: "admin", token: "invitation-secret" }]
      });
      projects.push(project);
      for (let taskIndex = 0; taskIndex < 2; taskIndex += 1) {
        await Task.create({ project: project._id, creator: owner._id, description: "Pending task " + taskIndex, assigneeEmail: user.email });
      }
    }
    return { user, token, organization, projects };
  }

  async function snapshot(f) {
    return {
      user: await User.findById(f.user._id).lean(),
      organization: await Organization.findById(f.organization._id).lean(),
      projects: await Project.find({ _id: { $in: f.projects.map((project) => project._id) } }).select("+auditLog").sort({ _id: 1 }).lean(),
      tasks: await Task.find({ project: { $in: f.projects.map((project) => project._id) } }).sort({ _id: 1 }).lean(),
      notifications: await Notification.find({ user: f.user._id }).sort({ _id: 1 }).lean()
    };
  }

  async function assertAccepted(f, role = "admin") {
    const state = await snapshot(f);
    assert.ok(state.user.emailVerifiedAt);
    assert.equal(state.organization.members.filter((member) => String(member.user) === String(f.user._id)).length, 1);
    for (const project of state.projects) {
      const members = project.members.filter((member) => String(member.user) === String(f.user._id));
      assert.equal(members.length, 1);
      assert.equal(members[0].role, role);
      assert.equal(project.invitations[0].status, "accepted");
      const events = project.auditLog.filter((event) => event.action === "invitation_accepted");
      assert.equal(events.length, 1);
      assert.equal(String(events[0].actor), String(f.user._id));
      assert.equal(events[0].actorName, "Invitee Test");
    }
    for (const task of state.tasks) {
      assert.equal(String(task.assignee), String(f.user._id));
      assert.equal(task.assigneeEmail, undefined);
      assert.equal(state.notifications.filter((notification) => String(notification.task) === String(task._id)).length, 1);
    }
    assert.equal(state.notifications.length, state.tasks.length);
    return state;
  }

  await t.test("late failure rolls back user, both projects, organization, tasks and notifications; token remains usable", async (t) => {
    const f = await fixture();
    const before = await snapshot(f);
    const save = Notification.prototype.save;
    let writes = 0;
    const failure = t.mock.method(Notification.prototype, "save", async function (options) {
      assert.ok(options.session?.inTransaction());
      const result = await save.call(this, options);
      if (++writes === 4) throw new Error("Injected failure after last notification write");
      return result;
    });
    const failed = await request("/email/verify", { token: f.token });
    assert.equal(failed.status, 500);
    assert.equal(failed.data.token, undefined);
    assert.equal(writes, 4);
    failure.mock.restore();
    assert.deepEqual(await snapshot(f), before);

    const verified = await request("/email/verify", { token: f.token });
    assert.equal(verified.status, 200);
    assert.equal((await request("/me", null, verified.data.token)).status, 200);
    const accepted = await assertAccepted(f);
    assert.equal(accepted.user.emailVerificationTokenHash, "");
    assert.equal(accepted.user.emailVerificationExpiresAt, undefined);
    assert.equal((await request("/email/verify", { token: f.token })).status, 400);
    assert.deepEqual(await snapshot(f), accepted);
  });

  await t.test("Mongoose VersionError aborts verification without consuming its token", async (t) => {
    const f = await fixture();
    const before = await snapshot(f);
    const updateOne = Project.collection.updateOne;
    const failure = t.mock.method(Project.collection, "updateOne", async function (filter, update, options) {
      if (options?.session && String(filter._id) === String(f.projects[1]._id)) {
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
      }
      return updateOne.call(this, filter, update, options);
    });
    assert.equal((await request("/email/verify", { token: f.token })).status, 409);
    failure.mock.restore();
    assert.deepEqual(await snapshot(f), before);
    assert.equal((await request("/email/verify", { token: f.token })).status, 200);
    await assertAccepted(f);
  });

  await t.test("real project write conflict retries with fresh invitation role and no duplicate journal or notifications", async (t) => {
    const f = await fixture({}, 1);
    const updateOne = Project.collection.updateOne;
    let attempts = 0;
    t.mock.method(Project.collection, "updateOne", async function (filter, update, options) {
      if (options?.session && String(filter._id) === String(f.projects[0]._id)) {
        if (++attempts === 1) {
          const concurrent = await Project.findById(filter._id);
          concurrent.name = "Concurrent rename";
          concurrent.invitations[0].role = "member";
          await concurrent.save();
        }
      }
      return updateOne.call(this, filter, update, options);
    });
    assert.equal((await request("/email/verify", { token: f.token })).status, 200);
    assert.ok(attempts >= 2);
    const accepted = await assertAccepted(f, "member");
    assert.equal(accepted.projects[0].name, "Concurrent rename");
    assert.equal(accepted.projects[0].auditLog.filter((event) => event.action === "member_added").length, 1);
    assert.equal(accepted.organization.members.find((member) => String(member.user) === String(f.user._id)).role, "member");
  });

  for (const change of ["expired", "replaced"]) {
    await t.test("transaction retry rechecks a token that was " + change, async (t) => {
      const f = await fixture({}, 1);
      const before = await snapshot(f);
      const updateOne = User.collection.updateOne;
      let raced = false;
      t.mock.method(User.collection, "updateOne", async function (filter, update, options) {
        if (!raced && options?.session && String(filter._id) === String(f.user._id)) {
          raced = true;
          await updateOne.call(this, { _id: f.user._id }, { $set: change === "expired"
            ? { emailVerificationExpiresAt: new Date(0) }
            : { emailVerificationTokenHash: hash("replacement-token") } });
        }
        return updateOne.call(this, filter, update, options);
      });
      assert.equal((await request("/email/verify", { token: f.token })).status, 400);
      assert.equal(raced, true);
      const after = await snapshot(f);
      assert.equal(after.user.emailVerifiedAt, undefined);
      assert.equal(after.user.emailVerificationTokenHash, change === "replaced" ? hash("replacement-token") : hash(f.token));
      assert.deepEqual(after.projects, before.projects);
      assert.deepEqual(after.organization, before.organization);
      assert.deepEqual(after.tasks, before.tasks);
      assert.deepEqual(after.notifications, []);
    });
  }

  await t.test("login repair failure preserves a valid session; next login repairs once without changing an existing role", async (t) => {
    const f = await fixture({ emailVerifiedAt: new Date(), emailVerificationStatus: "verified", emailVerificationTokenHash: "" }, 1);
    f.projects[0].members.push({ user: f.user._id, role: "member" });
    await f.projects[0].save();
    const before = await snapshot(f);
    const save = Notification.prototype.save;
    const failure = t.mock.method(Notification.prototype, "save", async function (options) {
      await save.call(this, options);
      throw new Error("Injected repair failure");
    });
    const login = await request("/login", { email: f.user.email, password });
    assert.equal(login.status, 200);
    assert.equal((await request("/me", null, login.data.token)).status, 200);
    failure.mock.restore();
    const failed = await snapshot(f);
    assert.deepEqual(failed.projects, before.projects);
    assert.deepEqual(failed.organization, before.organization);
    assert.deepEqual(failed.tasks, before.tasks);
    assert.deepEqual(failed.notifications, []);

    assert.equal((await request("/login", { email: f.user.email, password })).status, 200);
    const accepted = await assertAccepted(f, "member");
    assert.equal((await request("/login", { email: f.user.email, password })).status, 200);
    const repeated = await snapshot(f);
    assert.deepEqual(repeated.projects, accepted.projects);
    assert.deepEqual(repeated.organization, accepted.organization);
    assert.deepEqual(repeated.tasks, accepted.tasks);
    assert.deepEqual(repeated.notifications, accepted.notifications);
  });

  await t.test("unauthenticated, blocked, inactive, unverified and superadmin logins never accept invitations", async () => {
    for (const scenario of [
      { overrides: { emailVerifiedAt: new Date() }, password: "incorrect", status: 401 },
      { overrides: { emailVerifiedAt: new Date(), status: "blocked" }, status: 403 },
      { overrides: { emailVerifiedAt: new Date(), status: "inactive" }, status: 403 },
      { overrides: {}, status: 403 },
      { overrides: { emailVerifiedAt: new Date(), isSuperAdmin: true }, status: 200 }
    ]) {
      const f = await fixture(scenario.overrides, 1);
      const before = await snapshot(f);
      const login = await request("/login", { email: f.user.email, password: scenario.password || password });
      assert.equal(login.status, scenario.status);
      assert.equal(login.data.token, undefined);
      const after = await snapshot(f);
      assert.deepEqual(after.projects, before.projects);
      assert.deepEqual(after.organization, before.organization);
      assert.deepEqual(after.tasks, before.tasks);
      assert.deepEqual(after.notifications, []);
    }
  });

  await t.test("expired invitations and pending invitations for other emails are not repaired", async () => {
    const f = await fixture({ emailVerifiedAt: new Date(), emailVerificationStatus: "verified" }, 1);
    f.projects[0].invitations[0].expiresAt = new Date(0);
    f.projects[0].invitations.push({ email: "other@example.test", invitedBy: owner._id });
    await f.projects[0].save();
    const before = await snapshot(f);
    assert.equal((await request("/login", { email: f.user.email, password })).status, 200);
    const after = await snapshot(f);
    assert.deepEqual(after.projects, before.projects);
    assert.deepEqual(after.organization, before.organization);
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.notifications, []);
  });

  await t.test("email verification does not grant workspace membership to a superadmin", async () => {
    const f = await fixture({ isSuperAdmin: true }, 1);
    const before = await snapshot(f);
    assert.equal((await request("/email/verify", { token: f.token })).status, 200);
    const after = await snapshot(f);
    assert.deepEqual(after.projects, before.projects);
    assert.deepEqual(after.organization, before.organization);
    assert.deepEqual(after.tasks, before.tasks);
    assert.deepEqual(after.notifications, []);
  });
});
