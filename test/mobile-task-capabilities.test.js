import assert from "node:assert/strict";
import { test } from "node:test";
import { assertMobileStatusTransition, mobileTaskCapabilities } from "../src/services/mobileTaskCapabilities.js";

const assignee = "507f1f77bcf86cd799439011";
const creator = "507f1f77bcf86cd799439012";
const observer = "507f1f77bcf86cd799439013";
const project = { members: [{ user: creator, role: "admin" }, { user: assignee, role: "member" }, { user: observer, role: "member" }] };

test("mobile capabilities expose only role-valid workflow actions", () => {
  const open = mobileTaskCapabilities({ creator, assignee, status: "open" }, project, assignee);
  assert.deepEqual(open.statusTransitions, [{ status: "in_progress" }, { status: "review" }]);
  assert.equal(open.canEditChecklist, true);
  assert.equal(open.canEditFields, false);

  const review = mobileTaskCapabilities({ creator, assignee, status: "review" }, project, creator);
  assert.deepEqual(review.statusTransitions, [{ status: "closed" }, { status: "in_progress", requiresComment: true }]);
});

test("mobile capabilities make archived projects read-only", () => {
  const capabilities = mobileTaskCapabilities({ creator, assignee, status: "open" }, { ...project, isArchived: true }, creator);
  assert.deepEqual(capabilities.statusTransitions, []);
  assert.equal(capabilities.canEditChecklist, false);
  assert.equal(capabilities.canComment, false);
  assert.match(capabilities.readOnlyReason, /Архивный проект/);
});

test("returning a task requires an initiator comment", () => {
  const task = { creator, assignee, status: "review" };
  assert.equal(assertMobileStatusTransition(task, project, creator, "in_progress", "").allowed, false);
  assert.equal(assertMobileStatusTransition(task, project, creator, "in_progress", "Нужно исправить").allowed, true);
  assert.equal(assertMobileStatusTransition(task, project, observer, "closed", "").allowed, false);
});
