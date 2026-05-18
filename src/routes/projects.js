import express from "express";
import crypto from "node:crypto";
import { requireRegularUser } from "../middleware/auth.js";
import { Organization } from "../models/Organization.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { User } from "../models/User.js";
import { sendProjectInvitationEmail, sendProjectMemberAddedEmail } from "../services/email.js";
import { ensureDefaultOrganization, limitExceeded, organizationUsage, planFor } from "../services/plans.js";

export const projectsRouter = express.Router();

const TEMPLATE_PRIORITIES = ["low", "medium", "high", "urgent"];
const TEMPLATE_RECURRENCE_FREQUENCIES = ["none", "daily", "weekly", "monthly"];

projectsRouter.use(requireRegularUser);

function memberEntry(project, userId) {
  return project.members.find((member) => member.user.toString() === userId.toString());
}

function isAdmin(project, userId) {
  return memberEntry(project, userId)?.role === "admin";
}

function organizationMember(organization, userId) {
  return organization.members.find((member) => member.user.toString() === userId.toString());
}

function createInvitationToken() {
  return crypto.randomBytes(32).toString("hex");
}

function createInvitationExpiresAt() {
  return new Date(Date.now() + 1000 * 60 * 60 * 24 * 14);
}

function frontendUrl() {
  return process.env.CLIENT_URL || (process.env.NODE_ENV === "production" ? "https://taskspot.ru" : "http://localhost:5173");
}

function invitationUrl(token) {
  return `${frontendUrl().replace(/\/$/, "")}/register?invite=${token}`;
}

async function sendInvitation(project, invitation, inviter) {
  if (!invitation.token) {
    invitation.token = createInvitationToken();
  }

  if (!invitation.expiresAt || invitation.expiresAt < new Date()) {
    invitation.expiresAt = createInvitationExpiresAt();
  }

  try {
    const result = await sendProjectInvitationEmail({
      email: invitation.email,
      projectName: project.name,
      inviterName: inviter.name,
      role: invitation.role,
      invitationUrl: invitationUrl(invitation.token)
    });

    invitation.emailStatus = result.skipped ? "skipped" : "sent";
    invitation.emailSentAt = result.skipped ? invitation.emailSentAt : new Date();
    invitation.emailError = result.skipped ? result.reason : "";
  } catch (error) {
    invitation.emailStatus = "failed";
    invitation.emailError = error.message;
  }
}

async function sendMemberAdded(user, project, inviter) {
  try {
    await sendProjectMemberAddedEmail({
      email: user.email,
      projectName: project.name,
      inviterName: inviter.name,
      appUrl: `${frontendUrl().replace(/\/$/, "")}/app/projects/${project._id}/tasks`
    });
  } catch (error) {
    console.error("Failed to send member email", error);
  }
}

async function loadProject(req, res, next) {
  const project = await Project.findById(req.params.projectId);

  if (!project) {
    return res.status(404).json({ message: "Project not found" });
  }

  if (!memberEntry(project, req.user._id)) {
    return res.status(403).json({ message: "Project access denied" });
  }

  req.project = project;
  next();
}

async function requireAdmin(req, res, next) {
  if (!isAdmin(req.project, req.user._id)) {
    return res.status(403).json({ message: "Project admin role is required" });
  }

  next();
}

projectsRouter.get("/", async (req, res) => {
  const projects = await Project.find({ "members.user": req.user._id })
    .populate("organization", "name plan")
    .populate("members.user", "name email")
    .populate("invitations.invitedBy", "name email")
    .sort({ updatedAt: -1 });

  res.json({ projects });
});

