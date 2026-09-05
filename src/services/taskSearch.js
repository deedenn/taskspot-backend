import mongoose from "mongoose";
import { User } from "../models/User.js";

function badQuery(message) {
  const error = new Error(message);
  error.statusCode = 400;
  throw error;
}

export async function taskSearchFilter(project, query) {
  const filter = {};
  if (query.hideClosed === "true") filter.status = { $ne: "closed" };
  if (query.status) {
    if (!["open", "in_progress", "review", "closed"].includes(query.status)) badQuery("Некорректный статус");
    filter.status = query.status === "review" ? { $in: ["review", "done"] } : query.status;
    if (query.hideClosed === "true" && query.status === "closed") filter._id = { $in: [] };
  }
  if (query.category) {
    if (!project.categories.some((category) => String(category._id) === query.category)) badQuery("Категория не найдена в проекте");
    filter.categories = query.category;
  }
  if (query.assignee) {
    if (!mongoose.isValidObjectId(query.assignee)) badQuery("Некорректный ответственный");
    filter.assignee = query.assignee;
  }
  const text = String(query.search || "").trim().slice(0, 200);
  if (text) {
    const expression = new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const userIds = await User.find({
      _id: { $in: project.members.map((member) => member.user) },
      $or: [{ name: expression }, { lastName: expression }, { email: expression },
        { $expr: { $regexMatch: {
          input: { $concat: [{ $ifNull: ["$name", ""] }, " ", { $ifNull: ["$lastName", ""] }] },
          regex: expression.source,
          options: "i"
        } } }]
    }).distinct("_id");
    const categories = project.categories.filter((category) => expression.test(category.name)).map((category) => category._id);
    filter.$or = [
      { description: expression }, { "comments.text": expression }, { assigneeEmail: expression },
      { creator: { $in: userIds } }, { assignee: { $in: userIds } }, { observers: { $in: userIds } },
      { categories: { $in: categories } }
    ];
  }
  return filter;
}
