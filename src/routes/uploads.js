import express from "express";
import { requireAuth } from "../middleware/auth.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { attachmentKey, isStorageConfigured, maxUploadSize, safeFileName, uploadUrlForKey } from "../services/storage.js";

export const uploadsRouter = express.Router();

uploadsRouter.use(requireAuth);

function asString(value) {
  return value?.toString();
}

function projectMember(project, userId) {
  return project.members.find((member) => asString(member.user) === asString(userId));
}

function isProjectAdmin(project, userId) {
  return projectMember(project, userId)?.role === "admin";
}

function canAttachFile(task, project, userId) {
  return (
    isProjectAdmin(project, userId) ||
    asString(task.creator) === asString(userId) ||
    asString(task.assignee) === asString(userId)
  );
}

uploadsRouter.post("/presign", async (req, res) => {
  if (!isStorageConfigured()) {
    return res.status(503).json({ message: "Файловое хранилище пока не настроено" });
  }

  const fileName = safeFileName(req.body.fileName);
  const mimeType = String(req.body.mimeType || req.body.contentType || "application/octet-stream");
  const size = Number(req.body.size || 0);
  const taskId = req.body.taskId;

  if (!fileName) {
    return res.status(400).json({ message: "File name is required" });
  }

  if (!taskId) {
    return res.status(400).json({ message: "Task is required for attachment upload" });
  }

  if (!Number.isFinite(size) || size <= 0 || size > maxUploadSize()) {
    return res.status(400).json({ message: "Недопустимый размер файла" });
  }

  const task = await Task.findById(taskId);
  if (!task) {
    return res.status(404).json({ message: "Task not found" });
  }

  const project = await Project.findById(task.project);
  if (!project || !projectMember(project, req.user._id)) {
    return res.status(403).json({ message: "Task access denied" });
  }

  if (!canAttachFile(task, project, req.user._id)) {
    return res.status(403).json({ message: "Only project admin, task creator or assignee can add attachments" });
  }

  const key = attachmentKey({ projectId: project._id, taskId: task._id, userId: req.user._id, fileName });
  const uploadUrl = uploadUrlForKey(key);

  res.json({
    uploadUrl,
    attachment: {
      name: fileName,
      key,
      mimeType,
      size
    }
  });
});