projectsRouter.post("/", async (req, res) => {
  const { name, description, organizationId } = req.body;

  if (!name) {
    return res.status(400).json({ message: "Project name is required" });
  }

  const organization = organizationId
    ? await Organization.findById(organizationId)
    : await ensureDefaultOrganization(req.user);

  if (!organization || !organizationMember(organization, req.user._id)) {
    return res.status(403).json({ message: "Organization access denied" });
  }

  const usage = await organizationUsage(organization);
  const plan = planFor(organization);
  if (limitExceeded({ plan, usage, key: "projects" })) {
    return res.status(402).json({ message: "Лимит проектов на текущем тарифе исчерпан" });
  }

  const project = await Project.create({
    organization: organization._id,
    name,
    description,
    members: [{ user: req.user._id, role: "admin" }],
    categories: [
      { name: "Backend", color: "#1677ff" },
      { name: "Frontend", color: "#52c41a" }
    ]
  });

  await project.populate([
    { path: "organization", select: "name plan" },
    { path: "members.user", select: "name email" }
  ]);
  res.status(201).json({ project });
});

projectsRouter.post("/demo", async (req, res) => {
  const organization = await ensureDefaultOrganization(req.user);
  const usage = await organizationUsage(organization);
  const plan = planFor(organization);

  if (limitExceeded({ plan, usage, key: "projects" })) {
    return res.status(402).json({ message: "Лимит проектов на текущем тарифе исчерпан" });
  }

  const project = await Project.create({
    organization: organization._id,
    name: "Контроль поручений",
    description: "Демо-проект с задачами для руководителя малого бизнеса.",
    members: [{ user: req.user._id, role: "admin" }],
    categories: [
      { name: "Продажи", color: "#1677ff" },
      { name: "Операционка", color: "#52c41a" },
      { name: "Финансы", color: "#faad14" }
    ],
    templates: [
      {
        title: "Еженедельный отчёт",
        description: "Подготовить короткий отчёт по задачам и просрочкам за неделю",
        priority: "medium",
        checklist: [{ text: "Собрать закрытые задачи" }, { text: "Отметить просрочки" }],
        recurrence: { enabled: true, frequency: "weekly" },
        createdBy: req.user._id
      }
    ]
  });

  const tasks = await Task.insertMany([
    {
      project: project._id,
      creator: req.user._id,
      assignee: req.user._id,
      description: "Позвонить клиентам, которые ждут счёт",
      dueDate: new Date(Date.now() + 86400000),
      categories: [project.categories[0]._id],
      priority: "urgent",
      checklist: [{ text: "Проверить список клиентов" }, { text: "Отметить результат звонка" }],
      status: "open",
      activities: [{ actor: req.user._id, action: "created", details: "Demo task created" }]
    },
    {
      project: project._id,
      creator: req.user._id,
      assignee: req.user._id,
      description: "Проверить выполнение поручений за неделю",
      dueDate: new Date(Date.now() + 2 * 86400000),
      categories: [project.categories[1]._id],
      priority: "high",
      recurrence: { enabled: true, frequency: "weekly", nextRunAt: new Date(Date.now() + 7 * 86400000) },
      status: "in_progress",
      activities: [{ actor: req.user._id, action: "created", details: "Demo task created" }]
    }
  ]);

  await project.populate([
    { path: "organization", select: "name plan" },
    { path: "members.user", select: "name email" }
  ]);
  res.status(201).json({ project, tasks });
});

projectsRouter.get("/:projectId", loadProject, async (req, res) => {
  await req.project.populate([
    { path: "organization", select: "name plan" },
    { path: "members.user", select: "name email" },
    { path: "invitations.invitedBy", select: "name email" }
  ]);
  res.json({ project: req.project });
});

projectsRouter.patch("/:projectId", loadProject, requireAdmin, async (req, res) => {
  const { name, description = "" } = req.body;

  if (!name?.trim()) {
    return res.status(400).json({ message: "Project name is required" });
  }

  req.project.name = name.trim();
  req.project.description = description.trim();
  await req.project.save();
  await req.project.populate([
    { path: "members.user", select: "name email" },
    { path: "invitations.invitedBy", select: "name email" }
  ]);
  res.json({ project: req.project });
});

