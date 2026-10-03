import assert from "node:assert/strict";
import { test } from "node:test";
import mongoose from "mongoose";
import nodemailer from "nodemailer";
import { EmailJob } from "../src/models/EmailJob.js";
import { User } from "../src/models/User.js";
import { Project } from "../src/models/Project.js";
import { Task } from "../src/models/Task.js";
import { enqueueEmail } from "../src/services/emailQueue.js";
import { persistEmailWith, transferEmailIntent } from "../src/services/emailOutbox.js";
import { processEmailJob, reconcileEmailStatuses, syncEmailStatus } from "../src/services/emailWorker.js";
import { deliverMail, sendEmailVerificationEmail } from "../src/services/email.js";

const now = new Date("2026-09-01T10:00:00Z");
const finished = new Date("2026-09-01T10:03:00Z");
const validMail = (to = "test@example.com") => ({ to, subject: "Test", text: "Test message" });
const verificationContext = (overrides = {}) => ({
  kind: "verification", userId: "user", tokenHash: "token-hash", dedupeKey: "verification-test", ...overrides
});

test("verification token and email intent are saved together; private outbox is not serialized", async (t) => {
  const user = new User({ name: "Test", email: "test@example.com", passwordHash: "hash", emailVerificationTokenHash: "token-hash" });
  let saves = 0;
  t.mock.method(user, "save", async () => {
    saves += 1;
    assert.equal(user.emailVerificationTokenHash, "token-hash");
    assert.match(user.emailOutbox.mail.text, /secret-link/);
    return user;
  });
  const result = await sendEmailVerificationEmail({ email: user.email, name: user.name, verificationUrl: "https://example.com/secret-link",
    context: { kind: "verification", userId: "user", tokenHash: "token-hash", dedupeKey: "verify-user-token" },
    dispatch: persistEmailWith(user, "emailOutbox") });
  assert.equal(result.queued, true);
  assert.equal(saves, 1);
  assert.equal(user.emailOutbox.context.dedupeKey, "verify-user-token");
  assert.equal(JSON.stringify(user).includes("secret-link"), false);
});

test("project invitation and membership intents are hidden even immediately after save", async () => {
  const id = new mongoose.Types.ObjectId();
  const project = new Project({ name: "Project", members: [{ user: id, emailOutbox: { mail: "secret-member" } }],
    invitations: [{ email: "invite@example.com", invitedBy: id, emailOutbox: { mail: "secret-invite" } }] });
  assert.equal(JSON.stringify(project).includes("secret-"), false);
  assert.equal(Project.schema.path("invitations").schema.path("emailOutbox").options.select, false);
});

test("a failed queue insert leaves the durable source intent for the next worker", async (t) => {
  t.mock.method(EmailJob, "findOneAndUpdate", async () => { throw new Error("database unavailable"); });
  let clears = 0;
  const Model = { updateOne: async () => { clears += 1; } };
  await assert.rejects(transferEmailIntent(Model, { _id: "user", "emailOutbox.key": "key" }, "emailOutbox",
    { mail: validMail(), context: verificationContext({ dedupeKey: "key" }) }));
  assert.equal(clears, 0);
});

test("crash after queue insert is recovered with the same dedupe key and message ID", async (t) => {
  const stored = new Map();
  const messages = [];
  t.mock.method(EmailJob, "findOneAndUpdate", async (filter, update) => {
    messages.push(update.$setOnInsert.messageId);
    if (!stored.has(filter.dedupeKey)) stored.set(filter.dedupeKey, { _id: "job", status: "queued" });
    return stored.get(filter.dedupeKey);
  });
  let clears = 0;
  const filter = { _id: "user", "emailOutbox.key": "key" };
  const Model = { updateOne: async (query, update) => {
    assert.deepEqual(query, filter);
    assert.deepEqual(update, { $unset: { emailOutbox: "" } });
    if (++clears === 1) throw new Error("crash before clearing");
  } };
  const intent = { mail: validMail(), context: verificationContext({ dedupeKey: "key" }) };
  await assert.rejects(transferEmailIntent(Model, filter, "emailOutbox", intent));
  await transferEmailIntent(Model, filter, "emailOutbox", intent);
  assert.equal(stored.size, 1);
  assert.equal(messages[0], messages[1]);
});

test("deduplicated accepted and failed jobs do not falsely report queued", async (t) => {
  for (const status of ["accepted", "failed", "cancelled", "processing"]) {
    const mock = t.mock.method(EmailJob, "findOneAndUpdate", async () => ({ _id: "job", status }));
    const result = await enqueueEmail(validMail(), verificationContext({ dedupeKey: "same" }));
    assert.equal(result.queued, status === "processing");
    assert.equal(result.failed, ["failed", "cancelled"].includes(status));
    mock.mock.restore();
  }
  t.mock.method(EmailJob, "findOneAndUpdate", async () => { throw { code: 11000 }; });
  t.mock.method(EmailJob, "findOne", async () => ({ _id: "job", status: "accepted" }));
  assert.equal((await enqueueEmail(validMail(), verificationContext({ dedupeKey: "same" }))).status, "accepted");
});

