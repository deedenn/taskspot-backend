import express from "express";
import { requireRegularUser } from "../middleware/auth.js";
import { Notification } from "../models/Notification.js";

export const notificationsRouter = express.Router();

notificationsRouter.use(requireRegularUser);

notificationsRouter.get("/", async (req, res) => {
  const notifications = await Notification.find({ user: req.user._id })
    .populate("organization", "name plan")
    .populate("project", "name")
    .populate("task", "description status")
    .sort({ createdAt: -1 })
    .limit(30);

  res.json({ notifications });
});

notificationsRouter.patch("/read-all", async (req, res) => {
  await Notification.updateMany({ user: req.user._id, read: false }, { read: true });
  res.json({ ok: true });
});

notificationsRouter.patch("/:notificationId/read", async (req, res) => {
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
