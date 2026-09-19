import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarMonths, transitionFor } from "../src/services/subscriptions.js";
import { limitExceeded } from "../src/services/plans.js";
import { PLAN_VERSION, PLANS, publicPlan } from "../src/services/planCatalog.js";

test("current plan catalog applies the new project and attachment limits", () => {
  assert.equal(PLAN_VERSION, 2);
  assert.equal(PLANS.free.limits.attachments, 5);
  assert.equal(PLANS.team.limits.projects, 10);
  assert.equal(PLANS.team.limits.attachments, 100);
  assert.equal(publicPlan(PLANS.team).limits.projects, 10);
  assert.equal(limitExceeded({ plan: PLANS.free, usage: { attachments: 4 }, key: "attachments" }), false);
  assert.equal(limitExceeded({ plan: PLANS.free, usage: { attachments: 5 }, key: "attachments" }), true);
  assert.equal(limitExceeded({ plan: PLANS.team, usage: { projects: 10 }, key: "projects" }), true);
  assert.equal(limitExceeded({ plan: PLANS.team, usage: { attachments: 100 }, key: "attachments" }), true);
});

test("subscription calendar months clamp the last day without drifting", () => {
  assert.equal(
    addCalendarMonths(new Date("2025-01-31T10:15:00.000Z"), 1).toISOString(),
    "2025-02-28T10:15:00.000Z"
  );
  assert.equal(
    addCalendarMonths(new Date("2024-01-31T10:15:00.000Z"), 1).toISOString(),
    "2024-02-29T10:15:00.000Z"
  );
  assert.equal(
    addCalendarMonths(new Date("2025-12-31T23:00:00.000Z"), 3).toISOString(),
    "2026-03-31T23:00:00.000Z"
  );
});

test("subscription transition policy distinguishes activation, renewal, upgrade and downgrade", () => {
  assert.equal(transitionFor("free", "team"), "activate");
  assert.equal(transitionFor("team", "team"), "renew");
  assert.equal(transitionFor("team", "business"), "upgrade");
  assert.equal(transitionFor("business", "team"), "downgrade");
});
