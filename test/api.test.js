import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import mongoose from "mongoose";

function testDatabaseUri() {
  const source = process.env.TEST_MONGODB_URI;
  if (!source) return "";

  const url = new URL(source);
  const databaseName = `ts_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  url.pathname = `/${databaseName}`;
  return url.toString();
}

if (!process.env.TEST_MONGODB_URI) {
  test("backend integration tests", { skip: "Set TEST_MONGODB_URI to run database-backed API tests" }, () => {});
} else {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  process.env.CLIENT_URL = process.env.CLIENT_URL || "http://localhost:5173";
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_FROM;

  const { createApp } = await import("../src/app.js");
  const { Notification } = await import("../src/models/Notification.js");
  let server;
  let baseUrl;

  async function request(path, { method = "GET", token, body } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const data = await response.json().catch(() => ({}));

    return { response, data };
  }

  async function register({ name, email, password = "password123", invitationToken }) {
    const { response, data } = await request("/api/auth/register", {
      method: "POST",
      body: { name, email, password, invitationToken }
    });

    assert.equal(response.status, 201, data.message);
    assert.ok(data.token);
    assert.equal(data.user.email, email.toLowerCase());

    return data;
  }

  async function createProject(token, name = "Launch") {
    const { response, data } = await request("/api/projects", {
      method: "POST",
      token,
      body: { name, description: "Test project" }
    });

    assert.equal(response.status, 201, data.message);
    assert.equal(data.project.name, name);

    return data.project;
  }

  before(async () => {
    await mongoose.connect(testDatabaseUri(), { serverSelectionTimeoutMS: 10000 });
    server = createApp().listen(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.dropDatabase();
    }

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }

    if (server) {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  describe("auth and profile", () => {
    test("registers, logs in, reads and updates profile", async () => {
      const email = `owner_${Date.now()}@example.com`;
      const registered = await register({ name: "Owner", email });

      const me = await request("/api/auth/me", { token: registered.token });
      assert.equal(me.response.status, 200, me.data.message);
      assert.equal(me.data.user.email, email);

      const updated = await request("/api/auth/me", {
        method: "PATCH",
        token: registered.token,
        body: {
          name: "Owner Updated",
          phone: "+79990000000",
          avatarUrl: "https://example.com/avatar.png"
        }
      });
      assert.equal(updated.response.status, 200, updated.data.message);
      assert.equal(updated.data.user.name, "Owner Updated");
      assert.equal(updated.data.user.phone, "+79990000000");

      const password = await request("/api/auth/password", {
        method: "PATCH",
        token: registered.token,
        body: {
          currentPassword: "password123",
          newPassword: "password456"
        }
      });
      assert.equal(password.response.status, 200, password.data.message);

      const login = await request("/api/auth/login", {
        method: "POST",
        body: {
          email,
          password: "password456"
        }
      });
      assert.equal(login.response.status, 200, login.data.message);
      assert.ok(login.data.token);
    });
  });

  describe("project invitations", () => {
    test("creates email invitation, exposes invitation info and accepts it on registration", async () => {
      const owner = await register({ name: "Project Owner", email: `owner_project_${Date.now()}@example.com` });
      const project = await createProject(owner.token, "Email invites");
      const invitedEmail = `invitee_${Date.now()}@example.com`;

      const invited = await request(`/api/projects/${project._id}/members`, {
        method: "POST",
        token: owner.token,
        body: {
          email: invitedEmail,
          role: "member"
        }
      });
      assert.equal(invited.response.status, 200, invited.data.message);

      const invitation = invited.data.project.invitations.find((item) => item.email === invitedEmail);
      assert.ok(invitation);
      assert.equal(invitation.status, "pending");
      assert.equal(invitation.emailStatus, "skipped");
      assert.ok(invitation.token);

      const invitationInfo = await request(`/api/auth/invitations/${invitation.token}`);
      assert.equal(invitationInfo.response.status, 200, invitationInfo.data.message);
      assert.equal(invitationInfo.data.invitation.email, invitedEmail);
      assert.equal(invitationInfo.data.invitation.project.name, "Email invites");

      const task = await request("/api/tasks", {
        method: "POST",
        token: owner.token,
        body: {
          projectId: project._id,
          description: "Prepare account",
          dueDate: new Date(Date.now() + 86400000).toISOString(),
          assignee: `pending:${invitedEmail}`,
          observers: [],
          categories: [],
          priority: "urgent"
        }
      });
      assert.equal(task.response.status, 201, task.data.message);
      assert.equal(task.data.task.assigneeEmail, invitedEmail);
      assert.equal(task.data.task.priority, "urgent");

      const invitee = await register({
        name: "Invitee",
        email: invitedEmail,
        invitationToken: invitation.token
      });

      const projects = await request("/api/projects", { token: invitee.token });
      assert.equal(projects.response.status, 200, projects.data.message);
      assert.ok(projects.data.projects.some((item) => item._id === project._id));

      const dashboard = await request("/api/dashboard", { token: invitee.token });
      assert.equal(dashboard.response.status, 200, dashboard.data.message);
      assert.ok(dashboard.data.assigned.some((item) => item.description === "Prepare account"));
    });
  });

  describe("organizations, plans and templates", () => {
    test("returns default organization, enforces free project limit and stores templates", async () => {
      const owner = await register({ name: "Billing Owner", email: `billing_${Date.now()}@example.com` });

      const organizations = await request("/api/organizations", { token: owner.token });
      assert.equal(organizations.response.status, 200, organizations.data.message);
      assert.equal(organizations.data.organizations.length, 1);
      assert.equal(organizations.data.organizations[0].plan.key, "free");

      const first = await createProject(owner.token, "First");
      await createProject(owner.token, "Second");

      const third = await request("/api/projects", {
        method: "POST",
        token: owner.token,
        body: { name: "Third", description: "Should hit free plan limit" }
      });
      assert.equal(third.response.status, 402);

      const template = await request(`/api/projects/${first._id}/templates`, {
        method: "POST",
        token: owner.token,
        body: {
          title: "Weekly report",
          description: "Prepare weekly control report",
          priority: "medium",
          checklist: [{ text: "Collect closed tasks" }, { text: "Check overdue tasks" }],
          recurrence: { enabled: true, frequency: "weekly" }
        }
      });
      assert.equal(template.response.status, 201, template.data.message);
      assert.equal(template.data.templates.length, 1);
      assert.equal(template.data.templates[0].title, "Weekly report");
      assert.equal(template.data.templates[0].checklist.length, 2);
    });
  });

  describe("tasks", () => {
    test("runs review workflow, requires return comment and logs changes", async () => {
      const creator = await register({ name: "Creator", email: `creator_${Date.now()}@example.com` });
      const assignee = await register({ name: "Assignee", email: `assignee_${Date.now()}@example.com` });
      const project = await createProject(creator.token, "Workflow");

      const member = await request(`/api/projects/${project._id}/members`, {
        method: "POST",
        token: creator.token,
        body: {
          email: assignee.user.email,
          role: "member"
        }
      });
      assert.equal(member.response.status, 200, member.data.message);

      const createdTask = await request("/api/tasks", {
        method: "POST",
        token: creator.token,
        body: {
          projectId: project._id,
          description: "Ship task workflow",
          dueDate: new Date(Date.now() + 86400000).toISOString(),
          assignee: assignee.user._id,
          observers: [],
          categories: [],
          priority: "high",
          checklist: [{ text: "Write summary" }, { text: "Send to creator" }],
          recurrence: { enabled: true, frequency: "weekly" }
        }
      });
      assert.equal(createdTask.response.status, 201, createdTask.data.message);
      assert.equal(createdTask.data.task.checklist.length, 2);
      assert.equal(createdTask.data.task.recurrence.frequency, "weekly");
      const taskId = createdTask.data.task._id;

      const checklist = await request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        token: creator.token,
        body: {
          checklist: createdTask.data.task.checklist.map((item, index) => ({
            _id: item._id,
            text: item.text,
            done: index === 0
          }))
        }
      });
      assert.equal(checklist.response.status, 200, checklist.data.message);
      assert.equal(checklist.data.task.checklist[0].done, true);

      const priority = await request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        token: creator.token,
        body: { priority: "urgent" }
      });
      assert.equal(priority.response.status, 200, priority.data.message);
      assert.equal(priority.data.task.priority, "urgent");

      const review = await request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        token: assignee.token,
        body: { status: "review" }
      });
      assert.equal(review.response.status, 200, review.data.message);
      assert.equal(review.data.task.status, "review");
      assert.ok(
        await Notification.exists({ user: creator.user._id, task: taskId, message: /ready for review/ })
      );

      const assigneeCannotClose = await request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        token: assignee.token,
        body: { status: "closed" }
      });
      assert.equal(assigneeCannotClose.response.status, 403);

      const cannotReopenFromReview = await request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        token: assignee.token,
        body: { status: "open" }
      });
      assert.equal(cannotReopenFromReview.response.status, 400);

      const missingComment = await request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        token: creator.token,
        body: { status: "in_progress" }
      });
      assert.equal(missingComment.response.status, 400);

      const returned = await request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        token: creator.token,
        body: {
          status: "in_progress",
          comment: "Please update the report"
        }
      });
      assert.equal(returned.response.status, 200, returned.data.message);
      assert.equal(returned.data.task.status, "in_progress");
      assert.ok(returned.data.task.comments.some((comment) => comment.text === "Please update the report"));

      const legacyDone = await request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        token: assignee.token,
        body: { status: "done" }
      });
      assert.equal(legacyDone.response.status, 200, legacyDone.data.message);
      assert.equal(legacyDone.data.task.status, "review");
      assert.ok(
        await Notification.exists({ user: creator.user._id, task: taskId, message: /ready for review/ })
      );

      const closed = await request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        token: creator.token,
        body: { status: "closed" }
      });
      assert.equal(closed.response.status, 200, closed.data.message);
      assert.equal(closed.data.task.status, "closed");

      const cannotChangeClosed = await request(`/api/tasks/${taskId}`, {
        method: "PATCH",
        token: creator.token,
        body: { status: "in_progress" }
      });
      assert.equal(cannotChangeClosed.response.status, 400);

      const actions = closed.data.task.activities.map((activity) => activity.action);
      assert.ok(actions.includes("created"));
      assert.ok(actions.includes("priority_changed"));
      assert.ok(actions.includes("checklist_changed"));
      assert.ok(actions.includes("status_changed"));

      const control = await request("/api/reports/control", { token: creator.token });
      assert.equal(control.response.status, 200, control.data.message);
      assert.ok(Number.isInteger(control.data.summary.active));
      assert.ok(Array.isArray(control.data.byAssignee));
    });
  });
}
