import crypto from "node:crypto";
import express from "express";
import mongoose from "mongoose";
import { requireRegularUser } from "../middleware/auth.js";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { Project } from "../models/Project.js";
import { ProjectTemplate } from "../models/ProjectTemplate.js";
import { Organization } from "../models/Organization.js";
import { Task } from "../models/Task.js";
import { activityActor } from "../services/projectActivity.js";
import { ensureDefaultOrganization, organizationUsage, planFor, limitExceeded, limitPayload, notifyOrganizationLimit } from "../services/plans.js";
import { BUILTIN_PROJECT_TEMPLATES, calendarDay, startDay, snapshotBlueprint, materializeBlueprint, templateName, templateError } from "../services/projectTemplates.js";

export const projectTemplatesRouter = express.Router();
projectTemplatesRouter.use(requireRegularUser);

function objectId(value) {
  return typeof value === "string" && /^[0-9a-f]{24}$/i.test(value);
}

function isAdmin(project, user) {
  return project.members.some((entry) => String(entry.user) === String(user._id) && entry.role === "admin");
}

async function checkLimits(organization, session, increments) {
  const plan = planFor(organization);
  const usage = await organizationUsage(organization, { session });
  for (const [key, increment] of Object.entries(increments)) {
    if (limitExceeded({ plan, usage, key, increment })) {
      throw Object.assign(templateError("Недостаточно лимита для всего шаблона", 402), {
        payload: limitPayload({ organization, plan, usage, key, increment, message: "Недостаточно лимита для всего шаблона" }),
        limitContext: { organization, plan, usage, key }
      });
    }
  }
}

function route(handler) {
  return asyncRoute(async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      if (!error.payload) throw error;
      await notifyOrganizationLimit(error.limitContext).catch(() => {});
      res.status(402).json(error.payload);
    }
  });
}

async function lockOrganization(id, session) {
  return Organization.findOneAndUpdate({ _id: id }, { $inc: { templateVersion: 1 } }, { new: true, session });
}

projectTemplatesRouter.get("/", route(async (req, res) => {
  const templates = await ProjectTemplate.find({ owner: req.user._id }).sort({ createdAt: -1 }).lean();
  res.json({ templates: [...BUILTIN_PROJECT_TEMPLATES, ...templates] });
}));

projectTemplatesRouter.post("/", route(async (req, res) => {
  const name = templateName(req.body.name);
  if (!objectId(req.body.projectId)) throw templateError("Некорректный проект");
  const source = await Project.findById(req.body.projectId);
  if (!source || !isAdmin(source, req.user)) throw templateError("Только администратор проекта может сохранить шаблон", 403);
  const personal = await ensureDefaultOrganization(req.user);
  let saved;
  await mongoose.connection.transaction(async (session) => {
    const organization = await lockOrganization(personal._id, session);
    const project = await Project.findById(source._id).session(session);
    if (!project || !isAdmin(project, req.user)) throw templateError("Нет доступа к проекту", 403);
    await checkLimits(organization, session, { templates: 1 });
    const tasks = await Task.find({ project: project._id, status: { $nin: ["closed", "done", "review"] } })
      .sort({ createdAt: 1, _id: 1 }).limit(51).session(session);
    const blueprint = snapshotBlueprint(project, tasks);
    [saved] = await ProjectTemplate.create([{
      owner: req.user._id, organization: organization._id, name,
      description: (project.description || "").slice(0, 5000), ...blueprint
    }], { session });
  });
  res.status(201).json({ template: saved });
}));

projectTemplatesRouter.delete("/:templateId", route(async (req, res) => {
  if (!objectId(req.params.templateId)) throw templateError("Шаблон не найден", 404);
  const removed = await ProjectTemplate.findOneAndDelete({ _id: req.params.templateId, owner: req.user._id });
  if (!removed) throw templateError("Шаблон не найден", 404);
  res.json({ ok: true });
}));

projectTemplatesRouter.post("/:templateId/projects", route(async (req, res) => {
  const name = templateName(req.body.name);
  const requestId = req.body.requestId;
  if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    throw templateError("Некорректный идентификатор запроса");
  }
  const rawDate = req.body.startDate ?? null;
  if (rawDate !== null) startDay(rawDate);
  const key = String(req.user._id) + ":" + requestId.toLowerCase();
  const digest = crypto.createHash("sha256").update(JSON.stringify([req.params.templateId, name, rawDate])).digest("hex");
  const existing = (session = null) => Project.findOne({ templateCreationKey: key })
    .select("+templateCreationDigest").session(session);
  function validateRetry(project) {
    if (project.templateCreationDigest !== digest) throw templateError("Этот запрос уже использован с другими параметрами", 409);
    if (!isAdmin(project, req.user)) throw templateError("Нет доступа к созданному проекту", 403);
    return project;
  }
  let project = await existing();
  if (project) return res.json({ project: validateRetry(project) });
  const personal = await ensureDefaultOrganization(req.user);
  let reused = false;
  try {
    await mongoose.connection.transaction(async (session) => {
      const organization = await lockOrganization(personal._id, session);
      const previous = await existing(session);
      if (previous) { project = validateRetry(previous); reused = true; return; }
      let template = BUILTIN_PROJECT_TEMPLATES.find((item) => item._id === req.params.templateId);
      if (!template && objectId(req.params.templateId)) {
        template = await ProjectTemplate.findOne({ _id: req.params.templateId, owner: req.user._id }).session(session);
      }
      if (!template) throw templateError("Шаблон не найден", 404);
      await checkLimits(organization, session, { projects: 1, activeTasks: template.tasks.length });
      const projectId = new mongoose.Types.ObjectId();
      const blueprint = materializeBlueprint(template, projectId, req.user._id, rawDate || calendarDay());
      project = new Project({
        _id: projectId, name, description: template.description, organization: organization._id,
        createdBy: req.user._id, members: [{ user: req.user._id, role: "admin" }],
        categories: blueprint.categories, templateCreationKey: key, templateCreationDigest: digest
      });
      project.$locals.auditActor = activityActor(req.user);
      await project.save({ session });
      if (blueprint.tasks.length) await Task.insertMany(blueprint.tasks, { session });
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    const previous = await existing();
    if (!previous) throw error;
    project = validateRetry(previous);
    reused = true;
  }
  project.$session(null);
  res.status(reused ? 200 : 201).json({ project });
}));
