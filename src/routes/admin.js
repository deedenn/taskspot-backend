import express from "express";
import { requireSuperAdmin } from "../middleware/superAdmin.js";
import { BillingRequest } from "../models/BillingRequest.js";
import { BillingEvent } from "../models/BillingEvent.js";
import { PaymentOrder } from "../models/PaymentOrder.js";
import { PaymentRefund } from "../models/PaymentRefund.js";
import { Organization } from "../models/Organization.js";
import { Project } from "../models/Project.js";
import { Task } from "../models/Task.js";
import { User } from "../models/User.js";
import { billingIntegrationPayload } from "../services/billingProviders.js";
import { checkEmailTransport, emailRuntimeConfig } from "../services/email.js";
import { PLANS } from "../services/plans.js";
import {
  addCalendarMonths,
  applyManualSubscriptionChange,
  fiscalizationMaxAttempts,
  fiscalizePaymentOrder,
  fiscalizePaymentRefund,
  requestPaymentRefund
} from "../services/subscriptions.js";
import { overdueTaskFilter } from "../services/taskDeadline.js";
import { dateKey } from "../services/taskSchedule.js";
import { EmailJob } from "../models/EmailJob.js";
import { ProductEvent } from "../models/ProductEvent.js";
import { ServiceMetric } from "../models/ServiceMetric.js";

export const adminRouter = express.Router();

function daysFromNow(days) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return date;
}

function percent(part, total) {
  return total ? Math.round((part / total) * 100) : 0;
}

function changePercent(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100);
}

