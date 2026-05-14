import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { Notification } from "../models/Notification.js";
import { Task } from "../models/Task.js";

export const dashboardRouter = express.Router();

dashboardRouter.use(requireAuth);

dashboardRouter.get("/", async (req, res) => {
  const [initiated, assigned, observing, notifications] = await Promise.all([
    Task.find({ creator: req.user._id })
      .populate("project", "name")
      .populate("assignee", "name email")
      .sort({ updatedAt: -1 }),
    Task.find({ assignee: req.user._id })
      .populate("project", "name")
      .populate("creator", "name email")
      .sort({ updatedAt: -1 }),
    Task.find({ observers: req.user._id })
      .populate("project", "name")
      .populate("creator", "name email")
      .populate("assignee", "name email")
      .sort({ updatedAt: -1 }),
    Notification.find({ user: req.user._id })
      .populate("project", "name")
      .populate("task", "description status")
      .sort({ createdAt: -1 })
      .limit(20)
  ]);

  res.json({ initiated, assigned, observing, notifications });
});

dashboardRouter.patch("/notifications/:notificationId/read", async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.notificationId, user: req.user._id },
    { read: true },
    { new: true }
  );

  if (!notification) {
    return res.status(404).json({ message: "Notification not found" });
  }

  res.json({ notification });
});
