import crypto from "node:crypto";
import { EmailJob } from "../models/EmailJob.js";
import { Project } from "../models/Project.js";
import { User } from "../models/User.js";
import { Task } from "../models/Task.js";
import { deliverMail } from "./email.js";
import { retryDelay, retryableEmailError, safeEmailError } from "./emailQueue.js";
import { canViewTask, projectMember } from "./taskAccess.js";

const LEASE_MS = 5 * 60 * 1000;

async function isRelevant(job, now) {
  const context = job.context;
  if (context.kind === "verification") {
    return Boolean(await User.exists({ _id: context.userId, emailVerificationTokenHash: context.tokenHash,
      emailVerifiedAt: null, emailVerificationExpiresAt: { $gt: now }, status: { $ne: "blocked" } }));
  }
  if (context.projectId) {
    const project = await Project.findById(context.projectId);
    if (!project) return false;
    if (context.kind === "invitation") {
      const invitation = project.invitations.id(context.invitationId);
      return Boolean(invitation?.status === "pending" && invitation.token === context.token && invitation.expiresAt > now);
    }
    if (context.userId && !projectMember(project, context.userId)) return false;
    if (context.taskId) {
      const task = await Task.findById(context.taskId);
      if (!task || !canViewTask(task, project, context.userId)) return false;
      if (context.kind === "reminder" && (project.isArchived || project.archivedAt ||
          ["review", "done", "closed"].includes(task.status) || task.dueDate?.toISOString() !== context.dueDate)) return false;
    }
  }
  if (context.userId && !await User.exists({ _id: context.userId, status: { $ne: "blocked" } })) return false;
  return true;
}

export async function syncEmailStatus(job) {
  const context = job.context;
  const status = job.status === "accepted" ? "sent" : job.status === "failed" ? "failed" : "pending";
  if (context.kind === "verification" && job.status !== "cancelled") {
    await User.updateOne({ _id: context.userId, emailVerificationTokenHash: context.tokenHash, emailVerifiedAt: null }, {
      $set: { emailVerificationStatus: status, emailVerificationError: job.lastError,
        ...(job.acceptedAt ? { emailVerificationSentAt: job.acceptedAt } : {}) }
    });
  }
  if (context.kind === "invitation" && job.status !== "cancelled") {
    await Project.updateOne({ _id: context.projectId, invitations: { $elemMatch: {
      _id: context.invitationId, token: context.token, status: "pending"
    } } }, { $set: {
      "invitations.$.emailStatus": status, "invitations.$.emailError": job.lastError,
      ...(job.acceptedAt ? { "invitations.$.emailSentAt": job.acceptedAt } : {})
    } });
  }
  await EmailJob.updateOne({ _id: job._id, status: job.status, attempts: job.attempts }, { $set: { statusSynced: true } });
}

export async function processEmailJob({ now = new Date(), send = deliverMail } = {}) {
  const lockToken = crypto.randomUUID();
  const job = await EmailJob.findOneAndUpdate({ $or: [
    { status: "queued", nextAttemptAt: { $lte: now } },
    { status: "processing", leaseUntil: { $lte: now } }
  ] }, { $set: { status: "processing", lockToken, leaseUntil: new Date(now.getTime() + LEASE_MS), lastAttemptAt: now, statusSynced: false },
    $inc: { attempts: 1 } }, { new: true, sort: { nextAttemptAt: 1, _id: 1 } }).select("+mail");
  if (!job) return false;
  const heartbeat = setInterval(() => {
    void EmailJob.updateOne({ _id: job._id, lockToken, status: "processing" }, {
      $set: { leaseUntil: new Date(Date.now() + LEASE_MS) }
    }).catch(() => {});
  }, 30000);
  heartbeat.unref();
  let changes;
  try {
    if (!await isRelevant(job, now)) {
      changes = { status: "cancelled", lastError: "" };
    } else {
      await send({ ...job.mail, messageId: job.messageId });
      changes = { status: "accepted", acceptedAt: new Date(), lastError: "", lastErrorCode: "" };
    }
  } catch (error) {
    const maxAttempts = Math.max(1, Math.min(20, Number(process.env.EMAIL_MAX_ATTEMPTS) || 8));
    const retry = retryableEmailError(error) && job.attempts < maxAttempts;
    changes = { status: retry ? "queued" : "failed", nextAttemptAt: new Date(now.getTime() + retryDelay(job.attempts)),
      lastError: safeEmailError(error), lastErrorCode: String(error.code || error.responseCode || "SEND_FAILED").slice(0, 40) };
  } finally {
    clearInterval(heartbeat);
  }
  const updated = await EmailJob.findOneAndUpdate({ _id: job._id, lockToken, status: "processing" }, {
    $set: { ...changes, statusSynced: false }, $unset: { lockToken: "", leaseUntil: "" }
  }, { new: true });
  if (updated) {
    console.info("[taskspot:email-queue]", JSON.stringify({ jobId: String(job._id), messageId: job.messageId,
      status: updated.status, attempt: job.attempts, code: updated.lastErrorCode, nextAttemptAt: updated.nextAttemptAt }));
    await syncEmailStatus(updated);
  }
  return true;
}

export async function reconcileEmailStatuses() {
  const jobs = await EmailJob.find({ statusSynced: false, status: { $ne: "processing" } }).limit(100);
  for (const job of jobs) await syncEmailStatus(job);
}
