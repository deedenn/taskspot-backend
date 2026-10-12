import assert from "node:assert/strict";
import { test } from "node:test";
import { User } from "../src/models/User.js";
import { changeAdminEmail } from "../src/services/adminEmail.js";

test("admin email change updates the canonical recipient and revokes sessions", async (t) => {
  const admin = { _id: "admin-id" };
  t.mock.method(User, "findOne", async () => admin);
  t.mock.method(User, "exists", async () => null);
  const update = t.mock.method(User, "findOneAndUpdate", async () => ({
    _id: admin._id,
    email: "new-admin@example.test"
  }));

  const result = await changeAdminEmail({
    currentEmail: " ADMIN@TASKSPOT.RU ",
    email: " New-Admin@Example.Test "
  });

  assert.deepEqual(result, { updated: true });
  const [filter, change] = update.mock.calls[0].arguments;
  assert.equal(filter.email, "admin@taskspot.ru");
  assert.equal(change.$set.email, "new-admin@example.test");
  assert.equal(change.$set.emailVerificationStatus, "verified");
  assert.equal(change.$inc.sessionVersion, 1);
  assert.deepEqual(Object.keys(change.$unset).sort(), [
    "adminChallenge",
    "emailOutbox",
    "emailVerificationExpiresAt",
    "emailVerificationSentAt",
    "passwordReset"
  ]);
});

test("admin email change rejects a recipient owned by another account", async (t) => {
  t.mock.method(User, "findOne", async () => ({ _id: "admin-id" }));
  t.mock.method(User, "exists", async () => ({ _id: "other-id" }));
  const update = t.mock.method(User, "findOneAndUpdate", async () => {
    throw new Error("must not update");
  });

  await assert.rejects(changeAdminEmail({
    currentEmail: "admin@taskspot.ru",
    email: "new-admin@example.test"
  }), /уже используется/);
  assert.equal(update.mock.callCount(), 0);
});
