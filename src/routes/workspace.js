import express from "express";
import mongoose from "mongoose";
import { requireRegularUser } from "../middleware/auth.js";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { User } from "../models/User.js";
import { taskFilterForProjects } from "../services/taskAccess.js";

export const workspaceRouter = express.Router();
workspaceRouter.use(requireRegularUser);
const invalid = (message = "Некорректные параметры поиска", statusCode = 400) => Object.assign(new Error(message), { statusCode });

function queryOptions(query) {
  for (const key of ["q", "projectId", "assignee", "page", "limit"]) {
    if (query[key] !== undefined && typeof query[key] !== "string") throw invalid();
  }
  const q = (query.q || "").trim();
  if (q.length > 200) throw invalid("Поиск ограничен 200 символами");
  const page = Number(query.page || 1), limit = Number(query.limit || 20);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid();
  if (query.projectId && !mongoose.isObjectIdOrHexString(query.projectId)) throw invalid("Некорректный проект");
  if (query.assignee && query.assignee !== "unassigned" &&
      !mongoose.isObjectIdOrHexString(query.assignee) && !query.assignee.startsWith("pending:")) throw invalid("Некорректный ответственный");
  return { q, page, limit };
}

function assigneeFilter(key) {
  if (key === "unassigned") return { assignee: null, $or: [{ assigneeEmail: null }, { assigneeEmail: "" }] };
  if (key.startsWith("pending:")) return { assignee: null, assigneeEmail: key.slice(8) };
  return { assignee: new mongoose.Types.ObjectId(key) };
}

async function scope(req) {
  const options = queryOptions(req.query);
  const projects = await Project.find({ "members.user": req.user._id }).select("name members categories isArchived archivedAt").lean();
  const selected = req.query.projectId ? projects.filter((project) => String(project._id) === req.query.projectId) : projects;
  if (req.query.projectId && !selected.length) throw invalid("Нет доступа к проекту", 403);
  const filters = [taskFilterForProjects(selected, req.user._id)];
  if (req.query.assignee) filters.push(assigneeFilter(req.query.assignee));
  return { options, projects, selected, filters };
}

function publicTaskQuery(filter) {
  return Task.find(filter).select("description project creator assignee assigneeEmail dueDate status priority categories")
    .populate("project", "name isArchived archivedAt")
    .populate("assignee", "name lastName avatarUrl")
    .sort({ dueDate: 1, _id: 1 });
}

workspaceRouter.get("/tasks", asyncRoute(async (req, res) => {
  const { options, projects, selected, filters } = await scope(req);
  const terms = [...new Set(options.q.split(/\s+/).filter(Boolean))];
  if (terms.length > 12) throw invalid("Введите не более 12 слов");
  if (terms.length) {
    const users = await User.find({ _id: { $in: selected.flatMap((project) => project.members.map((member) => member.user)) } })
      .select("name lastName email").lean();
    for (const term of terms) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const expression = new RegExp(escaped, "i");
      const ids = users.filter((user) => expression.test([user.name, user.lastName, user.email].join(" "))).map((user) => user._id);
      const projectIds = selected.filter((project) => expression.test(project.name)).map((project) => project._id);
      const categoryIds = selected.flatMap((project) => project.categories.filter((category) => expression.test(category.name)).map((category) => category._id));
      filters.push({ $or: [
        { description: expression }, { "comments.text": expression }, { "checklist.text": expression },
        { "attachments.name": expression }, { assigneeEmail: expression },
        { creator: { $in: ids } }, { assignee: { $in: ids } }, { observers: { $in: ids } },
        { project: { $in: projectIds } }, { categories: { $in: categoryIds } }
      ] });
    }
  }
  const filter = { $and: filters };
  const total = await Task.countDocuments(filter);
  const page = Math.min(options.page, Math.max(1, Math.ceil(total / options.limit)));
  const tasks = await publicTaskQuery(filter).skip((page - 1) * options.limit).limit(options.limit);
  res.set("Cache-Control", "no-store");
  res.json({ tasks, pagination: { page, limit: options.limit, total },
    projects: projects.map((project) => ({ _id: project._id, name: project.name })) });
}));

workspaceRouter.get("/assignees", asyncRoute(async (req, res) => {
  const { options, projects, filters } = await scope(req);
  const filter = { $and: filters.slice(0, 1) };
  const grouping = [
    { $match: filter },
    { $group: {
      _id: { $cond: [{ $ne: [{ $ifNull: ["$assignee", null] }, null] }, { $toString: "$assignee" },
        { $cond: [{ $ne: [{ $ifNull: ["$assigneeEmail", ""] }, ""] }, { $concat: ["pending:", "$assigneeEmail"] }, "unassigned"] }] },
      total: { $sum: 1 },
      open: { $sum: { $cond: [{ $eq: ["$status", "open"] }, 1, 0] } },
      inProgress: { $sum: { $cond: [{ $eq: ["$status", "in_progress"] }, 1, 0] } },
      review: { $sum: { $cond: [{ $in: ["$status", ["review", "done"]] }, 1, 0] } },
      closed: { $sum: { $cond: [{ $eq: ["$status", "closed"] }, 1, 0] } }
    } },
    { $sort: { total: -1, _id: 1 } }
  ];
  const allGroups = await Task.aggregate(grouping);
  const users = await User.find({ _id: { $in: allGroups.filter((item) => mongoose.isObjectIdOrHexString(item._id)).map((item) => item._id) } })
    .select("name lastName avatarUrl").lean();
  const userMap = new Map(users.map((user) => [String(user._id), user]));
  const people = allGroups.map((group) => ({
    ...group, key: group._id, user: userMap.get(group._id) || null,
    name: userMap.has(group._id) ? [userMap.get(group._id).name, userMap.get(group._id).lastName].filter(Boolean).join(" ") :
      group._id === "unassigned" ? "Без ответственного" : group._id.startsWith("pending:") ? group._id.slice(8) + " · ожидает регистрации" : "Удалённый пользователь"
  }));
  const matchingPeople = req.query.assignee ? people.filter((person) => person.key === req.query.assignee) : people;
  const page = Math.min(options.page, Math.max(1, Math.ceil(matchingPeople.length / options.limit)));
  const groups = matchingPeople.slice((page - 1) * options.limit, page * options.limit);
  for (const group of groups) {
    group.tasks = await publicTaskQuery({ $and: [...filters, assigneeFilter(group.key)] }).limit(10);
  }
  res.set("Cache-Control", "no-store");
  res.json({ groups, pagination: { page, limit: options.limit, total: matchingPeople.length },
    people: people.map(({ key, name }) => ({ value: key, label: name })),
    projects: projects.map((project) => ({ _id: project._id, name: project.name })) });
}));