function countByKey(rows) {
  return Object.fromEntries(rows.map((row) => [row._id, row.count]));
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
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

adminRouter.get("/email/queue", asyncRoute(async (req, res) => {
  const [counts, jobs, kinds, privacyRejected] = await Promise.all([
    EmailJob.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    EmailJob.find().select("status attempts lastAttemptAt nextAttemptAt acceptedAt messageId lastError lastErrorCode")
      .sort({ updatedAt: -1 }).limit(50).lean(),
    EmailJob.aggregate([{ $group: { _id: { kind: "$context.kind", status: "$status" }, count: { $sum: 1 } } }]),
    EmailJob.countDocuments({ lastErrorCode: "EMAIL_PRIVACY_REJECTED" })
  ]);
  res.json({
    counts: Object.fromEntries(counts.map((row) => [row._id, row.count])),
    kinds: kinds.map((row) => ({ kind: row._id.kind || "unknown", status: row._id.status, count: row.count })),
    privacyRejected,
    jobs
  });
}));

adminRouter.post("/email/queue/:jobId/retry", asyncRoute(async (req, res) => {
  const job = await EmailJob.findOneAndUpdate({ _id: req.params.jobId, status: "failed" }, {
    $set: { status: "queued", attempts: 0, nextAttemptAt: new Date(), lastError: "", statusSynced: false }
  }, { new: true }).select("status attempts nextAttemptAt messageId");
  if (!job) return res.status(404).json({ message: "Неудачная отправка не найдена" });
  res.json({ job });
}));

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

adminRouter.get("/overview", asyncRoute(async (req, res) => {
  const now = new Date();
  const requestedPeriod = Number(req.query.periodDays);
  const periodDays = Number.isInteger(requestedPeriod) && requestedPeriod >= 1 && requestedPeriod <= 365
    ? requestedPeriod
    : 30;
  const since = new Date(now.getTime() - periodDays * 24 * 60 * 60 * 1000);
  const previousSince = new Date(now.getTime() - periodDays * 2 * 24 * 60 * 60 * 1000);
  const weekSince = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
  const monthSince = new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000);
  const todayKey = dateKey(now, "Europe/Moscow");
  const weekKey = dateKey(weekSince, "Europe/Moscow");
  const monthKey = dateKey(monthSince, "Europe/Moscow");
  const expiresSoon = daysFromNow(14);
  const regularUsers = { isSuperAdmin: { $ne: true } };

  const [
    totalUsers,
    blockedUsers,
    newUsers,
    previousNewUsers,
    dailyActiveUserIds,
    weeklyActiveUserIds,
    monthlyActiveUserIds,
    analyticsCoverage,
    totalOrganizations,
    organizationsByPlan,
    expiringPaidOrganizations,
    expiredPaidOrganizations,
    manualPlanOrganizations,
    pendingBillingRequests,
    approvedBillingRequests,
    manualRevenueAllTime,
    manualRevenueInPeriod,
    pendingPaymentOrders,
    paymentOrdersByStatus,
    paymentRevenueAllTime,
    paymentRevenueInPeriod,
    refundAmountAllTime,
    refundAmountInPeriod,
    refundsByStatus,
    fiscalizationByStatus,
    totalProjects,
    newProjects,
    previousNewProjects,
    totalTasks,
    activeTasks,
    closedTasks,
    reviewTasks,
    overdueTasks,
    createdTasks,
    previousCreatedTasks,
    completedTasks,
    previousCompletedTasks,
    emailQueueByStatus,
    emailPrivacyRejected,
    serviceHttpMetrics,
    recentUsers
  ] = await Promise.all([
    User.countDocuments(regularUsers),
    User.countDocuments({ ...regularUsers, status: "blocked" }),
    User.countDocuments({ ...regularUsers, createdAt: { $gte: since, $lt: now } }),
    User.countDocuments({ ...regularUsers, createdAt: { $gte: previousSince, $lt: since } }),
    ProductEvent.distinct("user", { event: "active_day", day: todayKey }),
    ProductEvent.distinct("user", { event: "active_day", day: { $gte: weekKey, $lte: todayKey } }),
    ProductEvent.distinct("user", { event: "active_day", day: { $gte: monthKey, $lte: todayKey } }),
    ProductEvent.findOne({ event: "active_day" }).sort({ at: 1 }).select("at").lean(),
    Organization.countDocuments(),
    Organization.aggregate([
      { $group: {
        _id: "$plan",
        count: { $sum: 1 },
        activeCount: { $sum: { $cond: [{ $or: [{ $eq: ["$plan", "free"] }, { $gt: ["$planExpiresAt", now] }] }, 1, 0] } }
      } },
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
      { $match: { "payment.status": "paid", $or: [{ "payment.provider": "manual" }, { "payment.provider": { $exists: false } }], "payment.paidAt": { $lte: now }, amount: { $gt: 0 } } },
      { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }
    ]),
    BillingRequest.aggregate([
      { $match: { "payment.status": "paid", $or: [{ "payment.provider": "manual" }, { "payment.provider": { $exists: false } }], "payment.paidAt": { $gte: since, $lt: now }, amount: { $gt: 0 } } },
      { $group: { _id: null, amount: { $sum: "$amount" }, count: { $sum: 1 } } }
    ]),
    PaymentOrder.countDocuments({ isOpen: true, status: "awaiting_payment" }),
    PaymentOrder.aggregate([
      { $match: { createdAt: { $gte: since, $lt: now } } },
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]),
    PaymentOrder.aggregate([
      { $match: { status: { $in: ["paid", "partially_refunded", "refunded"] }, paidAt: { $lte: now }, amountKopecks: { $gt: 0 } } },
      { $group: { _id: null, amountKopecks: { $sum: "$amountKopecks" }, count: { $sum: 1 } } }
    ]),
    PaymentOrder.aggregate([
      { $match: { status: { $in: ["paid", "partially_refunded", "refunded"] }, paidAt: { $gte: since, $lt: now }, amountKopecks: { $gt: 0 } } },
      { $group: { _id: null, amountKopecks: { $sum: "$amountKopecks" }, count: { $sum: 1 } } }
    ]),
    PaymentRefund.aggregate([
      { $match: { status: "succeeded", completedAt: { $lte: now } } },
      { $group: { _id: null, amountKopecks: { $sum: "$amountKopecks" } } }
    ]),
    PaymentRefund.aggregate([
      { $match: { status: "succeeded", completedAt: { $gte: since, $lt: now } } },
      { $group: { _id: null, amountKopecks: { $sum: "$amountKopecks" } } }
    ]),
    PaymentRefund.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    PaymentOrder.aggregate([
      { $match: { status: { $in: ["paid", "partially_refunded", "refunded"] } } },
      { $group: { _id: "$fiscalization.status", count: { $sum: 1 } } }
    ]),
    Project.countDocuments(),
    Project.countDocuments({ createdAt: { $gte: since, $lt: now } }),
    Project.countDocuments({ createdAt: { $gte: previousSince, $lt: since } }),
    Task.countDocuments(),
    Task.countDocuments({ status: { $nin: ["closed", "cancelled"] } }),
    Task.countDocuments({ status: "closed" }),
    Task.countDocuments({ status: { $in: ["review", "done"] } }),
    Task.countDocuments({ status: { $nin: ["closed", "cancelled"] }, ...overdueTaskFilter(now) }),
    Task.countDocuments({ createdAt: { $gte: since, $lt: now } }),
    Task.countDocuments({ createdAt: { $gte: previousSince, $lt: since } }),
    Task.countDocuments({ activities: { $elemMatch: { action: "status_changed", to: "closed", createdAt: { $gte: since, $lt: now } } } }),
    Task.countDocuments({ activities: { $elemMatch: { action: "status_changed", to: "closed", createdAt: { $gte: previousSince, $lt: since } } } }),
    EmailJob.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    EmailJob.countDocuments({ lastErrorCode: "EMAIL_PRIVACY_REJECTED", updatedAt: { $gte: since, $lt: now } }),
    ServiceMetric.aggregate([
      { $match: { bucket: { $gte: new Date(now.getTime() - 24 * 60 * 60 * 1000), $lte: now } } },
      { $group: {
        _id: null,
        requests: { $sum: "$requests" },
        clientErrors: { $sum: "$clientErrors" },
        serverErrors: { $sum: "$serverErrors" },
        totalDurationMs: { $sum: "$totalDurationMs" },
        maxDurationMs: { $max: "$maxDurationMs" }
      } }
    ]),
    User.find(regularUsers)
      .sort({ createdAt: -1 })
      .limit(8)
      .select("name lastName email status isSuperAdmin lastLoginAt createdAt")
      .lean()
  ]);

  const trackedActiveUsers = monthlyActiveUserIds.length
    ? await User.find({ ...regularUsers, _id: { $in: monthlyActiveUserIds }, status: { $ne: "blocked" } }).select("_id").lean()
    : [];
  const trackedActiveIds = new Set(trackedActiveUsers.map((user) => String(user._id)));
  const monthlyTrackedIds = monthlyActiveUserIds.filter((id) => trackedActiveIds.has(String(id)));
  const weeklyTrackedIds = weeklyActiveUserIds.filter((id) => trackedActiveIds.has(String(id)));
  const dailyTrackedIds = dailyActiveUserIds.filter((id) => trackedActiveIds.has(String(id)));
  const activeUsers = monthlyTrackedIds.length;
  const inactiveUsers = Math.max(0, totalUsers - activeUsers - blockedUsers);
  const [activeOrganizations, collaborativeOrganizations] = await Promise.all([
    monthlyTrackedIds.length
      ? Organization.countDocuments({ "members.user": { $in: monthlyTrackedIds } })
      : 0,
    Organization.countDocuments({ "members.1": { $exists: true } })
  ]);
  const planBreakdown = organizationsByPlan.map((item) => ({
    plan: item._id || "free",
    organizations: item.count,
    activeOrganizations: item.activeCount,
    monthlyRevenue: item.activeCount * (PLANS[item._id]?.monthlyPrice || 0)
  }));
  const estimatedMonthlyRevenue = planBreakdown.reduce((sum, item) => sum + item.monthlyRevenue, 0);
  const paidOrganizations = planBreakdown
    .filter((item) => item.plan !== "free")
    .reduce((sum, item) => sum + item.activeOrganizations, 0);
  const paymentStatuses = countByKey(paymentOrdersByStatus);
  const refundStatuses = countByKey(refundsByStatus);
  const fiscalStatuses = countByKey(fiscalizationByStatus);
  const emailStatuses = countByKey(emailQueueByStatus);
  const completedPaymentAttempts = ["paid", "partially_refunded", "failed", "expired", "cancelled", "refunded"]
    .reduce((sum, status) => sum + (paymentStatuses[status] || 0), 0);
  const paidPaymentOrdersInPeriod = (paymentStatuses.paid || 0)
    + (paymentStatuses.partially_refunded || 0)
    + (paymentStatuses.refunded || 0);
  const paymentRevenuePeriod = (
    (paymentRevenueInPeriod[0]?.amountKopecks || 0) - (refundAmountInPeriod[0]?.amountKopecks || 0)
  ) / 100;
  const manualRevenuePeriod = manualRevenueInPeriod[0]?.amount || 0;
  const receivedInPeriod = paymentRevenuePeriod + manualRevenuePeriod;
  const receivedAllTime = (
    (paymentRevenueAllTime[0]?.amountKopecks || 0) - (refundAmountAllTime[0]?.amountKopecks || 0)
  ) / 100 + (manualRevenueAllTime[0]?.amount || 0);
  const paymentCountInPeriod = (paymentRevenueInPeriod[0]?.count || 0) + (manualRevenueInPeriod[0]?.count || 0);
  const billingIntegration = billingIntegrationPayload();
  const httpMetrics = serviceHttpMetrics[0] || {};
  const averageResponseMs = httpMetrics.requests ? Math.round(httpMetrics.totalDurationMs / httpMetrics.requests) : 0;
  const serverErrorRate = httpMetrics.requests
    ? Math.round(httpMetrics.serverErrors / httpMetrics.requests * 1000) / 10
    : 0;
  const operationProblems = (fiscalStatuses.failed || 0)
    + (refundStatuses.failed || 0)
    + (refundStatuses.unknown || 0)
    + (emailStatuses.failed || 0)
    + emailPrivacyRejected
    + (httpMetrics.serverErrors || 0);

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
    engagement: {
      dau: dailyTrackedIds.length,
      wau: weeklyTrackedIds.length,
      mau: monthlyTrackedIds.length,
      dauMau: percent(dailyTrackedIds.length, monthlyTrackedIds.length),
      wauMau: percent(weeklyTrackedIds.length, monthlyTrackedIds.length),
      activeOrganizations,
      collaborativeOrganizations,
      collaborationRate: percent(collaborativeOrganizations, totalOrganizations),
      coverageStart: analyticsCoverage?.at || null
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
      received: receivedAllTime,
      receivedAllTime,
      receivedInPeriod,
      averageCheck: paymentCountInPeriod ? Math.round(receivedInPeriod / paymentCountInPeriod) : 0,
      estimatedMonthly: estimatedMonthlyRevenue,
      estimatedAnnual: estimatedMonthlyRevenue * 12,
      paidConversionRate: percent(paidOrganizations, totalOrganizations),
      paymentConversionRate: percent(paidPaymentOrdersInPeriod, completedPaymentAttempts)
    },
    billing: {
      pendingRequests: pendingBillingRequests,
      approvedInPeriod: approvedBillingRequests,
      pendingPaymentOrders,
      paidPaymentOrdersInPeriod,
      failedPaymentOrdersInPeriod: (paymentStatuses.failed || 0) + (paymentStatuses.expired || 0),
      fiscalizationPending: fiscalStatuses.pending || 0,
      fiscalizationFailed: fiscalStatuses.failed || 0,
      refundPending: refundStatuses.pending || 0,
      refundUnknown: refundStatuses.unknown || 0,
      refundFailed: refundStatuses.failed || 0,
      integration: billingIntegration
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
      newUsers: { current: newUsers, previous: previousNewUsers, change: changePercent(newUsers, previousNewUsers) },
      newProjects: { current: newProjects, previous: previousNewProjects, change: changePercent(newProjects, previousNewProjects) },
      createdTasks: { current: createdTasks, previous: previousCreatedTasks, change: changePercent(createdTasks, previousCreatedTasks) },
      completedTasks: { current: completedTasks, previous: previousCompletedTasks, change: changePercent(completedTasks, previousCompletedTasks) }
    },
    operations: {
      status: !billingIntegration.ready || operationProblems ? "attention" : "healthy",
      billingReady: billingIntegration.ready,
      emailQueued: emailStatuses.queued || 0,
      emailFailed: emailStatuses.failed || 0,
      emailPrivacyRejected,
      fiscalizationPending: fiscalStatuses.pending || 0,
      fiscalizationFailed: fiscalStatuses.failed || 0,
      paymentOrdersAwaiting: pendingPaymentOrders,
      requests24h: httpMetrics.requests || 0,
      clientErrors24h: httpMetrics.clientErrors || 0,
      serverErrors24h: httpMetrics.serverErrors || 0,
      serverErrorRate,
      averageResponseMs,
      maxResponseMs: Math.round(httpMetrics.maxDurationMs || 0)
    },
    recentUsers
  });
}));

