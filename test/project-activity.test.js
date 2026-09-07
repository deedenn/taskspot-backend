import assert from "node:assert/strict";
import { test } from "node:test";
import mongoose from "mongoose";
import { activityActor, projectChanges } from "../src/services/projectActivity.js";
import { Project } from "../src/models/Project.js";

test("project journal records creation, settings, archive and restore", () => {
  assert.equal(projectChanges(null, { name: "Project" })[0].action, "project_created");
  const changes = projectChanges({ name: "Before", isArchived: false }, { name: "After", isArchived: true });
  assert.deepEqual(changes.map((item) => item.action), ["settings_changed", "project_archived"]);
  assert.equal(changes[0].before, "Before");
  assert.equal(projectChanges({ isArchived: true }, { isArchived: false })[0].action, "project_restored");
  assert.deepEqual(projectChanges({ name: "Old" }, { name: "New" }, ["members"]), []);
});

test("journal covers invitations, members and categories without secrets", () => {
  const old = { invitations: [{ _id: "i", email: "person@example.test", token: "secret-old", role: "member", status: "pending" }], members: [{ user: "u", role: "member" }], categories: [{ _id: "c", name: "Old", color: "blue" }] };
  const next = { invitations: [{ ...old.invitations[0], token: "secret-new", emailOutbox: { password: "private" } }], members: [{ user: "u", role: "admin" }], categories: [] };
  const changes = projectChanges(old, next);
  assert.deepEqual(changes.map((item) => item.action), ["role_changed", "invitation_resent", "category_removed"]);
  assert.ok(!JSON.stringify(changes).includes("secret"));
  assert.ok(!JSON.stringify(changes).includes("private"));
  assert.equal(projectChanges(old, { ...old, invitations: [{ ...old.invitations[0], status: "accepted" }] })[0].action, "invitation_accepted");
  assert.equal(projectChanges(old, { ...old, invitations: [] })[0].action, "invitation_removed");
  assert.equal(projectChanges(old, { ...old, invitations: [{ ...old.invitations[0], emailStatus: "sent" }] }).length, 0);
  assert.equal(projectChanges({ categories: [] }, { categories: [{ _id: "c", name: "Category" }] })[0].action, "category_added");
});

test("journal normalizes populated user ids and truncates long text", () => {
  const user = new mongoose.Types.ObjectId();
  assert.deepEqual(projectChanges({ members: [{ user, role: "member" }] }, { members: [{ user: { _id: user }, role: "member" }] }), []);
  assert.equal(projectChanges({ description: "" }, { description: "x".repeat(2000) })[0].after.length, 500);
  assert.equal(activityActor({ _id: user, name: "Имя", lastName: "Фамилия" }).name, "Имя Фамилия");
});

test("ordinary project JSON never exposes audit or template idempotency data", () => {
  const project = new Project({ name: "Private", auditLog: [{ action: "member_added", target: "email@example.test" }], templateCreationKey: "secret", templateCreationDigest: "digest" });
  assert.equal(project.toJSON().auditLog, undefined);
  assert.equal(project.toJSON().templateCreationKey, undefined);
  assert.equal(project.toJSON().templateCreationDigest, undefined);
  assert.equal(Project.schema.options.optimisticConcurrency, true);
});
