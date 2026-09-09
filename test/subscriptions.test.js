import assert from "node:assert/strict";
import test from "node:test";
import { addCalendarMonths, transitionFor } from "../src/services/subscriptions.js";

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
