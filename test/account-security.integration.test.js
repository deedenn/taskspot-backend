import assert from "node:assert/strict";
import { test } from "node:test";
import crypto from "node:crypto";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { createApp } from "../src/app.js";
import { User } from "../src/models/User.js";
import { Project } from "../src/models/Project.js";
import { Task } from "../src/models/Task.js";
import { ProductEvent } from "../src/models/ProductEvent.js";
import { setupAdmin } from "../src/services/adminSetup.js";
import { sessionToken } from "../src/services/accountSecurity.js";

test("isolated API: reset replay/races, revoked JWT, admin OTP, reports ACL and analytics dedupe", {
  skip: !process.env.TEST_MONGODB_URI ? "Set TEST_MONGODB_URI for isolated account-security API tests" : false,
  timeout: 60000
}, async (t) => {
  process.env.JWT_SECRET = "test-account-security-secret";
  process.env.CLIENT_URL = "https://taskspot.test";
  process.env.NODE_ENV = "test";
  const uri = new URL(process.env.TEST_MONGODB_URI);
  uri.pathname = "/ts_security_" + crypto.randomBytes(6).toString("hex");
  await mongoose.connect(uri.toString());
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await User.init(); await ProductEvent.init();
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = "http://127.0.0.1:" + server.address().port + "/api";
  async function request(path, body, token, method = body ? "POST" : "GET") {
    const response = await fetch(base + path, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  }
  const user = await User.create({ name: "Regular", email: "user@example.test", passwordHash: await bcrypt.hash("Old-password-12", 12), emailVerifiedAt: new Date() });
  const oldToken = sessionToken(user);
  assert.equal((await request("/auth/login", { email: "admin@taskspot.ru", password: "qwerty" })).status, 401);
  assert.equal(await User.countDocuments({ isSuperAdmin: true }), 0);
  const known = await request("/auth/password/forgot", { email: user.email });
  const unknown = await request("/auth/password/forgot", { email: "absent@example.test" });
  assert.deepEqual(known, unknown);
  const stored = await User.findById(user._id).select("+passwordReset");
  const resetToken = new URL(stored.passwordReset.outbox.mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  const results = await Promise.all([request("/auth/password/reset", { token: resetToken, password: "New-password-34" }), request("/auth/password/reset", { token: resetToken, password: "New-password-34" })]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 400]);
  assert.equal((await request("/auth/me", null, oldToken)).status, 401);
  const login = await request("/auth/login", { email: user.email, password: "New-password-34" });
  assert.equal(login.status, 200);
  const regularToken = login.data.token;
  await request("/auth/password/forgot", { email: user.email });
  const expired = await User.findById(user._id).select("+passwordReset");
  const expiredToken = new URL(expired.passwordReset.outbox.mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  await User.updateOne({ _id: user._id }, { $set: { "passwordReset.expiresAt": new Date(0) } });
  assert.equal((await request("/auth/password/reset", { token: expiredToken, password: "New-password-56" })).status, 400);

  await setupAdmin({ email: "secure-admin@example.test", password: "Strong-admin-123!" });
  const admin = await User.findOne({ email: "secure-admin@example.test" });
  assert.equal((await request("/analytics/product", null, sessionToken(admin))).status, 401);
  const start = await request("/auth/login", { email: admin.email, password: "Strong-admin-123!" });
  assert.equal(start.status, 200); assert.equal(start.data.token, undefined);
  const challenge = (await User.findById(admin._id).select("+adminChallenge")).adminChallenge;
  const code = challenge.outbox.mail.text.match(/\d{6}/)[0];
  const adminLogin = await request("/auth/login/code", { challengeId: start.data.challengeId, code });
  assert.equal(adminLogin.status, 200);
  assert.equal((await request("/auth/login/code", { challengeId: start.data.challengeId, code })).status, 400);
  assert.equal((await request("/analytics/product", null, regularToken)).status, 403);
  assert.equal((await request("/analytics/product", null, adminLogin.data.token)).status, 200);
  const second = await request("/auth/login", { email: admin.email, password: "Strong-admin-123!" });
  const secondCode = (await User.findById(admin._id).select("+adminChallenge")).adminChallenge.outbox.mail.text.match(/\d{6}/)[0];
  const wrongCode = secondCode === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i += 1) assert.equal((await request("/auth/login/code", { challengeId: second.data.challengeId, code: wrongCode })).status, 400);
  assert.equal((await request("/auth/login/code", { challengeId: second.data.challengeId, code: secondCode })).status, 400);

  const outsider = await User.create({ name: "Outsider", email: "other@example.test", passwordHash: "unused" });
  const project = await Project.create({ name: "Shared", createdBy: outsider._id, members: [{ user: outsider._id, role: "admin" }, { user: user._id, role: "member" }] });
  const hidden = await Project.create({ name: "Private", createdBy: outsider._id, members: [{ user: outsider._id, role: "admin" }] });
  await Task.create({ description: "Hidden task", project: project._id, creator: outsider._id });
  await Task.create({ description: "Visible task", project: project._id, creator: user._id });
  const report = await request("/reports/period", null, regularToken);
  assert.equal(report.status, 200); assert.equal(report.data.summary.created, 1);
  assert.equal((await request("/reports/period?projectId=" + hidden._id, null, regularToken)).status, 403);
  assert.equal((await request("/reports/period?from=invalid", null, regularToken)).status, 400);
  await Promise.all(Array.from({ length: 4 }, () => request("/analytics/events", { event: "active_day" }, regularToken)));
  assert.equal(await ProductEvent.countDocuments({ user: user._id, event: "active_day" }), 1);
  assert.equal((await request("/analytics/events", { event: "arbitrary" }, regularToken)).status, 400);
});