projectsRouter.post("/:projectId/members", loadProject, requireAdmin, async (req, res) => {
  const { email, role = "member" } = req.body;
  const normalizedEmail = email?.toLowerCase();

  if (!normalizedEmail) {
    return res.status(400).json({ message: "Member email is required" });
  }

  if (!["admin", "member"].includes(role)) {
    return res.status(400).json({ message: "Unknown member role" });
  }

  const user = await User.findOne({ email: normalizedEmail });
  const organization = req.project.organization ? await Organization.findById(req.project.organization) : null;
  if (organization) {
    const usage = await organizationUsage(organization);
    const plan = planFor(organization);
    const existingInProject = user ? memberEntry(req.project, user._id) : null;
    const existingInvitation = req.project.invitations.find(
      (invitation) => invitation.email === normalizedEmail && invitation.status === "pending"
    );

    if (!existingInProject && !existingInvitation && limitExceeded({ plan, usage, key: "users" })) {
      return res.status(402).json({ message: "Лимит пользователей на текущем тарифе исчерпан" });
    }
  }

  if (user) {
    const existing = memberEntry(req.project, user._id);
    if (existing) {
      existing.role = role;
    } else {
      req.project.members.push({ user: user._id, role });
      if (organization && !organizationMember(organization, user._id)) {
        organization.members.push({ user: user._id, role: role === "admin" ? "admin" : "member" });
        await organization.save();
      }
      await sendMemberAdded(user, req.project, req.user);
    }
  } else {
    const existingInvitation = req.project.invitations.find(
      (invitation) => invitation.email === normalizedEmail && invitation.status === "pending"
    );

    if (existingInvitation) {
      existingInvitation.role = role;
      existingInvitation.token = existingInvitation.token || createInvitationToken();
      existingInvitation.expiresAt = createInvitationExpiresAt();
      await sendInvitation(req.project, existingInvitation, req.user);
    } else {
      const invitation = {
        email: normalizedEmail,
        role,
        invitedBy: req.user._id,
        token: createInvitationToken(),
        expiresAt: createInvitationExpiresAt(),
        status: "pending"
      };
      req.project.invitations.push(invitation);
      await sendInvitation(req.project, req.project.invitations[req.project.invitations.length - 1], req.user);
    }
  }

  await req.project.save();
  await req.project.populate([
    { path: "members.user", select: "name email" },
    { path: "invitations.invitedBy", select: "name email" }
  ]);
  res.json({ project: req.project });
});

projectsRouter.post("/:projectId/templates", loadProject, requireAdmin, async (req, res) => {
  const { title, description, priority = "medium", categories = [], checklist = [], recurrence = {} } = req.body;

  if (!title?.trim() || !description?.trim()) {
    return res.status(400).json({ message: "Template title and description are required" });
  }

  if (!TEMPLATE_PRIORITIES.includes(priority)) {
    return res.status(400).json({ message: "Unknown template priority" });
  }

  if (!Array.isArray(categories) || !Array.isArray(checklist)) {
    return res.status(400).json({ message: "Template categories and checklist must be arrays" });
  }

  const projectCategoryIds = new Set(req.project.categories.map((category) => category._id.toString()));
  const invalidCategory = categories.find((categoryId) => !projectCategoryIds.has(String(categoryId)));
  if (invalidCategory) {
    return res.status(400).json({ message: "Template categories must belong to the project" });
  }

  const recurrenceFrequency = recurrence.enabled ? recurrence.frequency || "weekly" : "none";
  if (!TEMPLATE_RECURRENCE_FREQUENCIES.includes(recurrenceFrequency)) {
    return res.status(400).json({ message: "Unknown recurrence frequency" });
  }

  const organization = req.project.organization ? await Organization.findById(req.project.organization) : null;
  if (organization) {
    const usage = await organizationUsage(organization);
    const plan = planFor(organization);

    if (limitExceeded({ plan, usage, key: "templates" })) {
      return res.status(402).json({ message: "Лимит шаблонов на текущем тарифе исчерпан" });
    }
  }

  req.project.templates.push({
    title: title.trim(),
    description: description.trim(),
    priority,
    categories,
    checklist: checklist.filter((item) => item?.text?.trim()).map((item) => ({ text: item.text.trim(), done: false })),
    recurrence: {
      enabled: Boolean(recurrence.enabled),
      frequency: recurrenceFrequency
    },
    createdBy: req.user._id
  });
  await req.project.save();

  res.status(201).json({ templates: req.project.templates });
});

