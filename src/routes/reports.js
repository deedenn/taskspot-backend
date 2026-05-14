import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";

export const reportsRouter = express.Router();

reportsRouter.use(requireAuth);

function idOf(value) {
  return value?._id?.toString() || value?.toString();
}

function isAdmin(project, userId) {
  return project.members.some(
    (member) => idOf(member.user) === idOf(userId) && member.role === "admin"
  );
}

function isActive(task) {
  return !["review", "done", "closed"].includes(task.status);
}

reportsRouter.get("/control", async (req, res) => {
  const projects = await Project.find({ "members.user": req.user._id }).populate("members.user", "name email");
  const adminProjectIds = projects.filter((project) => isAdmin(project, req.user._id)).map((project) => project._id);
  const visibleProjectIds = projects.map((project) => project._id);
  const filter = {
    $or: [
      { project: { $in: adminProjectIds } },
      {
        project: { $in: visibleProjectIds },
        $or: [{ creator: req.user._id }, { assignee: req.user._id }, { observers: req.user._id }]
      }
    ]
  };

  const tasks = await Task.find(filter)
    .populate("project", "name")
    .populate("creator", "name email")
    .populate("assignee", "name email")
    .populate("observers", "name email")
    .sort({ dueDate: 1 });

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const overdue = tasks.filter((task) => task.dueDate < today && isActive(task));
  const waitingReview = tasks.filter((task) => ["review", "done"].includes(task.status));
  const unassigned = tasks.filter((task) => !task.assignee && !task.assigneeEmail && task.status !== "closed");
  const closedThisMonth = tasks.filter((task) => {
    const closed = task.status === "closed";
    const updatedAt = new Date(task.updatedAt);
    return closed && updatedAt.getMonth() === today.getMonth() && updatedAt.getFullYear() === today.getFullYear();
  });

  const assigneeMap = new Map();
  tasks.forEach((task) => {
    const key = task.assignee ? idOf(task.assignee) : task.assigneeEmail || "unassigned";
    const current = assigneeMap.get(key) || {
      key,
      name: task.assignee?.name || task.assigneeEmail || "Без ответственного",
      email: task.assignee?.email || task.assigneeEmail || "",
      active: 0,
      overdue: 0,
      review: 0,
      closed: 0
    };

    if (task.status === "closed") current.closed += 1;
    else current.active += 1;
    if (task.dueDate < today && isActive(task)) current.overdue += 1;
    if (["review", "done"].includes(task.status)) current.review += 1;

    assigneeMap.set(key, current);
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
    if (task.dueDate < today && isActive(task)) current.overdue += 1;
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
    byProject: Array.from(projectMap.values()).sort((a, b) => b.active - a.active)
  });
});
