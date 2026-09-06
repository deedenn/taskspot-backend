import express from "express";
import { requireRegularUser } from "../middleware/auth.js";
import { requireSuperAdmin } from "../middleware/superAdmin.js";
import { asyncRoute } from "../middleware/asyncRoute.js";
import { User } from "../models/User.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { BillingRequest } from "../models/BillingRequest.js";
import { ProductEvent } from "../models/ProductEvent.js";
import { dateKey } from "../services/taskSchedule.js";
import { parsePeriod } from "../services/periodReports.js";
import { buildProductAnalytics } from "../services/productAnalytics.js";
export const analyticsRouter = express.Router();

analyticsRouter.post("/events", requireRegularUser, asyncRoute(async (req, res) => {
  if (!["active_day", "billing_viewed"].includes(req.body.event)) return res.status(400).json({ message: "Неизвестное событие" });
  await ProductEvent.init();
  const at = new Date(), day = dateKey(at, "Europe/Moscow");
  try {
    await ProductEvent.updateOne({ user: req.user._id, event: req.body.event, day }, { $setOnInsert: { at } }, { upsert: true });
  } catch (error) { if (error.code !== 11000) throw error; }
  res.sendStatus(204);
}));

analyticsRouter.get("/product", requireSuperAdmin, asyncRoute(async (req, res) => {
  const period = parsePeriod(req.query), now = new Date();
  const users = await User.find({ isSuperAdmin: { $ne: true }, createdAt: { $gte: period.start, $lt: period.end } })
    .select("_id createdAt emailVerifiedAt emailVerificationStatus").limit(10001).lean();
  if (users.length > 10000) return res.status(413).json({ message: "Сократите период: в когорте более 10 000 пользователей" });
  const ids = users.map((user) => user._id);
  const projects = await Project.aggregate([{ $match: { createdBy: { $in: ids } } }, { $group: { _id: "$createdBy", at: { $min: "$createdAt" } } }]);
  const tasks = await Task.aggregate([{ $match: { creator: { $in: ids }, recurrenceSource: { $exists: false } } }, { $group: { _id: "$creator", at: { $min: "$createdAt" } } }]);
  const payments = await BillingRequest.aggregate([{ $match: { requestedBy: { $in: ids }, "payment.status": "paid", "payment.paidAt": { $lte: now }, amount: { $gt: 0 } } }, { $group: { _id: "$requestedBy", at: { $min: "$payment.paidAt" } } }]);
  const coverage = await ProductEvent.findOne({ event: "active_day" }).sort({ at: 1 }).lean();
  const events = await ProductEvent.find({ user: { $in: ids }, at: { $gte: period.start, $lte: now } }).select("user event day").limit(500001).lean();
  if (events.length > 500000) return res.status(413).json({ message: "Слишком много событий. Сократите период когорты" });
  const daily = await ProductEvent.aggregate([{ $match: { event: "active_day", at: { $gte: period.start, $lt: period.end } } }, { $group: { _id: "$day", users: { $addToSet: "$user" } } }, { $project: { active: { $size: "$users" } } }, { $sort: { _id: 1 } }]);
  const revenue = await BillingRequest.aggregate([{ $match: { "payment.status": "paid", "payment.paidAt": { $gte: period.start, $lt: period.end }, amount: { $gt: 0 } } }, { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }]);
  res.set("Cache-Control", "no-store").json({ ...buildProductAnalytics({ users, projects, tasks, payments, events, coverageStart: coverage?.at || null, now }),
    period, daily: daily.map((row) => ({ day: row._id, active: row.active })), revenue: revenue[0]?.amount || 0, payments: revenue[0]?.count || 0 });
}));
