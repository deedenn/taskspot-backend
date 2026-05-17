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

adminRouter.use(requireSuperAdmin);

adminRouter.get("/overview", async (req, res) => {
  const periodDays = Number(req.query.periodDays) || 30;
  const since = daysAgo(periodDays);
  const activeSince = daysAgo(30);

  const [
    totalUsers,
    activeUsers,
    inactiveUsers,
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
      status: "active",
      $or: [{ lastLoginAt: { $gte: activeSince } }, { createdAt: { $gte: activeSince } }]
    }),
    User.countDocuments({
      $or: [
        { status: "inactive" },
        {
          status: "active",
          lastLoginAt: { $exists: true, $lt: activeSince }
        },
        {
          status: "active",
          lastLoginAt: { $exists: false },
          createdAt: { $lt: activeSince }
        }
      ]
    }),
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