adminRouter.get("/billing-requests", asyncRoute(async (req, res) => {
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
}));

adminRouter.get("/payment-orders", asyncRoute(async (req, res) => {
  const status = String(req.query.status || "all").trim();
  const filter = {};

  if (status !== "all") {
    if (!["awaiting_payment", "paid", "partially_refunded", "expired", "cancelled", "failed", "refunded"].includes(status)) {
      return res.status(400).json({ message: "Некорректный статус платежа" });
    }
    filter.status = status;
  }

  const paymentOrders = await PaymentOrder.find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .populate("organization", "name plan planExpiresAt")
    .populate("requestedBy", "name lastName email")
    .lean();

  const refunds = await PaymentRefund.find({
    paymentOrder: { $in: paymentOrders.map((order) => order._id) }
  })
    .sort({ createdAt: -1 })
    .populate("requestedBy", "name lastName email")
    .lean();
  const refundsByOrder = new Map();
  for (const refund of refunds) {
    const orderId = refund.paymentOrder.toString();
    const current = refundsByOrder.get(orderId) || [];
    current.push(refund);
    refundsByOrder.set(orderId, current);
  }

  res.json({
    paymentOrders: paymentOrders.map((order) => ({
      ...order,
      refunds: refundsByOrder.get(order._id.toString()) || []
    })),
    billing: billingIntegrationPayload()
  });
}));

