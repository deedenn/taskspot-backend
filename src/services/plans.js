import { Organization } from "../models/Organization.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";

export const PLANS = {
  free: {
    key: "free",
    name: "Бесплатный",
    price: "0 ₽",
    limits: {
      organizations: 1,
      users: 3,
      projects: 2,
      activeTasks: 50,
      attachments: 20,
      templates: 3,
      recurringTasks: 0,
      historyDays: 30
    }
  },
  team: {
    key: "team",
    name: "Команда",
    price: "990 ₽/мес",
    limits: {
      organizations: 3,
      users: 20,
      projects: 50,
      activeTasks: 1000,
      attachments: 500,
      templates: 50,
      recurringTasks: 100,
      historyDays: 365
    }
  },
  business: {
    key: "business",
    name: "Бизнес",
    price: "2490 ₽/мес",
    limits: {
      organizations: 10,
      users: 100,
      projects: 200,
      activeTasks: 10000,
      attachments: 5000,
      templates: 200,
      recurringTasks: 1000,
      historyDays: 0
    }
  }
};

export function planFor(organization) {
  return PLANS[organization?.plan] || PLANS.free;
}

export async function ensureDefaultOrganization(user) {
  const existing = await Organization.findOne({ "members.user": user._id });
  if (existing) return existing;

  return Organization.create({
    name: `${user.name || "Моя"} компания`,
    plan: "free",
    members: [{ user: user._id, role: "owner" }]
  });
}

export async function organizationUsage(organization) {
  const projects = await Project.find({ organization: organization._id }).select("_id members templates");
  const projectIds = projects.map((project) => project._id);
  const users = new Set();
  let templates = 0;

  organization.members.forEach((member) => users.add(member.user.toString()));
  projects.forEach((project) => {
    project.members.forEach((member) => users.add(member.user.toString()));
    templates += project.templates?.length || 0;
  });

  const [activeTasks, attachments, recurringTasks] = await Promise.all([
    Task.countDocuments({ project: { $in: projectIds }, status: { $ne: "closed" } }),
    Task.aggregate([
      { $match: { project: { $in: projectIds } } },
      { $project: { count: { $size: "$attachments" } } },
      { $group: { _id: null, total: { $sum: "$count" } } }
    ]),
    Task.countDocuments({ project: { $in: projectIds }, "recurrence.enabled": true, status: { $ne: "closed" } })
  ]);

  return {
    users: users.size,
    projects: projects.length,
    activeTasks,
    attachments: attachments[0]?.total || 0,
    templates,
    recurringTasks
  };
}

export async function organizationPayload(organization) {
  const usage = await organizationUsage(organization);
  const plan = planFor(organization);

  return {
    organization,
    plan,
    usage,
    limits: plan.limits
  };
}

export function limitExceeded({ plan, usage, key, increment = 1 }) {
  const limit = plan.limits[key];
  return Number.isFinite(limit) && (usage[key] || 0) + increment > limit;
}
