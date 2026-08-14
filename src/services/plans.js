import { Organization } from "../models/Organization.js";
import { Notification } from "../models/Notification.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { User } from "../models/User.js";

export const PLANS = {
  free: {
    key: "free",
    name: "Бесплатный",
    price: "0 ₽",
    monthlyPrice: 0,
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
    monthlyPrice: 990,
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
    monthlyPrice: 2490,
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
  if (
    organization?.plan &&
    organization.plan !== "free" &&
    organization.planExpiresAt &&
    organization.planExpiresAt < new Date()
  ) {
    return PLANS.free;
  }

  return PLANS[organization?.plan] || PLANS.free;
}

export async function ensureDefaultOrganization(user) {
  const existing = await Organization.findOne({
    $or: [
      { personalOwner: user._id },
      {
        personalOwner: { $exists: false },
        members: {
          $elemMatch: {
            user: user._id,
            role: "owner"
          }
        }
      }
    ]
  });

  if (existing && !existing.personalOwner) {
    existing.personalOwner = user._id;
    await existing.save();
  }

  if (existing) return existing;

  return Organization.create({
    name: `${user.name || "Моя"} компания`,
    plan: "free",
    personalOwner: user._id,
    members: [{ user: user._id, role: "owner" }]
  });
}

export async function organizationUsage(organization) {
  const projects = await Project.find({ organization: organization._id }).select("_id members invitations templates isArchived archivedAt");
  const projectIds = projects.map((project) => project._id);
  const activeProjectIds = projects
    .filter((project) => !project.isArchived && !project.archivedAt)
    .map((project) => project._id);
  const ownerIds = new Set(
    organization.members
      .filter((member) => member.role === "owner")
      .map((member) => member.user.toString())
  );
  const memberUserIds = new Set();
  const extraMemberUserIds = new Set();
  const pendingInviteEmails = new Set();
  let templates = 0;

  organization.members.forEach((member) => memberUserIds.add(member.user.toString()));
  projects.forEach((project) => {
    project.members.forEach((member) => memberUserIds.add(member.user.toString()));
    project.invitations
      .filter((invitation) => invitation.status === "pending")
      .forEach((invitation) => pendingInviteEmails.add(invitation.email));
    templates += project.templates?.length || 0;
  });

  memberUserIds.forEach((userId) => {
    if (!ownerIds.has(userId)) {
      extraMemberUserIds.add(userId);
    }
  });

  const memberEmails = await User.find({ _id: { $in: [...memberUserIds] } }).distinct("email");
  memberEmails.forEach((email) => pendingInviteEmails.delete(email));

  const [activeTasks, attachments, recurringTasks] = await Promise.all([
    Task.countDocuments({ project: { $in: activeProjectIds }, status: { $ne: "closed" } }),
    Task.aggregate([
      { $match: { project: { $in: projectIds } } },
      { $project: { count: { $size: "$attachments" } } },
      { $group: { _id: null, total: { $sum: "$count" } } }
    ]),
    Task.countDocuments({ project: { $in: activeProjectIds }, "recurrence.enabled": true, status: { $ne: "closed" } })
  ]);

  return {
    users: extraMemberUserIds.size + pendingInviteEmails.size,
    memberUsers: memberUserIds.size,
    extraMemberUsers: extraMemberUserIds.size,
    pendingInvitations: pendingInviteEmails.size,
    memberUserIds: [...memberUserIds],
    extraMemberUserIds: [...extraMemberUserIds],
    pendingInviteEmails: [...pendingInviteEmails],
    projects: activeProjectIds.length,
    totalProjects: projects.length,
    archivedProjects: projects.length - activeProjectIds.length,
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

export function limitPayload({ organization, plan, usage, key, increment = 1, message }) {
  const limit = plan.limits[key];
  const used = usage[key] || 0;

  return {
    code: "limit_exceeded",
    key,
    message: message || "Лимит текущего тарифа исчерпан",
    organization: organization
      ? {
          id: organization._id,
          name: organization.name
        }
      : undefined,
    plan: {
      key: plan.key,
      name: plan.name
    },
    usage: {
      used,
      requested: increment,
      limit
    }
  };
}

const limitLabels = {
  users: "участников",
  projects: "активных проектов",
  activeTasks: "активных задач",
  attachments: "вложений",
  templates: "шаблонов",
  recurringTasks: "повторяющихся задач"
};

export async function notifyOrganizationLimit({ organization, plan, usage, key }) {
  if (!organization) return;

  const recipients = [
    ...new Set(
      organization.members
        .filter((member) => ["owner", "admin"].includes(member.role))
        .map((member) => member.user.toString())
    )
  ];

  if (!recipients.length) return;

  const label = limitLabels[key] || "ресурсов";
  const used = usage[key] || 0;
  const limit = plan.limits[key];
  const message = `Лимит тарифа «${plan.name}» исчерпан: ${used} / ${limit} ${label}. Перейдите на следующий тариф, чтобы продолжить работу.`;
  const recentSince = new Date(Date.now() - 6 * 60 * 60 * 1000);

  await Promise.all(
    recipients.map(async (userId) => {
      const recent = await Notification.exists({
        user: userId,
        organization: organization._id,
        message,
        createdAt: { $gte: recentSince }
      });

      if (recent) return;

      await Notification.create({
        user: userId,
        organization: organization._id,
        message
      });
    })
  );
}
