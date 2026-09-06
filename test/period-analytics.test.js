import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePeriod, closedAt, buildPeriodReport, reportCsv, csvCell } from "../src/services/periodReports.js";
import { buildProductAnalytics } from "../src/services/productAnalytics.js";
test("periods validate real dates, maximum length, and Moscow boundaries", () => {
  const period = parsePeriod({ from: "2026-09-01", to: "2026-09-07" });
  assert.equal(period.days, 7);
  assert.equal(period.start.toISOString(), "2026-08-31T21:00:00.000Z");
  assert.equal(period.end.toISOString(), "2026-09-07T21:00:00.000Z");
  assert.equal(period.previousStart.toISOString(), "2026-08-24T21:00:00.000Z");
  for (const query of [{ from: {} }, { from: "2026-02-30" }, { from: "2026-01-01", to: "2026-09-01" }, { from: "2026-09-05", to: "2026-09-01" }]) assert.throws(() => parsePeriod(query), (error) => error.statusCode === 400);
});
test("closure comes from status history, not arbitrary edits", () => {
  assert.equal(closedAt({ status: "closed", updatedAt: new Date() }), null);
  assert.equal(closedAt({ activities: [{ action: "status_changed", to: "closed", createdAt: "2026-09-02" }] }).toISOString(), "2026-09-02T00:00:00.000Z");
});
test("reports count unique tasks, compare equal periods and exclude archived workload", () => {
  const period = parsePeriod({ from: "2026-09-01", to: "2026-09-07" });
  const report = buildPeriodReport([
    { project: "p", description: "First", createdAt: "2026-09-01", status: "closed", categories: ["a", "b"],
      activities: [{ action: "status_changed", to: "closed", createdAt: "2026-09-02" }] },
    { project: "p", createdAt: "2026-08-25", status: "closed", activities: [{ action: "status_changed", to: "closed", createdAt: "2026-08-26" }] },
    { project: "archived", createdAt: "2026-09-01", status: "open", dueDate: "2026-09-01" }
  ], [{ _id: "p", name: "Project", categories: [{ _id: "a", name: "A" }, { _id: "b", name: "B" }] }, { _id: "archived", isArchived: true }], period, new Date("2026-09-05"));
  assert.equal(report.summary.closed, 1); assert.equal(report.summary.previousClosed, 1);
  assert.equal(report.summary.active, 0); assert.equal(report.summary.overdue, 0);
  assert.equal(report.summary.averageCloseDays, 1);
  assert.equal(report.daily.find((row) => row.key === "2026-09-02").previousClosed, 1);
  assert.equal(report.categories.filter((row) => row.closed === 1).length, 2);
});
test("CSV is Excel-compatible and escapes delimiters and spreadsheet formulas", () => {
  assert.equal(csvCell('a;"b"'), '"a;""b"""');
  assert.equal(csvCell("=HYPERLINK(1)"), '"\'=HYPERLINK(1)"');
  assert.ok(csvCell("\t@SUM(1)").includes("'"));
  const csv = reportCsv({ rows: [{ task: "=danger", status: "review" }] }, "tasks");
  assert.ok(csv.startsWith("\ufeff")); assert.ok(csv.includes("На проверке")); assert.ok(csv.includes("'=danger"));
  assert.throws(() => reportCsv({}, "__proto__"), /Неизвестный/);
});
test("activation includes invited task creators and never infers visits from login timestamps", () => {
  const result = buildProductAnalytics({ users: [{ _id: "u", createdAt: "2026-09-01", emailVerifiedAt: "2026-09-01" }],
    projects: [], tasks: [{ _id: "u", at: "2026-09-02" }], payments: [], events: [], coverageStart: null });
  assert.equal(result.milestones.find((row) => row.key === "activated").value, 1);
  assert.equal(result.milestones.find((row) => row.key === "project").value, 0);
  assert.equal(result.milestones.find((row) => row.key === "returned").value, null);
  assert.equal(result.d7.percent, null);
});
test("D7 excludes immature and historical cohorts and deduplicates same-day visits", () => {
  const result = buildProductAnalytics({
    users: [{ _id: "mature", createdAt: "2026-09-01" }, { _id: "young", createdAt: "2026-09-08" }, { _id: "historic", createdAt: "2026-08-01" }],
    projects: [], tasks: [], payments: [{ _id: "mature", at: "2026-09-02" }],
    events: [{ user: "mature", event: "active_day", day: "2026-09-01" }, { user: "mature", event: "active_day", day: "2026-09-01" }, { user: "mature", event: "active_day", day: "2026-09-08" }],
    coverageStart: "2026-09-01", now: new Date("2026-09-10")
  });
  assert.deepEqual(result.d7, { eligible: 1, returned: 1, percent: 100 });
  assert.equal(result.milestones.find((row) => row.key === "paid").value, 1);
  assert.equal(result.milestones.find((row) => row.key === "returned").value, 1);
});
