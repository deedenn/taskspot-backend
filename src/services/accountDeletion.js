import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { BillingRequest } from "../models/BillingRequest.js";
import { DeviceSession } from "../models/DeviceSession.js";
import { EmailJob } from "../models/EmailJob.js";
import { MobileMutationReceipt } from "../models/MobileMutationReceipt.js";
import { Notification } from "../models/Notification.js";
import { Organization } from "../models/Organization.js";
import { ProductEvent } from "../models/ProductEvent.js";
import { Project } from "../models/Project.js";
import { ProjectTemplate } from "../models/ProjectTemplate.js";
import { PushDevice } from "../models/PushDevice.js";
import { PushJob } from "../models/PushJob.js";
import { Subscription } from "../models/Subscription.js";
import { SubscriptionPeriod } from "../models/SubscriptionPeriod.js";
import { Task } from "../models/Task.js";
import { deleteObjectForKey, isStorageConfigured } from "./storage.js";

function id(value) {
  return String(value?._id || value || "");
}

function nextOwner(members) {
  return [...members].sort((left, right) => {
    const order = { owner: 0, admin: 1, member: 2 };
    return (order[left.role] ?? 3) - (order[right.role] ?? 3);
  })[0];
}

async function deleteUploadedFiles(userId, privateProjectIds) {
  if (!isStorageConfigured()) return;
  const privateProjects = new Set(privateProjectIds.map(id));
  const [tasks, projects] = await Promise.all([
    Task.find({ $or: [{ "attachments.addedBy": userId }, { project: { $in: privateProjectIds } }] }).select("project attachments").lean(),
    Project.find({ $or: [{ "avatar.uploadedBy": userId }, { _id: { $in: privateProjectIds } }] }).select("avatar").lean()
  ]);
  const keys = new Set();
  for (const task of tasks) {
    for (const attachment of task.attachments || []) {
      if ((privateProjects.has(id(task.project)) || id(attachment.addedBy) === id(userId)) && attachment.key) keys.add(attachment.key);
    }
  }
  for (const project of projects) if (project.avatar?.key) keys.add(project.avatar.key);
  await Promise.all([...keys].map((key) => deleteObjectForKey(key)));
}

