import express from "express";
import mongoose from "mongoose";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { parsePeriod, buildPeriodReport, reportCsv, closedAt } from "../services/periodReports.js";
import { requireRegularUser } from "../middleware/auth.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { taskFilterForProjects } from "../services/taskAccess.js";

export const reportsRouter = express.Router();

reportsRouter.use(requireRegularUser);

function idOf(value) {
  return value?._id?.toString() || value?.toString();
}

function isActive(task) {
  return !["review", "done", "closed"].includes(task.status);
}

function isOverdue(task, today) {
  return Boolean(task.dueDate) && task.dueDate < today && isActive(task);
}

function fullName(user) {
  return [user?.name, user?.lastName].filter(Boolean).join(" ").trim() || user?.email || "";
}

reportsRouter.get("/control", asyncRoute(async (req, res) => {
  const projects = await Project.find({ "members.user": req.user._id }).populate("members.user", "name lastName email");
  const filter = taskFilterForProjects(projects, req.user._id);

  const tasks = await Task.find(filter)
    .populate("project", "name")
    .populate("creator", "name lastName email")
    .populate("assignee", "name lastName email")
    .populate("observers", "name lastName email")
    .sort({ dueDate: 1 });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const overdue = tasks.filter((task) => isOverdue(task, today));
  const waitingReview = tasks.filter((task) => ["review", "done"].includes(task.status));
  const unassigned = tasks.filter((task) => !task.assignee && !task.assigneeEmail && task.status !== "closed");
  const month = parsePeriod({});
  const closedThisMonth = tasks.filter((task) => {
    const closed = task.status === "closed";
    const closure = closedAt(task);
    return closed && closure && closure >= month.start && closure < month.end;
  });

  const assigneeMap = new Map();
  const workloadByAssigneeProjectMap = new Map();
  tasks.forEach((task) => {
    const key = task.assignee ? idOf(task.assignee) : task.assigneeEmail || "unassigned";
    const current = assigneeMap.get(key) || {
      key,
      name: task.assignee ? fullName(task.assignee) : task.assigneeEmail || "Без ответственного",
      email: task.assignee?.email || task.assigneeEmail || "",
      active: 0,
      overdue: 0,
      review: 0,
      closed: 0
    };

    if (task.status === "closed") current.closed += 1;
    else current.active += 1;
    if (isOverdue(task, today)) current.overdue += 1;
    if (["review", "done"].includes(task.status)) current.review += 1;

    assigneeMap.set(key, current);

    const projectKey = idOf(task.project) || "no-project";
    const workloadKey = `${key}:${projectKey}`;
    const workload = workloadByAssigneeProjectMap.get(workloadKey) || {
      key: workloadKey,
      assigneeKey: key,
      assignee: task.assignee ? fullName(task.assignee) : task.assigneeEmail || "Без ответственного",
      email: task.assignee?.email || task.assigneeEmail || "",
      projectKey,
      project: task.project?.name || "Без проекта",
      active: 0,
      overdue: 0,
      review: 0,
      closed: 0
    };

    if (task.status === "closed") workload.closed += 1;
    else workload.active += 1;
    if (isOverdue(task, today)) workload.overdue += 1;
    if (["review", "done"].includes(task.status)) workload.review += 1;

    workloadByAssigneeProjectMap.set(workloadKey, workload);
  });

  const projectMap = new Map();
  tasks.forEach((task) => {
    const key = idOf(task.project);
    const current = projectMap.get(key) || {
      key,
      name: task.project?.name || "Без проекта",
      active: 0,
      overdue: 0,
      review: 0,
      closed: 0
    };

    if (task.status === "closed") current.closed += 1;
    else current.active += 1;
    if (isOverdue(task, today)) current.overdue += 1;
    if (["review", "done"].includes(task.status)) current.review += 1;

    projectMap.set(key, current);
  });

  res.json({
    summary: {
      active: tasks.filter((task) => task.status !== "closed").length,
      overdue: overdue.length,
      waitingReview: waitingReview.length,
      unassigned: unassigned.length,
      closedThisMonth: closedThisMonth.length
    },
    overdue,
    waitingReview,
    unassigned,
    byAssignee: Array.from(assigneeMap.values()).sort((a, b) => b.overdue - a.overdue),
    workloadByAssigneeProject: Array.from(workloadByAssigneeProjectMap.values()).sort(
      (a, b) => b.overdue - a.overdue || b.active - a.active || a.assignee.localeCompare(b.assignee, "ru")
    ),
    byProject: Array.from(projectMap.values()).sort((a, b) => b.active - a.active)
  });
}));

reportsRouter.get("/period", asyncRoute(async (req, res) => {
  const period = parsePeriod(req.query);
  const projects = await Project.find({ "members.user": req.user._id }).lean();
  let selected = projects;
  if (req.query.projectId) {
    if (typeof req.query.projectId !== "string" || !mongoose.isObjectIdOrHexString(req.query.projectId)) return res.status(400).json({ message: "Некорректный проект" });
    selected = projects.filter((project) => String(project._id) === req.query.projectId);
    if (!selected.length) return res.status(403).json({ message: "Нет доступа к проекту" });
  }
  const visibility = taskFilterForProjects(selected, req.user._id);
  const tasks = await Task.find({ $and: [visibility, { $or: [
    { createdAt: { $gte: period.previousStart, $lt: period.end } },
    { activities: { $elemMatch: { action: "status_changed", to: "closed", createdAt: { $gte: period.previousStart, $lt: period.end } } } },
    { status: { $ne: "closed" } }
  ] }] }).select("project creator assignee assigneeEmail description createdAt dueDate status priority categories activities")
    .populate("assignee", "name lastName email").limit(20001).lean();
  if (tasks.length > 20000) return res.status(413).json({ message: "Отчёт слишком большой. Выберите один проект или сократите период." });
  const report = buildPeriodReport(tasks, selected, period);
  res.set("Cache-Control", "no-store");
  if (req.query.format === "csv") {
    const csv = reportCsv(report, req.query.group || "projects");
    return res.type("text/csv; charset=utf-8").attachment("taskspot-report.csv").send(csv);
  }
  res.json({ ...report, rows: undefined, projectsFilter: projects.map((project) => ({ value: project._id, label: project.name })) });
}));
