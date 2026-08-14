import express from "express";
import { requireRegularUser } from "../middleware/auth.js";
import { BillingRequest } from "../models/BillingRequest.js";
import { Organization } from "../models/Organization.js";
import { billingIntegrationPayload } from "../services/billingProviders.js";
import { ensureDefaultOrganization, organizationPayload, PLANS, planFor } from "../services/plans.js";

export const organizationsRouter = express.Router();

organizationsRouter.use(requireRegularUser);

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function memberEntry(organization, userId) {
  return organization.members.find((member) => member.user.toString() === userId.toString());
}

function isOrganizationAdmin(organization, userId) {
  const member = memberEntry(organization, userId);
  return Boolean(member && ["owner", "admin"].includes(member.role));
}

function sanitizeBillingRequest(request) {
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

async function organizationPayloadWithBilling(organization) {
  const [payload, billingRequests] = await Promise.all([
    organizationPayload(organization),
    BillingRequest.find({ organization: organization._id })
      .sort({ createdAt: -1 })
      .limit(5)
      .populate("requestedBy", "name lastName email")
      .populate("processedBy", "name lastName email")
      .lean()
  ]);

  return {
    ...payload,
    billingRequests: billingRequests.map(sanitizeBillingRequest),
    activeBillingRequest: sanitizeBillingRequest(
      billingRequests.find((request) => request.status === "pending") || billingRequests[0]
    )
  };
}

organizationsRouter.get("/", asyncRoute(async (req, res) => {
  await ensureDefaultOrganization(req.user);
  const organizations = await Organization.find({ "members.user": req.user._id })
    .populate("members.user", "name lastName email")
    .sort({ updatedAt: -1 });
  const payloads = await Promise.all(organizations.map(organizationPayloadWithBilling));

  res.json({
    organizations: payloads,
    plans: Object.values(PLANS),
    billing: billingIntegrationPayload()
  });
}));

organizationsRouter.post("/", asyncRoute(async (req, res) => {
  const { name } = req.body;
  const existingOrganizations = await Organization.find({ "members.user": req.user._id }).select("plan");
  const organizationLimit = existingOrganizations.reduce(
    (limit, organization) => Math.max(limit, planFor(organization).limits.organizations),
    PLANS.free.limits.organizations
  );

  if (existingOrganizations.length >= organizationLimit) {
    return res.status(402).json({ message: "Лимит организаций на текущем тарифе исчерпан" });
  }

  if (!name?.trim()) {
    return res.status(400).json({ message: "Organization name is required" });
  }

  const organization = await Organization.create({
    name: name.trim(),
    plan: "free",
    members: [{ user: req.user._id, role: "owner" }]
  });
  await organization.populate("members.user", "name lastName email");

  res.status(201).json(await organizationPayload(organization));
}));

organizationsRouter.patch("/:organizationId", asyncRoute(async (req, res) => {
  const organization = await Organization.findById(req.params.organizationId);

  if (!organization || !memberEntry(organization, req.user._id)) {
    return res.status(404).json({ message: "Organization not found" });
  }

  const member = memberEntry(organization, req.user._id);
  if (!["owner", "admin"].includes(member.role)) {
    return res.status(403).json({ message: "Organization admin role is required" });
  }

  const { name, billingNote } = req.body;

  if (name?.trim()) {
    organization.name = name.trim();
  }

  if (typeof billingNote === "string") {
    organization.billingNote = billingNote.trim();
  }

  await organization.save();
  await organization.populate("members.user", "name lastName email");

  res.json(await organizationPayload(organization));
}));

organizationsRouter.post("/:organizationId/billing-requests", asyncRoute(async (req, res) => {
  const organization = await Organization.findById(req.params.organizationId);

  if (!organization || !memberEntry(organization, req.user._id)) {
    return res.status(404).json({ message: "Компания не найдена" });
  }

  if (!isOrganizationAdmin(organization, req.user._id)) {
    return res.status(403).json({ message: "Заявку на тариф может создать владелец или администратор компании" });
  }

  const { plan, periodMonths = 1, contactName, contactEmail, contactPhone, comment } = req.body;
  const nextPlan = PLANS[plan];

  if (!nextPlan || plan === "free") {
    return res.status(400).json({ message: "Выберите платный тариф" });
  }

  const normalizedPeriod = Number(periodMonths);
  if (![1, 3, 6, 12].includes(normalizedPeriod)) {
    return res.status(400).json({ message: "Выберите срок тарифа: 1, 3, 6 или 12 месяцев" });
  }

  const pendingRequest = await BillingRequest.findOne({
    organization: organization._id,
    status: "pending"
  });

  if (pendingRequest) {
    return res.status(409).json({
      message: "По этой компании уже есть заявка на тариф",
      billingRequest: sanitizeBillingRequest(pendingRequest)
    });
  }

  const request = await BillingRequest.create({
    organization: organization._id,
    requestedBy: req.user._id,
    plan,
    periodMonths: normalizedPeriod,
    amount: (nextPlan.monthlyPrice || 0) * normalizedPeriod,
    contactName: typeof contactName === "string" ? contactName.trim() : req.user.name,
    contactEmail: typeof contactEmail === "string" ? contactEmail.trim().toLowerCase() : req.user.email,
    contactPhone: typeof contactPhone === "string" ? contactPhone.trim() : req.user.phone || "",
    comment: typeof comment === "string" ? comment.trim() : "",
    payment: {
      provider: "manual",
      status: "invoice_requested"
    }
  });

  await request.populate("requestedBy", "name lastName email");

  res.status(201).json({
    billingRequest: sanitizeBillingRequest(request),
    billing: billingIntegrationPayload()
  });
}));
