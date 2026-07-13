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

  async function registerRaw({ name, lastName = "Тестов", email, password = "password123", invitationToken }) {
    const { response, data } = await request("/api/auth/register", {
      method: "POST",
      body: { name, lastName, email, password, invitationToken }
    });

    assert.equal(response.status, 201, data.message);
    assert.equal(data.requiresEmailVerification, true);
    assert.ok(data.verificationToken);
    assert.equal(data.email, email.toLowerCase());

    return data;
  }

  async function verifyEmail(token) {
    const { response, data } = await request("/api/auth/email/verify", {
      method: "POST",
      body: { token }
    });

    assert.equal(response.status, 200, data.message);
    assert.ok(data.token);
    assert.ok(data.user.emailVerifiedAt);

    return data;
  }

  async function register({ name, lastName = "Тестов", email, password = "password123", invitationToken }) {
    const created = await registerRaw({ name, lastName, email, password, invitationToken });
    const data = await verifyEmail(created.verificationToken);

    assert.equal(data.user.email, email.toLowerCase());
    assert.equal(data.user.lastName, lastName);

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
    test("requires email confirmation before login", async () => {
      const email = `pending_${Date.now()}@example.com`;
      const created = await registerRaw({ name: "Pending", email });

      const rejectedLogin = await request("/api/auth/login", {
        method: "POST",
        body: {
          email,
          password: "password123"
        }
      });
      assert.equal(rejectedLogin.response.status, 403);
      assert.equal(rejectedLogin.data.requiresEmailVerification, true);

      const resend = await request("/api/auth/email/resend", {
        method: "POST",
        body: { email }
      });
      assert.equal(resend.response.status, 200, resend.data.message);
      assert.ok(resend.data.verificationToken);

      const verified = await verifyEmail(resend.data.verificationToken || created.verificationToken);
      assert.equal(verified.user.email, email);
    });

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
          lastName: "Updated",
          phone: "+79990000000",
          avatarUrl: "https://example.com/avatar.png"
        }
      });
      assert.equal(updated.response.status, 200, updated.data.message);
      assert.equal(updated.data.user.name, "Owner Updated");
      assert.equal(updated.data.user.lastName, "Updated");
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

    test("super admin is limited to service routes and can block users", async () => {
      const user = await register({ name: "Blocked User", email: `blocked_${Date.now()}@example.com` });

      const adminLogin = await request("/api/auth/login", {
        method: "POST",
        body: {
          email: "admin@taskspot.ru",
          password: "qwerty"
        }
      });
      assert.equal(adminLogin.response.status, 200, adminLogin.data.message);
      assert.equal(adminLogin.data.user.isSuperAdmin, true);

      const overview = await request("/api/admin/overview", { token: adminLogin.data.token });
      assert.equal(overview.response.status, 200, overview.data.message);

      const cannotCreateProject = await request("/api/projects", {
        method: "POST",
        token: adminLogin.data.token,
        body: { name: "Admin workspace project", description: "Should be forbidden" }
      });
      assert.equal(cannotCreateProject.response.status, 403);

      const blocked = await request(`/api/admin/users/${user.user._id}/status`, {
        method: "PATCH",
        token: adminLogin.data.token,
        body: { blocked: true }
      });
      assert.equal(blocked.response.status, 200, blocked.data.message);
      assert.equal(blocked.data.user.status, "blocked");

      const blockedMe = await request("/api/auth/me", { token: user.token });
      assert.equal(blockedMe.response.status, 403);

      const blockedLogin = await request("/api/auth/login", {
        method: "POST",
        body: {
          email: user.user.email,
          password: "password123"
        }
      });
      assert.equal(blockedLogin.response.status, 403);

      const unblocked = await request(`/api/admin/users/${user.user._id}/status`, {
        method: "PATCH",
        token: adminLogin.data.token,
        body: { status: "active" }
      });
      assert.equal(unblocked.response.status, 200, unblocked.data.message);
      assert.equal(unblocked.data.user.status, "active");
    });
  });

  describe("project invitations", () => {
    test("adds an existing user to project and reports member email status", async () => {
      const owner = await register({ name: "Project Owner", email: `owner_existing_${Date.now()}@example.com` });
      const member = await register({ name: "Existing", email: `existing_member_${Date.now()}@example.com` });
      const project = await createProject(owner.token, "Existing member project");

      const added = await request(`/api/projects/${project._id}/members`, {
        method: "POST",
        token: owner.token,
        body: {
          email: member.user.email,
          role: "member"
        }
      });

      assert.equal(added.response.status, 200, added.data.message);
      assert.ok(added.data.project.members.some((item) => item.user.email === member.user.email));
      assert.equal(added.data.email.status, "skipped");

      const projects = await request("/api/projects", { token: member.token });
      assert.equal(projects.response.status, 200, projects.data.message);
      assert.ok(projects.data.projects.some((item) => item._id === project._id));
    });

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
      assert.ok(["pending", "skipped", "sent", "failed"].includes(invitation.emailStatus));
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
        lastName: "Invited",
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

    test("creates projects without preset categories and allows category deletion", async () => {
      const owner = await register({ name: "Category Owner", email: `categories_${Date.now()}@example.com` });
      const project = await createProject(owner.token, "Empty categories");

      assert.deepEqual(project.categories, []);

      const category = await request(`/api/projects/${project._id}/categories`, {
        method: "POST",
        token: owner.token,
        body: { name: "Срочно", color: "#dc2626" }
      });
      assert.equal(category.response.status, 201, category.data.message);
      assert.equal(category.data.categories.length, 1);

      const categoryId = category.data.categories[0]._id;
      const task = await request("/api/tasks", {
        method: "POST",
        token: owner.token,
        body: {
          projectId: project._id,
          description: "Task with removable category",
          dueDate: new Date(Date.now() + 86400000).toISOString(),
          assignee: owner.user._id,
          observers: [],
          categories: [categoryId],
          priority: "medium"
        }
      });
      assert.equal(task.response.status, 201, task.data.message);
      assert.equal(task.data.task.categories.length, 1);

      const removed = await request(`/api/projects/${project._id}/categories/${categoryId}`, {
        method: "DELETE",
        token: owner.token
      });
      assert.equal(removed.response.status, 200, removed.data.message);
      assert.deepEqual(removed.data.categories, []);

      const updatedTask = await request(`/api/tasks/${task.data.task._id}`, { token: owner.token });
      assert.equal(updatedTask.response.status, 200, updatedTask.data.message);
      assert.deepEqual(updatedTask.data.task.categories, []);
    });

    test("archives, restores and permanently deletes projects with tasks", async () => {
      const owner = await register({ name: "Archive Owner", email: `archive_${Date.now()}@example.com` });
      const assignee = await register({ name: "Archive Assignee", email: `archive_assignee_${Date.now()}@example.com` });
      const project = await createProject(owner.token, "Archive lifecycle");

      const member = await request(`/api/projects/${project._id}/members`, {
        method: "POST",
        token: owner.token,
        body: {
          email: assignee.user.email,
          role: "member"
        }
      });
      assert.equal(member.response.status, 200, member.data.message);

      const task = await request("/api/tasks", {
        method: "POST",
        token: owner.token,
        body: {
          projectId: project._id,
          description: "Task in archived project",
          dueDate: new Date(Date.now() + 86400000).toISOString(),
          assignee: assignee.user._id,
          observers: [],
          categories: [],
          priority: "medium"
        }
      });
      assert.equal(task.response.status, 201, task.data.message);

      const archived = await request(`/api/projects/${project._id}/archive`, {
        method: "PATCH",
        token: owner.token
      });
      assert.equal(archived.response.status, 200, archived.data.message);
      assert.equal(archived.data.project.isArchived, true);
      assert.ok(archived.data.project.archivedAt);

      const archivedTasks = await request(`/api/tasks?projectId=${project._id}`, { token: owner.token });
      assert.equal(archivedTasks.response.status, 200, archivedTasks.data.message);
      assert.equal(archivedTasks.data.tasks.length, 1);

      const cannotCreateTask = await request("/api/tasks", {
        method: "POST",
        token: owner.token,
        body: {
          projectId: project._id,
          description: "Should not be created",
          dueDate: new Date(Date.now() + 86400000).toISOString(),
          assignee: assignee.user._id,
          observers: [],
          categories: [],
          priority: "medium"
        }
      });
      assert.equal(cannotCreateTask.response.status, 409);

      const cannotChangeArchivedTask = await request(`/api/tasks/${task.data.task._id}`, {
        method: "PATCH",
        token: assignee.token,
        body: { status: "review" }
      });
      assert.equal(cannotChangeArchivedTask.response.status, 409);

      const cannotCommentArchivedTask = await request(`/api/tasks/${task.data.task._id}/comments`, {
        method: "POST",
        token: owner.token,
        body: { text: "Archived task is read-only" }
      });
      assert.equal(cannotCommentArchivedTask.response.status, 409);

      const restored = await request(`/api/projects/${project._id}/restore`, {
        method: "PATCH",
        token: owner.token
      });
      assert.equal(restored.response.status, 200, restored.data.message);
      assert.equal(restored.data.project.isArchived, false);

      const reviewAfterRestore = await request(`/api/tasks/${task.data.task._id}`, {
        method: "PATCH",
        token: assignee.token,
        body: { status: "review" }
      });
      assert.equal(reviewAfterRestore.response.status, 200, reviewAfterRestore.data.message);
      assert.equal(reviewAfterRestore.data.task.status, "review");

      const missingConfirmation = await request(`/api/projects/${project._id}`, {
        method: "DELETE",
        token: owner.token,
        body: { confirm: "DELETE" }
      });
      assert.equal(missingConfirmation.response.status, 400);

      const deleted = await request(`/api/projects/${project._id}`, {
        method: "DELETE",
        token: owner.token,
        body: { confirm: "DELETE_PROJECT_WITH_TASKS" }
      });
      assert.equal(deleted.response.status, 200, deleted.data.message);
      assert.equal(deleted.data.deleted, true);
      assert.equal(deleted.data.tasksDeleted, 1);

      const deletedProject = await request(`/api/projects/${project._id}`, { token: owner.token });
      assert.equal(deletedProject.response.status, 404);

      const deletedTask = await request(`/api/tasks/${task.data.task._id}`, { token: owner.token });
      assert.equal(deletedTask.response.status, 404);
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