export async function deleteAccount(user) {
  const userId = user._id;
  const userIdText = id(userId);
  const originalEmail = user.email;
  const organizations = await Organization.find({
    $or: [{ "members.user": userId }, { personalOwner: userId }]
  });
  const emptyOrganizationIds = [];
  const ownershipTransfers = [];

  for (const organization of organizations) {
    const current = organization.members.find((member) => id(member.user) === userIdText);
    const others = organization.members.filter((member) => id(member.user) !== userIdText);
    const otherOwner = others.some((member) => member.role === "owner");
    if (current?.role === "owner" && !otherOwner && others.length) {
      const successor = nextOwner(others);
      successor.role = "owner";
      ownershipTransfers.push({ organization: organization._id, successor: successor.user });
    }
    organization.members = others;
    if (id(organization.personalOwner) === userIdText) organization.personalOwner = undefined;
    if (!others.length) {
      emptyOrganizationIds.push(organization._id);
      organization.name = "Удалённая организация";
      organization.plan = "free";
      organization.planExpiresAt = undefined;
      organization.planAssignedAt = undefined;
      organization.planAssignedBy = undefined;
      organization.planSource = "system";
      organization.planChangeReason = "Аккаунт владельца удалён";
      organization.billingNote = "";
    }
  }

  const privateProjectIds = emptyOrganizationIds.length
    ? await Project.distinct("_id", { organization: { $in: emptyOrganizationIds } })
    : [];
  await deleteUploadedFiles(userId, privateProjectIds);
  await Promise.all(organizations.map((organization) => organization.save()));

  for (const transfer of ownershipTransfers) {
    await Project.updateMany(
      { organization: transfer.organization, "members.user": transfer.successor },
      { $set: { "members.$[member].role": "admin" } },
      { arrayFilters: [{ "member.user": transfer.successor }] }
    );
    await Project.updateMany(
      { organization: transfer.organization, "members.user": { $ne: transfer.successor } },
      { $push: { members: { user: transfer.successor, role: "admin" } } }
    );
  }

  await Promise.all([
    privateProjectIds.length ? Task.deleteMany({ project: { $in: privateProjectIds } }) : Promise.resolve(),
    emptyOrganizationIds.length ? Project.deleteMany({ organization: { $in: emptyOrganizationIds } }) : Promise.resolve(),
    emptyOrganizationIds.length ? ProjectTemplate.deleteMany({ organization: { $in: emptyOrganizationIds } }) : Promise.resolve(),
    emptyOrganizationIds.length ? Subscription.deleteMany({ organization: { $in: emptyOrganizationIds } }) : Promise.resolve(),
    emptyOrganizationIds.length ? SubscriptionPeriod.deleteMany({ organization: { $in: emptyOrganizationIds } }) : Promise.resolve()
  ]);

  await Promise.all([
    Project.updateMany(
      { organization: { $nin: emptyOrganizationIds } },
      { $pull: { members: { user: userId }, invitations: { invitedBy: userId } } }
    ),
    Project.updateMany(
      { "invitations.email": originalEmail },
      { $pull: { invitations: { email: originalEmail } } }
    ),
    Project.updateMany(
      { "avatar.uploadedBy": userId },
      { $unset: { avatar: 1 } }
    ),
    Project.updateMany(
      { "auditLog.actor": userId },
      { $set: { "auditLog.$[event].actorName": "Удалённый пользователь" } },
      { arrayFilters: [{ "event.actor": userId }] }
    ),
    ProjectTemplate.deleteMany({ owner: userId }),
    Task.updateMany(
      { project: { $nin: privateProjectIds }, assignee: userId },
      { $unset: { assignee: 1, assigneeEmail: 1 } }
    ),
    Task.updateMany(
      { project: { $nin: privateProjectIds }, assigneeEmail: originalEmail },
      { $unset: { assigneeEmail: 1 } }
    ),
    Task.updateMany(
      { project: { $nin: privateProjectIds } },
      { $pull: { observers: userId, attachments: { addedBy: userId } } }
    ),
    Task.updateMany(
      { project: { $nin: privateProjectIds }, creator: userId, "recurrence.enabled": true },
      {
        $set: { "recurrence.enabled": false, "recurrence.frequency": "none", "recurrence.lastError": "Повтор отключён: аккаунт инициатора удалён" },
        $unset: { "recurrence.nextRunAt": 1, "recurrence.retryAt": 1 }
      }
    ),
    BillingRequest.updateMany(
      { requestedBy: userId },
      { $set: { contactName: "", contactEmail: "", contactPhone: "", comment: "" } }
    )
  ]);

  const notifications = await Notification.find({ user: userId }).select("_id").lean();
  const notificationIds = notifications.map((item) => item._id);
  await Promise.all([
    DeviceSession.deleteMany({ user: userId }),
    PushDevice.deleteMany({ user: userId }),
    PushJob.deleteMany({ $or: [{ user: userId }, { notification: { $in: notificationIds } }] }),
    Notification.deleteMany({ user: userId }),
    MobileMutationReceipt.deleteMany({ user: userId }),
    ProductEvent.deleteMany({ user: userId }),
    EmailJob.deleteMany({ "context.userId": userIdText })
  ]);

  const now = new Date();
  user.set({
    name: "Удалённый",
    lastName: "пользователь",
    email: `deleted-${userIdText}@deleted.taskspot.invalid`,
    passwordHash: await bcrypt.hash(crypto.randomBytes(48).toString("base64url"), 12),
    avatarUrl: "",
    phone: "",
    status: "inactive",
    isSuperAdmin: false,
    lastLoginAt: undefined,
    emailVerifiedAt: undefined,
    emailVerificationTokenHash: "",
    emailVerificationExpiresAt: undefined,
    emailVerificationSentAt: undefined,
    emailVerificationStatus: "skipped",
    emailVerificationError: "",
    termsAcceptedAt: undefined,
    termsVersion: "",
    personalOrganization: undefined,
    starterProject: undefined,
    workspaceProvisioningVersion: 0,
    passwordReset: undefined,
    adminChallenge: undefined,
    emailOutbox: undefined,
    deletedAt: now,
    sessionVersion: Number(user.sessionVersion || 0) + 1
  });
  await user.save();

  return { deletedAt: now, ownershipTransfers: ownershipTransfers.length };
}
