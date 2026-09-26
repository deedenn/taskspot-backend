import assert from "node:assert/strict";
import { test } from "node:test";
import { flushHttpMetrics, recordHttpMetric, takePendingHttpMetrics } from "../src/services/serviceMetrics.js";

test("HTTP metrics aggregate by minute before a single database write", async () => {
  takePendingHttpMetrics();
  const at = new Date("2026-09-22T10:15:42.000Z");
  recordHttpMetric({ statusCode: 200, durationMs: 20, at });
  recordHttpMetric({ statusCode: 404, durationMs: 30, at });
  recordHttpMetric({ statusCode: 503, durationMs: 70, at });

  let operations;
  const count = await flushHttpMetrics({
    model: { async bulkWrite(value) { operations = value; } }
  });

  assert.equal(count, 1);
  assert.equal(operations.length, 1);
  assert.equal(operations[0].updateOne.filter._id.toISOString(), "2026-09-22T10:15:00.000Z");
  assert.equal(operations[0].updateOne.update.$setOnInsert.bucket.toISOString(), "2026-09-22T10:15:00.000Z");
  assert.deepEqual(operations[0].updateOne.update.$inc, {
    requests: 3,
    clientErrors: 1,
    serverErrors: 1,
    totalDurationMs: 120
  });
  assert.deepEqual(operations[0].updateOne.update.$max, { maxDurationMs: 70 });
  assert.equal(takePendingHttpMetrics().length, 0);
});

test("failed HTTP metric flush returns the bucket to memory", async () => {
  takePendingHttpMetrics();
  recordHttpMetric({ statusCode: 500, durationMs: 15, at: new Date("2026-09-22T10:16:00.000Z") });
  await assert.rejects(() => flushHttpMetrics({ model: { async bulkWrite() { throw new Error("offline"); } } }), /offline/);
  const [metric] = takePendingHttpMetrics();
  assert.equal(metric.requests, 1);
  assert.equal(metric.serverErrors, 1);
  assert.equal(metric.maxDurationMs, 15);
});
