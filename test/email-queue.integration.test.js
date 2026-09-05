import assert from "node:assert/strict";
import { test } from "node:test";
import mongoose from "mongoose";
import { createApp } from "../src/app.js";
import { User } from "../src/models/User.js";
import { Project } from "../src/models/Project.js";
import { EmailJob } from "../src/models/EmailJob.js";
import { drainEmailOutbox } from "../src/services/emailOutbox.js";
import { processEmailJob } from "../src/services/emailWorker.js";

test("registration and invitation outbox survive reload and concurrent drain", {
  skip: !process.env.TEST_MONGODB_URI && "Set TEST_MONGODB_URI to run isolated MongoDB email tests",
  timeout: 60000
}, async (t) => {
  const uri = new URL(process.env.TEST_MONGODB_URI);
  uri.pathname = `/ts_email_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  process.env.JWT_SECRET ||= "test-secret";
  const previousEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  t.after(() => { if (previousEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnv; });
  await mongoose.connect(uri.toString(), { serverSelectionTimeoutMS: 10000 });
  t.after(async () => { await mongoose.connection.dropDatabase(); await mongoose.disconnect(); });
  await EmailJob.init();
  const server = createApp().listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const request = async (path, body, token) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    assert.ok(response.ok, JSON.stringify(data));
    return data;
  };

  const registered = await request("/auth/register", { email: "owner@example.com", name: "Owner", lastName: "Test", password: "password123" });
  assert.equal(registered.emailDeliveryStatus, "pending");
  const savedUser = await User.findOne({ email: "owner@example.com" }).select("+emailOutbox");
  assert.ok(savedUser.emailOutbox.mail.text.includes(registered.verificationToken));
  assert.equal(await EmailJob.countDocuments(), 0);
  await Promise.all([drainEmailOutbox(), drainEmailOutbox()]);
  assert.equal(await EmailJob.countDocuments(), 1);
  assert.equal((await User.findById(savedUser._id).select("+emailOutbox")).emailOutbox, undefined);
  let sends = 0;
  await processEmailJob({ send: async () => { sends += 1; } });
  assert.equal(sends, 1);
  assert.equal((await User.findById(savedUser._id)).emailVerificationStatus, "sent");

  const verified = await request("/auth/email/verify", { token: registered.verificationToken });
  const { project } = await request("/projects", { name: "Queue test" }, verified.token);
  const invited = await request(`/projects/${project._id}/members`, { email: "new@example.com" }, verified.token);
  assert.equal(invited.email.status, "pending");
  assert.equal(JSON.stringify(invited).includes("emailOutbox"), false);
  const storedProject = await Project.findById(project._id).select("+invitations.emailOutbox");
  const invite = storedProject.invitations[0];
  assert.ok(invite.emailOutbox);
  await drainEmailOutbox();
  const staleJob = await EmailJob.findOne({ "context.invitationId": String(invite._id) });
  const resent = await request(`/projects/${project._id}/invitations/${invite._id}/resend`, {}, verified.token);
  assert.notEqual(resent.project.invitations[0].token, invite.token);
  await drainEmailOutbox();
  await processEmailJob({ send: async () => assert.fail("stale invite must be cancelled") });
  assert.equal((await EmailJob.findById(staleJob._id)).status, "cancelled");
  await processEmailJob({ send: async () => { sends += 1; } });
  assert.equal((await Project.findById(project._id)).invitations[0].emailStatus, "sent");

  const recovered = await EmailJob.create({
    dedupeKey: "interrupted-worker", messageId: "<interrupted@taskspot.ru>",
    mail: { to: "test@example.com" }, status: "processing", attempts: 1,
    leaseUntil: new Date(Date.now() - 1000), lockToken: "expired-lock"
  });
  await processEmailJob({ send: async (mail) => assert.equal(mail.messageId, recovered.messageId) });
  assert.equal((await EmailJob.findById(recovered._id)).status, "accepted");
  assert.equal(await processEmailJob({ send: async () => assert.fail("no queued mail") }), false);
});
