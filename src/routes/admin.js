import express from "express";
import { requireSuperAdmin } from "../middleware/superAdmin.js";
import { BillingRequest } from "../models/BillingRequest.js";
import { Organization } from "../models/Organization.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { User } from "../models/User.js";
import { billingIntegrationPayload } from "../services/billingProviders.js";
import { checkEmailTransport, emailRuntimeConfig } from "../services/email.js";
import { PLANS } from "../services/plans.js";

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

function daysFromNow(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

function percent(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function addMonths(date, months) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function billingRequestPayload(request) {
  if (!request) return null;

  return {
    _id: request._id,
    organization: request.organization,
    requestedBy: request.requestedBy,
    plan: request.plan,
    periodMonths: request.periodMonths,
    amount: request.amount,
    currency: request.currency,
    status: request.status,
    contactName: request.contactName,
    contactEmail: request.contactEmail,
    contactPhone: request.contactPhone,
    comment: request.comment,
    adminNote: request.adminNote,
    planExpiresAt: request.planExpiresAt,
    payment: request.payment,
    processedAt: request.processedAt,
    processedBy: request.processedBy,
    createdAt: request.createdAt,
    updatedAt: request.updatedAt
  };
}

async function attachUserPlans(users) {
  const userIds = users.map((user) => user._id);
  const userIdSet = new Set(userIds.map((id) => id.toString()));
  const organizations = await Organization.find({ "members.user": { $in: userIds } })
    .select("name plan planExpiresAt planAssignedAt planSource planChangeReason billingNote members")
    .lean();

  const plansByUser = new Map();

  for (const organization of organizations) {
    for (const member of organization.members || []) {
      const userId = member.user?.toString();
      if (!userIdSet.has(userId)) continue;

      const plans = plansByUser.get(userId) || [];
      plans.push({
        organizationId: organization._id,
        organization: organization.name,
        role: member.role,
        membersCount: organization.members?.length || 0,
        plan: organization.plan || "free",
        planExpiresAt: organization.planExpiresAt,
        planAssignedAt: organization.planAssignedAt,
        planSource: organization.planSource || "system",
        planChangeReason: organization.planChangeReason || "",
        billingNote: organization.billingNote || ""
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

adminRouter.get("/email/diagnostics", async (req, res) => {
  const shouldProbe = req.query.probe === "1" || req.query.probe === "true";
  const diagnostics = shouldProbe ? await checkEmailTransport() : emailRuntimeConfig();

  res.status(diagnostics.ok === false && shouldProbe ? 503 : 200).json({
    diagnostics,
    hint: shouldProbe
      ? "Если tcp.ok=false с timeout/ETIMEDOUT на всех портах, исходящие SMTP-порты заблокированы на стороне хостинга или сети."
      : "Добавьте ?probe=1, чтобы выполнить TCP/SMTP-проверку всех настроенных портов."
  });
});

adminRouter.get("/overview", async (req, res) => {
  const periodDays = Number(req.query.periodDays) || 30;
  const since = daysAgo(periodDays);
  const activeSince = daysAgo(30);
  const now = new Date();
  const expiresSoon = daysFromNow(14);

  const [
    totalUsers,
    activeUsers,
    inactiveUsers,
    blockedUsers,
    newUsers,
    totalOrganizations,
    organizationsByPlan,
    expiringPaidOrganizations,
    expiredPaidOrganizations,
    manualPlanOrganizations,
    pendingBillingRequests,
    approvedBillingRequests,
    receivedRevenue,
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
    Organization.countDocuments({
      plan: { $ne: "free" },
      planExpiresAt: { $gte: now, $lte: expiresSoon }
    }),
    Organization.countDocuments({
      plan: { $ne: "free" },
      planExpiresAt: { $lt: now }
    }),
    Organization.countDocuments({ planSource: "manual" }),
    BillingRequest.countDocuments({ status: "pending" }),
    BillingRequest.countDocuments({ status: "approved", createdAt: { $gte: since } }),
    BillingRequest.aggregate([
      { $match: { status: "approved" } },
      { $group: { _id: null, total: { $sum: "$amount" } } }
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
      .select("name lastName email status isSuperAdmin lastLoginAt createdAt")
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
      manualPlans: manualPlanOrganizations,
      expiringPaid: expiringPaidOrganizations,
      expiredPaid: expiredPaidOrganizations,
      byPlan: planBreakdown
    },
    revenue: {
      received: receivedRevenue[0]?.total || 0,
      estimatedMonthly: estimatedMonthlyRevenue,
      estimatedAnnual: estimatedMonthlyRevenue * 12,
      paidConversionRate: percent(paidOrganizations, totalOrganizations)
    },
    billing: {
      pendingRequests: pendingBillingRequests,
      approvedInPeriod: approvedBillingRequests,
      integration: billingIntegrationPayload()
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

adminRouter.get("/billing-requests", async (req, res) => {
  const status = String(req.query.status || "pending").trim();
  const filter = {};

  if (status !== "all") {
    if (!["pending", "approved", "rejected", "cancelled"].includes(status)) {
      return res.status(400).json({ message: "Некорректный статус заявки" });
    }
    filter.status = status;
  }

  const requests = await BillingRequest.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .populate("organization", "name plan planExpiresAt members")
    .populate("requestedBy", "name lastName email phone")
    .populate("processedBy", "name lastName email")
    .lean();

  res.json({
    billingRequests: requests.map(billingRequestPayload),
    plans: Object.values(PLANS),
    billing: billingIntegrationPayload()
  });
});

adminRouter.patch("/billing-requests/:requestId", async (req, res) => {
  const { status, expiresAt, adminNote, paymentStatus = "paid" } = req.body;

  if (!["approved", "rejected", "cancelled"].includes(status)) {
    return res.status(400).json({ message: "Выберите итоговый статус заявки" });
  }

  const request = await BillingRequest.findById(req.params.requestId);

  if (!request) {
    return res.status(404).json({ message: "Заявка не найдена" });
  }

  if (request.status !== "pending") {
    return res.status(400).json({ message: "Можно обработать только новую заявку" });
  }

  const organization = await Organization.findById(request.organization);

  if (!organization) {
    return res.status(404).json({ message: "Компания заявки не найдена" });
  }

  let planExpiresAt;
  if (status === "approved") {
    if (expiresAt) {
      const parsedDate = new Date(expiresAt);
      if (Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({ message: "Некорректная дата окончания тарифа" });
      }
      planExpiresAt = parsedDate;
    } else {
      planExpiresAt = addMonths(new Date(), request.periodMonths || 1);
    }

    organization.plan = request.plan;
    organization.planExpiresAt = planExpiresAt;
    organization.planAssignedAt = new Date();
    organization.planAssignedBy = req.user._id;
    organization.planSource = "manual";
    organization.planChangeReason =
      typeof adminNote === "string" && adminNote.trim()
        ? adminNote.trim()
        : `Заявка на тариф ${PLANS[request.plan]?.name || request.plan} на ${request.periodMonths} мес.`;
    await organization.save();
  }

  request.status = status;
  request.adminNote = typeof adminNote === "string" ? adminNote.trim() : "";
  request.processedAt = new Date();
  request.processedBy = req.user._id;
  request.planExpiresAt = planExpiresAt;
  request.payment = {
    ...(request.payment?.toObject ? request.payment.toObject() : request.payment || {}),
    provider: request.payment?.provider || "manual",
    status: status === "approved" ? paymentStatus : "not_required",
    paidAt: status === "approved" && paymentStatus === "paid" ? new Date() : request.payment?.paidAt
  };
  await request.save();

  await request.populate("organization", "name plan planExpiresAt members");
  await request.populate("requestedBy", "name lastName email phone");
  await request.populate("processedBy", "name lastName email");

  res.json({
    billingRequest: billingRequestPayload(request),
    organization: {
      _id: organization._id,
      name: organization.name,
      plan: organization.plan,
      planExpiresAt: organization.planExpiresAt,
      planAssignedAt: organization.planAssignedAt,
      planSource: organization.planSource,
      planChangeReason: organization.planChangeReason
    }
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
      .select("name lastName email status isSuperAdmin lastLoginAt createdAt")
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

adminRouter.patch("/users/:userId/plan", async (req, res) => {
  const { organizationId, plan, expiresAt, note } = req.body;

  if (!Object.prototype.hasOwnProperty.call(PLANS, plan)) {
    return res.status(400).json({ message: "Неизвестный тариф" });
  }

  const user = await User.findById(req.params.userId).select(
    "name lastName email status isSuperAdmin lastLoginAt createdAt"
  );

  if (!user) {
    return res.status(404).json({ message: "Пользователь не найден" });
  }

  if (user.isSuperAdmin) {
    return res.status(400).json({ message: "Тариф суперadmin нельзя менять здесь" });
  }

  let planExpiresAt;
  if (expiresAt === null || expiresAt === "") {
    planExpiresAt = undefined;
  } else if (expiresAt) {
    const parsedDate = new Date(expiresAt);
    if (Number.isNaN(parsedDate.getTime())) {
      return res.status(400).json({ message: "Некорректная дата окончания тарифа" });
    }
    planExpiresAt = parsedDate;
  }

  let organization;

  if (organizationId) {
    organization = await Organization.findOne({
      _id: organizationId,
      "members.user": user._id
    });
  } else {
    const organizations = await Organization.find({ "members.user": user._id }).sort({ createdAt: 1 });
    organization =
      organizations.find((item) =>
        item.members.some((member) => member.user.toString() === user._id.toString() && member.role === "owner")
      ) || organizations[0];
  }

  if (!organization) {
    return res.status(404).json({ message: "У пользователя нет организации для назначения тарифа" });
  }

  organization.plan = plan;
  organization.planExpiresAt = planExpiresAt;
  organization.planAssignedAt = new Date();
  organization.planAssignedBy = req.user._id;
  organization.planSource = "manual";
  organization.planChangeReason = typeof note === "string" ? note.trim() : "";
  await organization.save();

  const [payload] = await attachUserPlans([
    user.toObject({
      versionKey: false
    })
  ]);

  res.json({
    user: payload,
    organization: {
      _id: organization._id,
      name: organization.name,
      plan: organization.plan,
      planExpiresAt: organization.planExpiresAt,
      planAssignedAt: organization.planAssignedAt,
      planSource: organization.planSource,
      planChangeReason: organization.planChangeReason
    }
  });
});
