import { ServiceMetric } from "../models/ServiceMetric.js";

const pending = new Map();

function minuteBucket(date) {
  const bucket = new Date(date);
  bucket.setUTCSeconds(0, 0);
  return bucket;
}

function mergePending(metric) {
  const key = metric.bucket.toISOString();
  const current = pending.get(key);
  if (!current) {
    pending.set(key, { ...metric });
    return;
  }
  current.requests += metric.requests;
  current.clientErrors += metric.clientErrors;
  current.serverErrors += metric.serverErrors;
  current.totalDurationMs += metric.totalDurationMs;
  current.maxDurationMs = Math.max(current.maxDurationMs, metric.maxDurationMs);
}

export function recordHttpMetric({ statusCode, durationMs, at = new Date() }) {
  const bucket = minuteBucket(at);
  const key = bucket.toISOString();
  const metric = pending.get(key) || {
    bucket,
    requests: 0,
    clientErrors: 0,
    serverErrors: 0,
    totalDurationMs: 0,
    maxDurationMs: 0
  };
  const duration = Math.max(0, Math.round(Number(durationMs) || 0));
  metric.requests += 1;
  metric.clientErrors += statusCode >= 400 && statusCode < 500 ? 1 : 0;
  metric.serverErrors += statusCode >= 500 ? 1 : 0;
  metric.totalDurationMs += duration;
  metric.maxDurationMs = Math.max(metric.maxDurationMs, duration);
  pending.set(key, metric);
}

export function takePendingHttpMetrics() {
  const metrics = [...pending.values()];
  pending.clear();
  return metrics;
}

export async function flushHttpMetrics({ model = ServiceMetric } = {}) {
  const metrics = takePendingHttpMetrics();
  if (!metrics.length) return 0;
  try {
    await model.bulkWrite(metrics.map((metric) => ({
      updateOne: {
        filter: { _id: metric.bucket },
        update: {
          $setOnInsert: { bucket: metric.bucket },
          $inc: {
            requests: metric.requests,
            clientErrors: metric.clientErrors,
            serverErrors: metric.serverErrors,
            totalDurationMs: metric.totalDurationMs
          },
          $max: { maxDurationMs: metric.maxDurationMs }
        },
        upsert: true
      }
    })), { ordered: false });
  } catch (error) {
    metrics.forEach(mergePending);
    throw error;
  }
  return metrics.length;
}