adminRouter.get("/payment-orders/:orderId", asyncRoute(async (req, res) => {
  const order = await PaymentOrder.findById(req.params.orderId)
    .populate("organization", "name plan planExpiresAt")
    .populate("requestedBy", "name lastName email")
    .lean();
  if (!order) return res.status(404).json({ message: "Платёж не найден" });
  const [refunds, events] = await Promise.all([
    PaymentRefund.find({ paymentOrder: order._id })
      .sort({ createdAt: -1 })
      .populate("requestedBy", "name lastName email")
      .lean(),
    BillingEvent.find({
      $or: [
        { aggregateId: order._id },
        { correlationId: String(order._id) }
      ]
    }).sort({ occurredAt: -1 }).limit(100).lean()
  ]);
  res.json({ paymentOrder: { ...order, refunds }, events, fiscalizationMaxAttempts: fiscalizationMaxAttempts() });
}));

adminRouter.post("/payment-orders/:orderId/fiscalization/retry", asyncRoute(async (req, res) => {
  const order = await PaymentOrder.findById(req.params.orderId);
  if (!order) return res.status(404).json({ message: "Платёж не найден" });
  const refundId = String(req.body.refundId || "").trim();
  const entity = refundId
    ? await PaymentRefund.findOne({ _id: refundId, paymentOrder: order._id })
    : order;
  if (!entity) return res.status(404).json({ message: "Возврат не найден" });
  if (refundId ? entity.status !== "succeeded" : !["paid", "partially_refunded", "refunded"].includes(order.status)) {
    return res.status(409).json({ message: "Этот платёж пока нельзя фискализировать" });
  }
  if (entity.fiscalization?.status === "succeeded") {
    return res.status(409).json({ message: "Чек уже сформирован" });
  }
  const result = refundId
    ? await fiscalizePaymentRefund(entity._id, { trigger: "manual" })
    : await fiscalizePaymentOrder(order._id, { trigger: "manual" });
  res.json({
    fiscalization: result.fiscalization,
    message: result.fiscalization.status === "succeeded"
      ? "Чек сформирован"
      : "Повторная фискализация запущена"
  });
}));

