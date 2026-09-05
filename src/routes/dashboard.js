import express from "express";
import { requireRegularUser } from "../middleware/auth.js";
import { Notification } from "../models/Notification.js";
import { Task } from "../models/Task.js";
import { idOf, visibleTaskFilter, visibleNotificationFilter } from "../services/taskAccess.js";
import { asyncRoute } from "../middleware/asyncRoute.js";

export const dashboardRouter = express.Router();

dashboardRouter.use(requireRegularUser);

dashboardRouter.get("/", asyncRoute(async (req, res) => {
  const [taskFilter, notificationFilter] = await Promise.all([
    visibleTaskFilter(req.user._id), visibleNotificationFilter(req.user._id)
  ]);
  const [all, notifications] = await Promise.all([
    Task.find(taskFilter)
      .populate("project", "name isArchived archivedAt")
      .populate("creator", "name lastName email")
      .populate("assignee", "name lastName email")
      .populate("observers", "name lastName email")
      .sort({ updatedAt: -1, _id: -1 }),
    Notification.find(notificationFilter)
      .populate("project", "name")
      .populate("task", "description status")
      .sort({ createdAt: -1 })
      .limit(20)
  ]);

  const userId = idOf(req.user);
  res.json({
    all,
    initiated: all.filter((task) => idOf(task.creator) === userId),
    assigned: all.filter((task) => idOf(task.assignee) === userId),
    observing: all.filter((task) => task.observers.some((user) => idOf(user) === userId)),
    notifications
  });
}));

dashboardRouter.patch("/notifications/:notificationId/read", asyncRoute(async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { ...await visibleNotificationFilter(req.user._id), _id: req.params.notificationId },
    { read: true },
    { new: true }
  );

  if (!notification) {
    return res.status(404).json({ message: "Notification not found" });
  }

  res.json({ notification });
}));
