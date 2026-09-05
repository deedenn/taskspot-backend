import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";

export function idOf(value) {
  return String(value?._id || value || "");
}

export function projectMember(project, userId) {
  return project?.members.find((member) => idOf(member.user) === idOf(userId));
}

export function isProjectAdmin(project, userId) {
  return projectMember(project, userId)?.role === "admin";
}

export function canViewTask(task, project, userId) {
  return Boolean(projectMember(project, userId)) && (
    isProjectAdmin(project, userId) || idOf(task.creator) === idOf(userId) ||
    idOf(task.assignee) === idOf(userId) || task.observers.some((user) => idOf(user) === idOf(userId))
  );
}

export function taskFilterForProjects(projects, userId) {
  return {
    $or: [
      { project: { $in: projects.filter((project) => isProjectAdmin(project, userId)).map((project) => project._id) } },
      {
        project: { $in: projects.map((project) => project._id) },
        $or: [{ creator: userId }, { assignee: userId }, { observers: userId }]
      }
    ]
  };
}

export async function visibleTaskFilter(userId) {
  const projects = await Project.find({ "members.user": userId }).select("members");
  return taskFilterForProjects(projects, userId);
}

export async function visibleNotificationFilter(userId) {
  const projects = await Project.find({ "members.user": userId }).select("members");
  const taskIds = await Task.find(taskFilterForProjects(projects, userId)).distinct("_id");
  return {
    user: userId,
    $or: [
      { task: { $in: taskIds }, project: { $in: projects.map((project) => project._id) } },
      { task: null, project: { $in: projects.map((project) => project._id) } },
      { task: null, project: null }
    ]
  };
}
