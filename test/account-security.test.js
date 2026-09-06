import assert from "node:assert/strict";
import { test } from "node:test";
import { User } from "../src/models/User.js";
import { strongPassword, validSession, requestPasswordReset, resetPassword, hashToken, startAdminChallenge, finishAdminChallenge } from "../src/services/accountSecurity.js";
import { setupAdmin } from "../src/services/adminSetup.js";
const now = new Date("2026-09-01T10:00:00Z");
test("password strength rejects bootstrap credentials and bcrypt truncation", () => {
  for (const value of ["admin", "qwerty", "password", "12345678", null, {}, "я".repeat(40) + "1"]) assert.equal(strongPassword(value), false);
  assert.equal(strongPassword("password123"), true);
  assert.equal(strongPassword("password123", true), false);
  assert.equal(strongPassword("Strong-admin-123!", true), true);
});
test("session revocation preserves legacy regular tokens but requires admin email proof", () => {
  assert.equal(validSession({}, {}), true);
  assert.equal(validSession({ sessionVersion: 1 }, {}), false);
  assert.equal(validSession({ isSuperAdmin: true }, {}), false);
  assert.equal(validSession({ isSuperAdmin: true }, { amr: "email_otp" }), true);
});
test("security fields and outbox are never serialized", () => {
  const user = new User({ name: "Test", email: "test@example.test", passwordHash: "secret", sessionVersion: 3,
    passwordReset: { tokenHash: "secret", outbox: { mail: "secret" } }, adminChallenge: { tokenHash: "secret" } });
  const json = user.toJSON();
  for (const field of ["passwordHash", "passwordReset", "adminChallenge", "sessionVersion"]) assert.equal(json[field], undefined);
});
test("unknown, blocked and unverified accounts produce no password mail", async (t) => {
  for (const user of [null, { status: "blocked", emailVerificationStatus: "verified" }, { status: "active", emailVerificationStatus: "pending" }]) {
    const find = t.mock.method(User, "findOne", async () => user);
    const update = t.mock.method(User, "updateOne", async () => { throw Error("must not send"); });
    assert.equal(await requestPasswordReset("UNKNOWN@example.test", now), undefined);
    assert.equal(find.mock.calls[0].arguments[0].email, "unknown@example.test");
    assert.equal(update.mock.callCount(), 0);
    find.mock.restore(); update.mock.restore();
  }
});
test("reset token, expiration and durable email intent are one atomic write", async (t) => {
  t.mock.method(User, "findOne", async () => ({ _id: "user", email: "test@example.test", status: "active", emailVerificationStatus: "verified" }));
  const update = t.mock.method(User, "updateOne", async () => ({ modifiedCount: 1 }));
  await requestPasswordReset("test@example.test", now);
  const [filter, change] = update.mock.calls[0].arguments;
  assert.equal(filter.$or[1]["passwordReset.requestedAt"].$lte.getTime(), now.getTime() - 60000);
  const reset = change.$set.passwordReset;
  const token = new URL(reset.outbox.mail.text.match(/https?:\/\/\S+/)[0]).searchParams.get("token");
  assert.equal(reset.tokenHash, hashToken(token));
  assert.equal(reset.expiresAt.getTime(), now.getTime() + 1800000);
  assert.equal(reset.outbox.context.kind, "password_reset");
});
test("reset uses token-and-expiry CAS, rotates sessions, and rejects malformed input", async (t) => {
  const find = t.mock.method(User, "findOne", async () => ({ _id: "user" }));
  const update = t.mock.method(User, "findOneAndUpdate", async () => ({ _id: "user" }));
  assert.equal(await resetPassword({}, "password123", now), null);
  assert.equal(find.mock.callCount(), 0);
  await assert.rejects(resetPassword("a".repeat(64), "weak", now), /Пароль/);
  await resetPassword("a".repeat(64), "Password-123!", now);
  const [filter, change] = update.mock.calls[0].arguments;
  assert.equal(filter["passwordReset.tokenHash"], hashToken("a".repeat(64)));
  assert.equal(filter["passwordReset.expiresAt"].$gt, now);
  assert.equal(change.$inc.sessionVersion, 1);
  assert.deepEqual(Object.keys(change.$unset).sort(), ["adminChallenge", "passwordReset"]);
});
test("admin challenge has no session token and enforces send cooldown", async (t) => {
  const update = t.mock.method(User, "updateOne", async () => ({ modifiedCount: 1 }));
  const result = await startAdminChallenge({ _id: "admin", email: "admin@example.test", passwordHash: "old" }, now);
  assert.equal(result.requiresAdminCode, true); assert.equal(result.token, undefined); assert.equal(result.code, undefined);
  const [filter, change] = update.mock.calls[0].arguments;
  assert.equal(filter.passwordHash, "old");
  const challenge = change.$set.adminChallenge;
  assert.equal(challenge.attempts, 0);
  assert.equal(challenge.expiresAt.getTime(), now.getTime() + 600000);
  update.mock.mockImplementation(async () => ({ modifiedCount: 0 }));
  await assert.rejects(startAdminChallenge({ _id: "admin" }, now), /Подождите/);
});
test("admin code checking reserves attempts before comparison and consumes correct code once", async (t) => {
  const id = "b".repeat(64), code = "123456";
  const update = t.mock.method(User, "findOneAndUpdate", () => ({ select: async () => ({ _id: "admin", adminChallenge: { tokenHash: hashToken(id + ":" + code) } }) }));
  assert.equal(await finishAdminChallenge(id, "000000", now), null);
  assert.equal(update.mock.callCount(), 1);
  assert.equal(update.mock.calls[0].arguments[0]["adminChallenge.attempts"].$lt, 5);
  assert.equal(update.mock.calls[0].arguments[1].$inc["adminChallenge.attempts"], 1);
  update.mock.mockImplementation((filter, change) => change.$inc
    ? { select: async () => ({ _id: "admin", adminChallenge: { tokenHash: hashToken(id + ":" + code) } }) }
    : Promise.resolve({ _id: "admin", isSuperAdmin: true }));
  const user = await finishAdminChallenge(id, code, now);
  assert.equal(user.isSuperAdmin, true);
  assert.deepEqual(update.mock.calls[2].arguments[1].$unset, { adminChallenge: "" });
});
test("admin setup never silently promotes existing users or unblocks accounts", async (t) => {
  t.mock.method(User, "findOne", async () => ({ _id: "user", status: "active", isSuperAdmin: false }));
  await assert.rejects(setupAdmin({ email: "admin@example.test", password: "Strong-admin-123!" }), /--promote/);
  await assert.rejects(setupAdmin({ email: "admin@example.test", password: "qwerty", promote: true }), /ADMIN_PASSWORD/);
});
