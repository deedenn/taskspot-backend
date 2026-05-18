import express from "express";
import { requireSuperAdmin } from "../middleware/superAdmin.js";
import { Organization } from "../models/Organization.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { User } from "../models/User.js";

export const adminRouter = express.Router();

const PLAN_REVENUE = {
  free: 0,
  team: 990,
  business: 2490
};

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

function percent(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function attachUserPlans(users) {
  const userIds = users.map((user) => user._id);
  const organizations = await Organization.find({ "members.user": { $in: userIds } })
    .select("name plan members.user")
    .lean();

  const plansByUser = new Map();

  for (const organization of organizations) {
    for (const member of organization.members || []) {
      const userId = member.user?.toString();
      if (!userIds.some((id) => id.toString() === userId)) continue;

      const plans = plansByUser.get(userId) || [];
      plans.push({
        organization: organization.name,
        plan: organization.plan || "free"
      });
      plansByUser.set(userId, plans);
    }
  }

  return users.map((user) => ({
    ...user,
    status: user.status || "active",
    plans: plansByUser.get(user._id.toString()) || []
  }));
}

adminRouter.use(requireSuperAdmin);

adminRouter.get("/overview", async (req, res) => {
  const periodDays = Number(req.query.periodDays) || 30;
  const since = daysAgo(periodDays);
  const activeSince = daysAgo(30);

  const [
    totalUsers,
    activeUsers,
    inactiveUsers,
    blockedUsers,
    newUsers,
    totalOrganizations,
    organizationsByPlan,
    totalProjects,
    newProjects,
    totalTasks,
    activeTasks,
    closedTasks,
    reviewTasks,
    overdueTasks,
    createdTasks,
    completedTasks,
    recentUsers
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({
      $and: [
        { $or: [{ status: "active" }, { status: { $exists: false } }] },
        { $or: [{ lastLoginAt: { $gte: activeSince } }, { createdAt: { $gte: activeSince } }] }
      ]
    }),
    User.countDocuments({
      $or: [
        { status: "inactive" },
        {
          $or: [{ status: "active" }, { status: { $exists: false } }],
          lastLoginAt: { $exists: true, $lt: activeSince }
        },
        {
          $or: [{ status: "active" }, { status: { $exists: false } }],
          lastLoginAt: { $exists: false },
          createdAt: { $lt: activeSince }
        }
      ]
    }),
    User.countDocuments({ status: "blocked" }),
    User.countDocuments({ createdAt: { $gte: since } }),
    Organization.countDocuments(),
    Organization.aggregate([
      { $group: { _id: "$plan", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]),
    Project.countDocuments(),
    Project.countDocuments({ createdAt: { $gte: since } }),
    Task.countDocuments(),
    Task.countDocuments({ status: { $ne: "closed" } }),
    Task.countDocuments({ status: "closed" }),
    Task.countDocuments({ status: { $in: ["review", "done"] } }),
    Task.countDocuments({ status: { $ne: "closed" }, dueDate: { $lt: new Date() } }),
    Task.countDocuments({ createdAt: { $gte: since } }),
    Task.countDocuments({ status: "closed", updatedAt: { $gte: since } }),
    User.find()
      .sort({ createdAt: -1 })
      .limit(8)
      .select("name email status isSuperAdmin lastLoginAt createdAt")
      .lean()
  ]);

  const planBreakdown = organizationsByPlan.map((item) => ({
    plan: item._id || "free",
    organizations: item.count,
    monthlyRevenue: item.count * (PLAN_REVENUE[item._id] || 0)
  }));
  const estimatedMonthlyRevenue = planBreakdown.reduce((sum, item) => sum + item.monthlyRevenue, 0);
  const paidOrganizations = planBreakdown
    .filter((item) => item.plan !== "free")
    .reduce((sum, item) => sum + item.organizations, 0);

  res.json({
    periodDays,
    users: {
      total: totalUsers,
      active: activeUsers,
      inactive: inactiveUsers,
      blocked: blockedUsers,
      newInPeriod: newUsers,
      activationRate: percent(activeUsers, totalUsers)
    },
    organizations: {
      total: totalOrganizations,
      paid: paidOrganizations,
      byPlan: planBreakdown
    },
    revenue: {
      received: 0,
      estimatedMonthly: estimatedMonthlyRevenue,
      estimatedAnnual: estimatedMonthlyRevenue * 12,
      paidConversionRate: percent(paidOrganizations, totalOrganizations)
    },
    projects: {
      total: totalProjects,
      newInPeriod: newProjects
    },
    tasks: {
      total: totalTasks,
      active: activeTasks,
      closed: closedTasks,
      review: reviewTasks,
      overdue: overdueTasks,
      createdInPeriod: createdTasks,
      completedInPeriod: completedTasks,
      completionRate: percent(closedTasks, totalTasks)
    },
    growth: {
      newUsers,
      newProjects,
      createdTasks,
      completedTasks
    },
    recentUsers
  });
});

adminRouter.get("/users", async (req, res) => {
  const page = Math.max(Number(req.query.page) || 1, 1);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const search = String(req.query.search || "").trim();
  const status = String(req.query.status || "").trim();
  const filter = {};
  const conditions = [];

  if (status === "active") {
    conditions.push({ $or: [{ status: "active" }, { status: { $exists: false } }] });
  } else if (["inactive", "blocked"].includes(status)) {
    filter.status = status;
  }

  if (search) {
    const regex = new RegExp(escapeRegex(search), "i");
    conditions.push({ $or: [{ name: regex }, { email: regex }] });
  }

  if (conditions.length) {
    filter.$and = conditions;
  }

  const [total, users] = await Promise.all([
    User.countDocuments(filter),
    User.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select("name email status isSuperAdmin lastLoginAt createdAt")
      .lean()
  ]);

  res.json({
    users: await attachUserPlans(users),
    pagination: {
      page,
      limit,
      total
    }
  });
});

adminRouter.patch("/users/:userId/status", async (req, res) => {
  const { status, blocked } = req.body;
  const nextStatus =
    typeof blocked === "boolean" ? (blocked ? "blocked" : "active") : status;

  if (!["active", "blocked"].includes(nextStatus)) {
    return res.status(400).json({ message: "Status must be active or blocked" });
  }

  if (req.params.userId === req.user._id.toString()) {
    return res.status(400).json({ message: "You cannot block your own account" });
  }

  const user = await User.findById(req.params.userId);

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  if (user.isSuperAdmin) {
    return res.status(400).json({ message: "Super admin accounts cannot be blocked here" });
  }

  user.status = nextStatus;
  await user.save();

  const [payload] = await attachUserPlans([
    user.toObject({
      versionKey: false,
      transform: (_doc, ret) => {
        delete ret.passwordHash;
        return ret;
      }
    })
  ]);

  res.json({ user: payload });
});
