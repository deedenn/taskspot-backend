import express from "express";
import { requireRegularUser } from "../middleware/auth.js";
import { Organization } from "../models/Organization.js";
import { ensureDefaultOrganization, organizationPayload, PLANS, planFor } from "../services/plans.js";

export const organizationsRouter = express.Router();

organizationsRouter.use(requireRegularUser);

function memberEntry(organization, userId) {
  return organization.members.find((member) => member.user.toString() === userId.toString());
}

organizationsRouter.get("/", async (req, res) => {
  await ensureDefaultOrganization(req.user);
  const organizations = await Organization.find({ "members.user": req.user._id })
    .populate("members.user", "name email")
    .sort({ updatedAt: -1 });
  const payloads = await Promise.all(organizations.map(organizationPayload));

  res.json({ organizations: payloads, plans: Object.values(PLANS) });
});

organizationsRouter.post("/", async (req, res) => {
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
  await organization.populate("members.user", "name email");

  res.status(201).json(await organizationPayload(organization));
});

organizationsRouter.patch("/:organizationId", async (req, res) => {
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
  await organization.populate("members.user", "name email");

  res.json(await organizationPayload(organization));
});