adminRouter.post("/payment-orders/:orderId/refunds", asyncRoute(async (req, res) => {
  const refund = await requestPaymentRefund({
    orderId: req.params.orderId,
    amountKopecks: req.body.amountKopecks,
    actorId: req.user._id,
    reason: req.body.reason,
    idempotencyKey: req.body.idempotencyKey
  });
  await refund.populate("requestedBy", "name lastName email");

  const statusCode = ["pending", "unknown"].includes(refund.status) ? 202 : 201;
  res.status(statusCode).json({
    refund,
    message: refund.status === "succeeded"
      ? "Возврат выполнен, чек возврата формируется"
      : refund.status === "pending"
        ? "Возврат принят банком и ожидает завершения"
        : refund.status === "unknown"
          ? "Статус запроса неизвестен. Повторный возврат заблокирован до ручной сверки с банком."
          : "Банк отклонил возврат"
  });
}));

adminRouter.patch("/billing-requests/:requestId", asyncRoute(async (req, res) => {
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

  let organization = await Organization.findById(request.organization);

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
      planExpiresAt = addCalendarMonths(new Date(), request.periodMonths || 1);
    }

    const changeReason =
      typeof adminNote === "string" && adminNote.trim()
        ? adminNote.trim()
        : `Заявка на тариф ${PLANS[request.plan]?.name || request.plan} на ${request.periodMonths} мес.`;
    await applyManualSubscriptionChange({
      organization,
      plan: request.plan,
      expiresAt: planExpiresAt,
      actorId: req.user._id,
      note: changeReason
    });
    organization = await Organization.findById(request.organization);
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
}));

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

  await applyManualSubscriptionChange({
    organization,
    plan,
    expiresAt: planExpiresAt,
    actorId: req.user._id,
    note: typeof note === "string" ? note.trim() : ""
  });
  organization = await Organization.findById(organization._id);

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
