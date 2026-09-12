import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import mongoose from "mongoose";

function testDatabaseUri() {
  const source = process.env.TEST_MONGODB_URI;
  if (!source) return "";
  const url = new URL(source);
  url.pathname = `/ts_mobile_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  return url.toString();
}

if (!process.env.TEST_MONGODB_URI) {
  test("mobile API integration", { skip: "Set TEST_MONGODB_URI to run database-backed mobile API tests" }, () => {});
} else {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-mobile-secret";
  process.env.CLIENT_URL = "https://taskspot.test";
  process.env.EXPO_PUSH_ENABLED = "false";
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;

  const { createApp } = await import("../src/app.js");
  let server;
  let baseUrl;

  async function request(path, { method = "GET", token, body, headers = {} } = {}) {
    const response = await fetch(baseUrl + path, {
      method,
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined
    });
    return { response, data: await response.json().catch(() => ({})) };
  }

  before(async () => {
    await mongoose.connect(testDatabaseUri(), { serverSelectionTimeoutMS: 10000 });
    server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  test("mobile auth, cursor feed, idempotency and optimistic concurrency", async () => {
    const suffix = Date.now().toString(36);
    const registered = await request("/api/mobile/v1/auth/register", {
      method: "POST",
      body: { name: "Анна", lastName: "Мобильная", email: `mobile_${suffix}@example.com`, password: "password123" }
    });
    assert.equal(registered.response.status, 201, registered.data.message);
    const verified = await request("/api/mobile/v1/auth/email/verify", {
      method: "POST",
      body: { token: registered.data.verificationToken, installationId: "test-device", platform: "ios" }
    });
    assert.equal(verified.response.status, 200, verified.data.message);
    assert.ok(verified.data.accessToken);
    assert.ok(verified.data.refreshToken);

    const createdProject = await request("/api/projects", {
      method: "POST", token: verified.data.accessToken, body: { name: "Mobile project" }
    });
    assert.equal(createdProject.response.status, 201, createdProject.data.message);
    const projectId = createdProject.data.project._id;
    const mutationHeaders = { "Idempotency-Key": `create-${suffix}` };
    const created = await request("/api/mobile/v1/tasks", {
      method: "POST", token: verified.data.accessToken, headers: mutationHeaders,
      body: { projectId, description: "Создано с телефона", assignee: verified.data.user._id }
    });
    assert.equal(created.response.status, 201, created.data.message);
    assert.equal(created.data.task.version, 0);
    const duplicate = await request("/api/mobile/v1/tasks", {
      method: "POST", token: verified.data.accessToken, headers: mutationHeaders,
      body: { projectId, description: "Не должно дублироваться", assignee: verified.data.user._id }
    });
    assert.equal(duplicate.response.status, 201);
    assert.equal(duplicate.data.task._id, created.data.task._id);

    const feed = await request("/api/mobile/v1/feed?scope=assigned&focus=active&limit=1", { token: verified.data.accessToken });
    assert.equal(feed.response.status, 200, feed.data.message);
    assert.equal(feed.data.items.length, 1);

    const started = await request(`/api/mobile/v1/tasks/${created.data.task._id}/status`, {
      method: "PATCH", token: verified.data.accessToken,
      headers: { "Idempotency-Key": `status-${suffix}`, "If-Match": '"0"' }, body: { status: "in_progress" }
    });
    assert.equal(started.response.status, 200, started.data.message);
    assert.equal(started.data.task.version, 1);
    const stale = await request(`/api/mobile/v1/tasks/${created.data.task._id}/status`, {
      method: "PATCH", token: verified.data.accessToken,
      headers: { "Idempotency-Key": `stale-${suffix}`, "If-Match": '"0"' }, body: { status: "review" }
    });
    assert.equal(stale.response.status, 409);

    const refreshed = await request("/api/mobile/v1/auth/refresh", { method: "POST", body: { refreshToken: verified.data.refreshToken } });
    assert.equal(refreshed.response.status, 200, refreshed.data.message);
    const reused = await request("/api/mobile/v1/auth/refresh", { method: "POST", body: { refreshToken: verified.data.refreshToken } });
    assert.equal(reused.response.status, 401);
  });
}
