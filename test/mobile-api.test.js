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
  const { DeviceSession } = await import("../src/models/DeviceSession.js");
  const { MobileMutationReceipt } = await import("../src/models/MobileMutationReceipt.js");
  const { Organization } = await import("../src/models/Organization.js");
  const { Project } = await import("../src/models/Project.js");
  const { Task } = await import("../src/models/Task.js");
  const { User } = await import("../src/models/User.js");
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
      body: { name: "Анна", lastName: "Мобильная", email: `mobile_${suffix}@example.com`, password: "password123", termsAccepted: true, termsVersion: "2026-09-20" }
    });
    assert.equal(registered.response.status, 201, registered.data.message);
    const verified = await request("/api/mobile/v1/auth/email/verify", {
      method: "POST",
      body: { token: registered.data.verificationToken, installationId: "test-device", platform: "ios" }
    });
    assert.equal(verified.response.status, 200, verified.data.message);
    assert.ok(verified.data.accessToken);
    assert.ok(verified.data.refreshToken);

    const invalidProfile = await request("/api/mobile/v1/auth/me", {
      method: "PATCH", token: verified.data.accessToken,
      body: { name: "Анна", lastName: "", phone: "", avatarUrl: "" }
    });
    assert.equal(invalidProfile.response.status, 400);
    const updatedProfile = await request("/api/mobile/v1/auth/me", {
      method: "PATCH", token: verified.data.accessToken,
      body: { name: "Анна", lastName: "Иванова", phone: "+7 999 000-00-00", avatarUrl: "data:image/jpeg;base64,/9j/2Q==" }
    });
    assert.equal(updatedProfile.response.status, 200, updatedProfile.data.message);
    assert.equal(updatedProfile.data.user.lastName, "Иванова");
    assert.equal(updatedProfile.data.user.phone, "+7 999 000-00-00");
    assert.equal(updatedProfile.data.user.avatarUrl, "data:image/jpeg;base64,/9j/2Q==");

    const createdProject = await request("/api/projects", {
      method: "POST", token: verified.data.accessToken, body: { name: "Mobile project" }
    });
    assert.equal(createdProject.response.status, 201, createdProject.data.message);
    const projectId = createdProject.data.project._id;
    const mutationHeaders = { "Idempotency-Key": `create-${suffix}` };
    const createBody = { projectId, description: "Создано с телефона", assignee: verified.data.user._id };
    const created = await request("/api/mobile/v1/tasks", {
      method: "POST", token: verified.data.accessToken, headers: mutationHeaders,
      body: createBody
    });
    assert.equal(created.response.status, 201, created.data.message);
    assert.equal(created.data.task.version, 0);
    const duplicate = await request("/api/mobile/v1/tasks", {
      method: "POST", token: verified.data.accessToken, headers: mutationHeaders,
      body: createBody
    });
    assert.equal(duplicate.response.status, 201);
    assert.equal(duplicate.data.task._id, created.data.task._id);
    await MobileMutationReceipt.deleteOne({ user: verified.data.user._id, key: mutationHeaders["Idempotency-Key"] });
    const replayAfterReceiptLoss = await request("/api/mobile/v1/tasks", {
      method: "POST", token: verified.data.accessToken, headers: mutationHeaders, body: createBody
    });
    assert.equal(replayAfterReceiptLoss.response.status, 201);
    assert.equal(replayAfterReceiptLoss.data.task._id, created.data.task._id);
    const reusedForDifferentRequest = await request("/api/mobile/v1/tasks", {
      method: "POST", token: verified.data.accessToken, headers: mutationHeaders,
      body: { ...createBody, description: "Не должно выполняться" }
    });
    assert.equal(reusedForDifferentRequest.response.status, 409);
    assert.equal(reusedForDifferentRequest.data.code, "IDEMPOTENCY_KEY_REUSED");

    const feed = await request("/api/mobile/v1/feed?scope=assigned&focus=active&limit=1", { token: verified.data.accessToken });
    assert.equal(feed.response.status, 200, feed.data.message);
    assert.equal(feed.data.items.length, 1);
    assert.deepEqual(feed.data.items[0].capabilities.statusTransitions, [{ status: "in_progress" }, { status: "review" }]);

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

    const detail = await request(`/api/mobile/v1/tasks/${created.data.task._id}`, { token: verified.data.accessToken });
    assert.equal(detail.response.status, 200, detail.data.message);
    assert.deepEqual(detail.data.task.comments, []);
    assert.deepEqual(detail.data.task.activities, []);
    assert.equal(detail.data.task.timelineCounts.activities >= 2, true);
    const firstHistory = await request(`/api/mobile/v1/tasks/${created.data.task._id}/activities?limit=1`, { token: verified.data.accessToken });
    assert.equal(firstHistory.data.items.length, 1);
    assert.ok(firstHistory.data.nextCursor);
    const secondHistory = await request(`/api/mobile/v1/tasks/${created.data.task._id}/activities?limit=1&cursor=${firstHistory.data.nextCursor}`, { token: verified.data.accessToken });
    assert.equal(secondHistory.data.items.length, 1);
    assert.notEqual(firstHistory.data.items[0]._id, secondHistory.data.items[0]._id);

    const commented = await request(`/api/mobile/v1/tasks/${created.data.task._id}/comments`, {
      method: "POST", token: verified.data.accessToken,
      headers: { "Idempotency-Key": `comment-${suffix}`, "If-Match": '"1"' }, body: { text: "Готово к проверке" }
    });
    assert.equal(commented.response.status, 201, commented.data.message);
    const commentPage = await request(`/api/mobile/v1/tasks/${created.data.task._id}/comments?limit=1`, { token: verified.data.accessToken });
    assert.equal(commentPage.data.items.length, 1);
    assert.equal(commentPage.data.items[0].text, "Готово к проверке");

    const edited = await request(`/api/mobile/v1/tasks/${created.data.task._id}/fields`, {
      method: "PATCH", token: verified.data.accessToken,
      headers: { "If-Match": '"2"' }, body: { priority: "high", dueDate: "2026-09-20" }
    });
    assert.equal(edited.response.status, 200, edited.data.message);
    assert.equal(edited.data.task.priority, "high");
    assert.equal(edited.data.task.version, 3);
    const staleEdit = await request(`/api/mobile/v1/tasks/${created.data.task._id}/fields`, {
      method: "PATCH", token: verified.data.accessToken,
      headers: { "If-Match": '"2"' }, body: { priority: "low" }
    });
    assert.equal(staleEdit.response.status, 409);
    const invalidDate = await request(`/api/mobile/v1/tasks/${created.data.task._id}/fields`, {
      method: "PATCH", token: verified.data.accessToken,
      headers: { "If-Match": '"3"' }, body: { dueDate: "2026-02-30" }
    });
    assert.equal(invalidDate.response.status, 400);

    const review = await request(`/api/mobile/v1/tasks/${created.data.task._id}/status`, {
      method: "PATCH", token: verified.data.accessToken,
      headers: { "Idempotency-Key": `review-${suffix}`, "If-Match": '"3"' }, body: { status: "review" }
    });
    assert.equal(review.response.status, 200, review.data.message);
    const closed = await request(`/api/mobile/v1/tasks/${created.data.task._id}/status`, {
      method: "PATCH", token: verified.data.accessToken,
      headers: { "Idempotency-Key": `close-${suffix}`, "If-Match": '"4"' }, body: { status: "closed" }
    });
    assert.equal(closed.response.status, 200, closed.data.message);
    const closedFeed = await request("/api/mobile/v1/feed?focus=closed", { token: verified.data.accessToken });
    assert.equal(closedFeed.data.items.some((item) => item._id === created.data.task._id), true);

    await Task.insertMany(Array.from({ length: 50 }, (_, index) => ({
      project: projectId,
      creator: verified.data.user._id,
      description: `Задача лимита ${index + 1}`
    })));
    const limitKey = `limit-${suffix}`;
    const limitBody = { projectId, description: "Создастся после повышения тарифа" };
    const blockedByPlan = await request("/api/mobile/v1/tasks", {
      method: "POST", token: verified.data.accessToken,
      headers: { "Idempotency-Key": limitKey }, body: limitBody
    });
    assert.equal(blockedByPlan.response.status, 402);
    assert.equal(blockedByPlan.data.code, "limit_exceeded");
    assert.equal(await MobileMutationReceipt.exists({ user: verified.data.user._id, key: limitKey }), null);

    const project = await Project.findById(projectId);
    await Organization.updateOne(
      { _id: project.organization },
      { plan: "team", planSource: "manual", planExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) }
    );
    const retriedAfterUpgrade = await request("/api/mobile/v1/tasks", {
      method: "POST", token: verified.data.accessToken,
      headers: { "Idempotency-Key": limitKey }, body: limitBody
    });
    assert.equal(retriedAfterUpgrade.response.status, 201, retriedAfterUpgrade.data.message);

    const control = await request(`/api/mobile/v1/control/summary?projectId=${projectId}`, { token: verified.data.accessToken });
    assert.equal(control.data.mode, "team");

    const refreshed = await request("/api/mobile/v1/auth/refresh", { method: "POST", body: { refreshToken: verified.data.refreshToken } });
    assert.equal(refreshed.response.status, 200, refreshed.data.message);
    const reused = await request("/api/mobile/v1/auth/refresh", { method: "POST", body: { refreshToken: verified.data.refreshToken } });
    assert.equal(reused.response.status, 401);

    const missingConfirmation = await request("/api/mobile/v1/auth/me", {
      method: "DELETE", token: refreshed.data.accessToken, body: { password: "password123", confirmation: "удалить" }
    });
    assert.equal(missingConfirmation.response.status, 400);
    const wrongPassword = await request("/api/mobile/v1/auth/me", {
      method: "DELETE", token: refreshed.data.accessToken, body: { password: "wrong-password", confirmation: "УДАЛИТЬ" }
    });
    assert.equal(wrongPassword.response.status, 403);
    const deleted = await request("/api/mobile/v1/auth/me", {
      method: "DELETE", token: refreshed.data.accessToken, body: { password: "password123", confirmation: "УДАЛИТЬ" }
    });
    assert.equal(deleted.response.status, 200, deleted.data.message);
    assert.equal(deleted.data.ok, true);

    const deletedUser = await User.findById(verified.data.user._id);
    assert.equal(deletedUser.status, "inactive");
    assert.equal(deletedUser.name, "Удалённый");
    assert.equal(deletedUser.lastName, "пользователь");
    assert.equal(deletedUser.phone, "");
    assert.equal(deletedUser.avatarUrl, "");
    assert.match(deletedUser.email, /^deleted-.+@deleted\.taskspot\.invalid$/);
    assert.ok(deletedUser.deletedAt);
    assert.equal(await DeviceSession.countDocuments({ user: verified.data.user._id }), 0);
    assert.equal(await Project.countDocuments({ _id: projectId }), 0);
    assert.equal(await Task.countDocuments({ project: projectId }), 0);

    const afterDeletion = await request("/api/mobile/v1/bootstrap", { token: refreshed.data.accessToken });
    assert.equal(afterDeletion.response.status, 401);
    const refreshAfterDeletion = await request("/api/mobile/v1/auth/refresh", {
      method: "POST", body: { refreshToken: refreshed.data.refreshToken }
    });
    assert.equal(refreshAfterDeletion.response.status, 401);
  });
}
