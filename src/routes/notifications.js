import express from "express";
import { requireRegularUser } from "../middleware/auth.js";
import { Notification } from "../models/Notification.js";
import { visibleNotificationFilter } from "../services/taskAccess.js";
import { asyncRoute } from "../middleware/asyncRoute.js";

export const notificationsRouter = express.Router();

notificationsRouter.use(requireRegularUser);

notificationsRouter.get("/", asyncRoute(async (req, res) => {
  const notifications = await Notification.find(await visibleNotificationFilter(req.user._id))
    .populate("organization", "name plan")
    .populate("project", "name")
    .populate("task", "description status")
    .sort({ createdAt: -1 })
    .limit(30);

  res.json({ notifications });
}));

notificationsRouter.patch("/read-all", async (req, res) => {
  await Notification.updateMany({ user: req.user._id, read: false }, { read: true });
  res.json({ ok: true });
});

notificationsRouter.patch("/:notificationId/read", asyncRoute(async (req, res) => {
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