function mockWorker(t, overrides = {}, loseLock = false) {
  const job = { _id: "job", messageId: "<stable@taskspot.ru>", attempts: 1,
    context: verificationContext(), mail: { to: "test@example.com", subject: "Test", text: "secret-token" }, ...overrides };
  let saved;
  let claim;
  t.mock.method(EmailJob, "findOneAndUpdate", (filter, update, options) => {
    if (options.sort) {
      claim = { filter, update };
      return { select: async () => job };
    }
    assert.equal(filter.lockToken, claim.update.$set.lockToken);
    assert.equal(filter.status, "processing");
    saved = { ...job, ...update.$set };
    return Promise.resolve(loseLock ? null : saved);
  });
  t.mock.method(EmailJob, "updateOne", async () => ({}));
  t.mock.method(User, "updateOne", async () => ({}));
  t.mock.method(User, "exists", async () => ({ _id: "user" }));
  t.mock.method(Project, "updateOne", async () => ({}));
  return { saved: () => saved, claim: () => claim };
}

test("temporary SMTP errors retry after completion, not after claim time", async (t) => {
  const worker = mockWorker(t);
  await processEmailJob({ now, clock: () => finished, send: async () => { throw { code: "ETIMEDOUT" }; } });
  assert.equal(worker.saved().status, "queued");
  assert.equal(worker.saved().nextAttemptAt.toISOString(), "2026-09-01T10:04:00.000Z");
});

test("database relevance failures do not consume SMTP attempts or discard the job", async (t) => {
  const worker = mockWorker(t);
  User.exists.mock.mockImplementation(async () => { throw new Error("database unavailable, secret"); });
  let sends = 0;
  await processEmailJob({ now, clock: () => finished, send: async () => { sends += 1; } });
  assert.equal(sends, 0);
  assert.equal(worker.saved().status, "queued");
  assert.equal(worker.saved().attempts, 0);
  assert.equal(worker.saved().lastErrorCode, "RELEVANCE_CHECK_FAILED");
  assert.equal(worker.saved().lastError.includes("secret"), false);
});

test("expired leases can be reclaimed; a lost lock cannot publish success", async (t) => {
  const worker = mockWorker(t, {}, true);
  const statusWrites = t.mock.method(User, "updateOne", async () => ({}));
  await processEmailJob({ now, send: async (mail) => assert.equal(mail.messageId, "<stable@taskspot.ru>") });
  assert.deepEqual(worker.claim().filter.$or[1], { status: "processing", leaseUntil: { $lte: now } });
  assert.equal(statusWrites.mock.callCount(), 0);
  assert.equal(EmailJob.updateOne.mock.callCount(), 0);
});

test("revoked invitations are cancelled without sending their link", async (t) => {
  const worker = mockWorker(t, { context: { kind: "invitation", projectId: "project", invitationId: "invite", token: "old",
    dedupeKey: "invite" } });
  t.mock.method(Project, "findById", async () => ({ invitations: { id: () => ({ status: "pending", token: "new",
    email: "test@example.com", expiresAt: finished }) } }));
  await processEmailJob({ now, send: async () => assert.fail("revoked invitation sent") });
  assert.equal(worker.saved().status, "cancelled");
  assert.equal(worker.saved().lastErrorCode, "");
  const filter = Project.updateOne.mock.calls[0].arguments[0];
  assert.equal(filter.invitations.$elemMatch.token, "old");
});

test("privacy checks reject an unknown job type", async (t) => {
  let sends = 0;
  const worker = mockWorker(t, { context: { kind: "unknown", dedupeKey: "unknown" } });
  await processEmailJob({ now, send: async () => { sends += 1; } });
  assert.equal(worker.saved().status, "cancelled");
  assert.equal(worker.saved().lastErrorCode, "EMAIL_PRIVACY_REJECTED");
  assert.equal(sends, 0);
});

test("privacy checks reject a recipient not bound to the user", async (t) => {
  let sends = 0;
  const worker = mockWorker(t, { context: verificationContext({ dedupeKey: "wrong-address" }),
    mail: validMail("stranger@example.com") });
  User.exists.mock.mockImplementation(async (filter) => filter.email === "owner@example.com" ? { _id: "user" } : null);
  await processEmailJob({ now, send: async () => { sends += 1; } });
  assert.equal(worker.saved().status, "cancelled");
  assert.equal(sends, 0);
});

test("billing alerts are delivered only to the current active super administrator", async (t) => {
  const worker = mockWorker(t, {
    context: { kind: "billing_alert", userId: "admin", orderId: "order", dedupeKey: "billing-alert" },
    mail: validMail("admin@example.com")
  });
  const filters = [];
  User.exists.mock.mockImplementation(async (filter) => {
    filters.push(filter);
    if (filter.isSuperAdmin === undefined) return { _id: "admin" };
    return filter.isSuperAdmin === true && filter.status === "active" ? { _id: "admin" } : null;
  });
  let sends = 0;
  await processEmailJob({ now, send: async () => { sends += 1; } });
  assert.equal(sends, 1);
  assert.equal(worker.saved().status, "accepted");
  assert.ok(filters.some((filter) => filter.isSuperAdmin === true && filter.email === "admin@example.com"));
});