projectsRouter.delete("/:projectId/templates/:templateId", loadProject, requireAdmin, async (req, res) => {
  req.project.templates = req.project.templates.filter(
    (template) => template._id.toString() !== req.params.templateId
  );
  await req.project.save();

  res.json({ templates: req.project.templates });
});

projectsRouter.post("/:projectId/invitations/:invitationId/resend", loadProject, requireAdmin, async (req, res) => {
  const invitation = req.project.invitations.find(
    (item) => item._id.toString() === req.params.invitationId && item.status === "pending"
  );

  if (!invitation) {
    return res.status(404).json({ message: "Invitation not found" });
  }

  invitation.token = createInvitationToken();
  invitation.expiresAt = createInvitationExpiresAt();
  await sendInvitation(req.project, invitation, req.user);
  await req.project.save();
  await req.project.populate([
    { path: "members.user", select: "name email" },
    { path: "invitations.invitedBy", select: "name email" }
  ]);

  res.json({ project: req.project });
});

projectsRouter.delete("/:projectId/invitations/:invitationId", loadProject, requireAdmin, async (req, res) => {
  req.project.invitations = req.project.invitations.filter(
    (invitation) => invitation._id.toString() !== req.params.invitationId
  );
  await req.project.save();
  await req.project.populate([
    { path: "members.user", select: "name email" },
    { path: "invitations.invitedBy", select: "name email" }
  ]);
  res.json({ project: req.project });
});

projectsRouter.delete("/:projectId/members/:userId", loadProject, requireAdmin, async (req, res) => {
  const userId = req.params.userId;
  const removingSelf = userId === req.user._id.toString();
  const admins = req.project.members.filter((member) => member.role === "admin");

  if (removingSelf && admins.length === 1) {
    return res.status(400).json({ message: "Project must have at least one admin" });
  }

  req.project.members = req.project.members.filter((member) => member.user.toString() !== userId);
  await req.project.save();
  await Promise.all([
    Task.updateMany({ project: req.project._id }, { $pull: { observers: userId } }),
    Task.updateMany({ project: req.project._id, assignee: userId }, { $unset: { assignee: "" } })
  ]);
  await req.project.populate([
    { path: "members.user", select: "name email" },
    { path: "invitations.invitedBy", select: "name email" }
  ]);
  res.json({ project: req.project });
});

projectsRouter.post("/:projectId/categories", loadProject, requireAdmin, async (req, res) => {
  const { name, color } = req.body;

  if (!name) {
    return res.status(400).json({ message: "Category name is required" });
  }

  req.project.categories.push({ name, color });
  await req.project.save();
  res.status(201).json({ categories: req.project.categories });
});

projectsRouter.delete("/:projectId/categories/:categoryId", loadProject, requireAdmin, async (req, res) => {
  const requestedCategory = decodeURIComponent(req.params.categoryId || "");
  const removedCategoryIds = [];
  const removedCategoryNames = [];

  req.project.categories = req.project.categories.filter((category) => {
    const categoryId = category._id?.toString();
    const categoryName = category.name?.trim();
    const shouldRemove = categoryId === requestedCategory || categoryName === requestedCategory;

    if (shouldRemove) {
      if (categoryId) removedCategoryIds.push(categoryId);
      if (categoryName) removedCategoryNames.push(categoryName);
    }

    return !shouldRemove;
  });

  if (!removedCategoryIds.length && !removedCategoryNames.length) {
    return res.status(404).json({ message: "Category not found" });
  }

  await req.project.save();

  if (removedCategoryIds.length) {
    await Task.updateMany(
      { project: req.project._id },
      { $pull: { categories: { $in: removedCategoryIds } } }
    );
  }

  res.json({ categories: req.project.categories });
});
