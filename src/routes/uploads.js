import express from "express";
import { requireRegularUser } from "../middleware/auth.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { projectMember, isProjectAdmin } from "../services/taskAccess.js";
import { attachmentKey, isStorageConfigured, maxUploadSize, projectAvatarKey, safeFileName, uploadUrlForKey } from "../services/storage.js";

export const uploadsRouter = express.Router();

uploadsRouter.use(requireRegularUser);

function asString(value) {
  return value?._id ? value._id.toString() : value?.toString();
}

function projectCreatorId(project) {
  const explicitCreator = asString(project.createdBy);
  if (explicitCreator) return explicitCreator;

  return asString(project.members.find((member) => member.role === "admin")?.user);
}

function isProjectCreator(project, userId) {
  return projectCreatorId(project) === asString(userId);
}

function canAttachFile(task, project, userId) {
  return (
    isProjectAdmin(project, userId) ||
    asString(task.creator) === asString(userId) ||
    asString(task.assignee) === asString(userId)
  );
}

uploadsRouter.post("/project-avatar/presign", async (req, res) => {
  if (!isStorageConfigured()) {
    return res.status(503).json({ message: "Файловое хранилище пока не настроено" });
  }

  const projectId = req.body.projectId;
  const fileName = safeFileName(req.body.fileName);
  const mimeType = String(req.body.mimeType || req.body.contentType || "");
  const size = Number(req.body.size || 0);
  const maxAvatarSize = Math.min(maxUploadSize(), 5 * 1024 * 1024);

  if (!projectId) {
    return res.status(400).json({ message: "Project is required for avatar upload" });
  }

  if (!fileName) {
    return res.status(400).json({ message: "File name is required" });
  }

  if (!mimeType.startsWith("image/")) {
    return res.status(400).json({ message: "Аватар проекта должен быть изображением" });
  }

  if (!Number.isFinite(size) || size <= 0 || size > maxAvatarSize) {
    return res.status(400).json({ message: "Аватар проекта должен быть меньше 5 МБ" });
  }

  const project = await Project.findById(projectId);
  if (!project || !projectMember(project, req.user._id)) {
    return res.status(403).json({ message: "Project access denied" });
  }

  if (project.isArchived || project.archivedAt) {
    return res.status(409).json({ message: "Archived project is available for viewing only" });
  }

  if (!isProjectCreator(project, req.user._id)) {
    return res.status(403).json({ message: "Project avatar can be changed only by project creator" });
  }

  const key = projectAvatarKey({ projectId: project._id, userId: req.user._id, fileName });
  const uploadUrl = uploadUrlForKey(key);

  res.json({
    uploadUrl,
    avatar: {
      name: fileName,
      key,
      mimeType,
      size
    }
  });
});

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

  if (project.isArchived || project.archivedAt) {
    return res.status(409).json({ message: "Archived project tasks are available for viewing only" });
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