test("privacy checks reject a task attached to another project", async (t) => {
  const worker = mockWorker(t, {
    context: { kind: "task", userId: "user", projectId: "project", taskId: "task", dedupeKey: "task-mismatch" }
  });
  t.mock.method(Project, "findById", async () => ({ _id: "project", members: [{ user: "user", role: "admin" }] }));
  t.mock.method(Task, "findById", async () => ({ _id: "task", project: "other-project", creator: "user", observers: [] }));
  let sends = 0;
  await processEmailJob({ now, send: async () => { sends += 1; } });
  assert.equal(worker.saved().status, "cancelled");
  assert.equal(worker.saved().lastErrorCode, "EMAIL_PRIVACY_REJECTED");
  assert.equal(sends, 0);
});

test("task email checks the matching user preference before delivery", async (t) => {
  const worker = mockWorker(t, {
    context: { kind: "task", userId: "user", projectId: "project", taskId: "task", event: "task_comment",
      dedupeKey: "comment-preference" }
  });
  t.mock.method(Project, "findById", async () => ({ _id: "project", members: [{ user: "user", role: "member" }] }));
  t.mock.method(Task, "findById", async () => ({ _id: "task", project: "project", creator: "user", observers: [] }));
  let preferenceFilter;
  User.exists.mock.mockImplementation(async (filter) => {
    if (filter["emailPreferences.comments"]) { preferenceFilter = filter; return null; }
    return { _id: "user" };
  });
  let sends = 0;
  await processEmailJob({ now, send: async () => { sends += 1; } });
  assert.deepEqual(preferenceFilter["emailPreferences.comments"], { $ne: false });
  assert.equal(worker.saved().status, "cancelled");
  assert.equal(sends, 0);
});

test("queue rejects multiple recipients and incomplete privacy context", async () => {
  await assert.rejects(enqueueEmail(validMail("one@example.com,two@example.com"), verificationContext()),
    (error) => error.code === "EMAIL_RECIPIENT_INVALID");
  await assert.rejects(enqueueEmail(validMail(), { kind: "task", userId: "user" }),
    (error) => error.code === "EMAIL_CONTEXT_INVALID");
});

test("one failed status reconciliation does not stop following jobs", async (t) => {
  t.mock.method(EmailJob, "find", () => ({ limit: async () => [
    { _id: "one", status: "accepted", attempts: 1, context: { kind: "verification", userId: "user" } },
    { _id: "two", status: "accepted", attempts: 1, context: {} }
  ] }));
  t.mock.method(User, "updateOne", async () => { throw new Error("unavailable"); });
  const updates = t.mock.method(EmailJob, "updateOne", async () => ({}));
  await reconcileEmailStatuses();
  assert.equal(updates.mock.callCount(), 1);
  assert.equal(updates.mock.calls[0].arguments[0]._id, "two");
});

test("an old queued snapshot cannot overwrite a terminal delivery status", async (t) => {
  const writes = t.mock.method(Project, "updateOne", async () => ({}));
  t.mock.method(EmailJob, "updateOne", async () => ({}));
  await syncEmailStatus({ _id: "job", attempts: 1, status: "queued", context: { kind: "invitation", token: "token" } });
  assert.deepEqual(writes.mock.calls[0].arguments[0].invitations.$elemMatch.emailStatus, { $nin: ["sent", "failed"] });
});

test("SMTP acceptance is checked, transport closed, and logs contain no subject or token", async (t) => {
  const env = { ...process.env };
  Object.assign(process.env, { SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", SMTP_PORTS: "465",
    SMTP_USER: "no-reply@example.com", SMTP_PASS: "secret-password", SMTP_FROM: "Taskspot <no-reply@example.com>" });
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key]; Object.assign(process.env, env); });
  const logs = [];
  for (const method of ["info", "error", "warn"]) t.mock.method(console, method, (...args) => logs.push(JSON.stringify(args)));
  let closes = 0;
  let accepted = [];
  t.mock.method(nodemailer, "createTransport", () => ({
    sendMail: async (mail) => { assert.equal(mail.subject, "private-subject"); return { accepted, messageId: mail.messageId }; },
    close: () => { closes += 1; }
  }));
  const mail = { to: "test@example.com", subject: "private-subject", text: "secret-token", messageId: "<stable@taskspot.ru>" };
  await assert.rejects(deliverMail(mail), (error) => error.responseCode === 550);
  accepted = ["other@example.com"];
  await assert.rejects(deliverMail(mail), (error) => error.responseCode === 550);
  accepted = [mail.to];
  const result = await deliverMail(mail);
  assert.equal(result.messageId, mail.messageId);
  assert.equal(closes, 3);
  assert.doesNotMatch(logs.join("\n"), /private-subject|secret-token|secret-password/);
});
