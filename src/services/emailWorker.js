import crypto from "node:crypto";
import { EmailJob } from "../models/EmailJob.js";
import { Project } from "../models/Project.js";
import { User } from "../models/User.js";
import { Task } from "../models/Task.js";
import { deliverMail } from "./email.js";
import { normalizeSingleEmailRecipient, retryDelay, retryableEmailError, safeEmailError, validateEmailJob } from "./emailQueue.js";
import { canViewTask, idOf, projectMember } from "./taskAccess.js";

const LEASE_MS = 5 * 60 * 1000;

function recipientMatches(value, expected) {
  return normalizeSingleEmailRecipient(value) === normalizeSingleEmailRecipient(expected);
}

function activeRecipientFilter(userId, email, context = {}) {
  const filter = {
    _id: userId,
    email,
    status: { $nin: ["blocked", "inactive"] },
    $or: [
      { emailVerificationStatus: "verified" },
      { emailVerifiedAt: { $ne: null } },
      { emailVerificationStatus: { $exists: false } }
    ]
  };
  if (context.kind === "reminder") filter["emailPreferences.reminders"] = { $ne: false };
  if (context.kind === "task" && context.event === "task_comment") filter["emailPreferences.comments"] = { $ne: false };
  if (context.kind === "task" && context.event !== "task_comment") filter["emailPreferences.taskUpdates"] = { $ne: false };
  return filter;
}

async function recipientIdentityMatches(userId, recipient) {
  return Boolean(await User.exists({ _id: userId, email: recipient }));
}

export async function evaluateEmailJob(job, now) {
  const context = job.context;
  let recipient;
  try {
    recipient = validateEmailJob(job.mail, context).to;
  } catch {
    return { send: false, privacyRejected: true };
  }
  if (["password_reset", "admin_login"].includes(context.kind)) {
    const field = context.kind === "password_reset" ? "passwordReset" : "adminChallenge";
    if (!await recipientIdentityMatches(context.userId, recipient)) return { send: false, privacyRejected: true };
    const valid = Boolean(await User.exists({ _id: context.userId, [field + ".tokenHash"]: context.tokenHash,
      [field + ".expiresAt"]: { $gt: now }, status: "active",
      ...(field === "adminChallenge" ? { isSuperAdmin: true } : { emailVerificationStatus: "verified" }) }));
    return { send: valid, privacyRejected: false };
  }
  if (context.kind === "verification") {
    if (!await recipientIdentityMatches(context.userId, recipient)) return { send: false, privacyRejected: true };
    const valid = Boolean(await User.exists({ _id: context.userId, emailVerificationTokenHash: context.tokenHash,
      emailVerifiedAt: null, emailVerificationExpiresAt: { $gt: now }, status: { $ne: "blocked" } }));
    return { send: valid, privacyRejected: false };
  }
  if (context.kind === "billing_alert") {
    if (!await recipientIdentityMatches(context.userId, recipient)) return { send: false, privacyRejected: true };
    return {
      send: Boolean(await User.exists({
        _id: context.userId,
        email: recipient,
        isSuperAdmin: true,
        status: "active"
      })),
      privacyRejected: false
    };
  }
  const project = await Project.findById(context.projectId);
  if (!project) return { send: false, privacyRejected: false };
  if (context.kind === "invitation") {
    const invitation = project.invitations.id(context.invitationId);
    if (!invitation) return { send: false, privacyRejected: false };
    if (!recipientMatches(recipient, invitation.email)) return { send: false, privacyRejected: true };
    return { send: Boolean(invitation.status === "pending" && invitation.token === context.token && invitation.expiresAt > now),
      privacyRejected: false };
  }
  if (context.kind === "member_added") {
    if (!await recipientIdentityMatches(context.userId, recipient)) return { send: false, privacyRejected: true };
    return { send: Boolean(projectMember(project, context.userId) && await User.exists(activeRecipientFilter(context.userId, recipient))),
      privacyRejected: false };
  }
  if (!["task", "reminder"].includes(context.kind)) return { send: false, privacyRejected: true };
  if (!await recipientIdentityMatches(context.userId, recipient)) return { send: false, privacyRejected: true };
  if (!projectMember(project, context.userId) || !await User.exists(activeRecipientFilter(context.userId, recipient, context))) {
    return { send: false, privacyRejected: false };
  }
  const task = await Task.findById(context.taskId);
  if (!task) return { send: false, privacyRejected: false };
  if (idOf(task.project) !== idOf(project)) return { send: false, privacyRejected: true };
  if (!canViewTask(task, project, context.userId)) return { send: false, privacyRejected: false };
  if (context.kind === "reminder" && (project.isArchived || project.archivedAt ||
      ["review", "done", "closed", "cancelled"].includes(task.status) || task.dueDate?.toISOString() !== context.dueDate)) {
    return { send: false, privacyRejected: false };
  }
  return { send: true, privacyRejected: false };
}

export async function isRelevantEmailJob(job, now) {
  return (await evaluateEmailJob(job, now)).send;
}

export async function syncEmailStatus(job) {
  const context = job.context;
  const status = job.status === "accepted" ? "sent" : ["failed", "cancelled"].includes(job.status) ? "failed" : "pending";
  const lastError = job.status === "cancelled" ? "Ссылка больше не действует. Отправьте новое приглашение или подтверждение." : job.lastError;
  const pendingGuard = status === "pending" ? { $nin: ["sent", "failed"] } : { $ne: "sent" };
  if (context.kind === "verification") {
    await User.updateOne({ _id: context.userId, emailVerificationTokenHash: context.tokenHash, emailVerifiedAt: null,
      ...(status !== "sent" ? { emailVerificationStatus: pendingGuard } : {}) }, {
      $set: { emailVerificationStatus: status, emailVerificationError: lastError,
        ...(job.acceptedAt ? { emailVerificationSentAt: job.acceptedAt } : {}) }
    });
  }
  if (context.kind === "invitation") {
    await Project.updateOne({ _id: context.projectId, invitations: { $elemMatch: {
      _id: context.invitationId, token: context.token, status: "pending",
      ...(status !== "sent" ? { emailStatus: pendingGuard } : {})
    } } }, { $set: {
      "invitations.$.emailStatus": status, "invitations.$.emailError": lastError,
      ...(job.acceptedAt ? { "invitations.$.emailSentAt": job.acceptedAt } : {})
    } });
  }
  await EmailJob.updateOne({ _id: job._id, status: job.status, attempts: job.attempts }, { $set: { statusSynced: true } });
}

export async function processEmailJob({ now = new Date(), send = deliverMail, clock = () => new Date() } = {}) {
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
  let stage = "relevance";
  const maxAttempts = Math.max(1, Math.min(20, Number(process.env.EMAIL_MAX_ATTEMPTS) || 8));
  try {
    const relevance = await evaluateEmailJob(job, now);
    if (!relevance.send) {
      changes = { status: "cancelled", lastError: "", lastErrorCode: relevance.privacyRejected ? "EMAIL_PRIVACY_REJECTED" : "" };
    } else if (job.attempts > maxAttempts) {
      changes = { status: "failed", lastError: "Исчерпаны попытки отправки. Запросите новое письмо.", lastErrorCode: "ATTEMPTS_EXHAUSTED" };
    } else {
      stage = "smtp";
      await send({ ...job.mail, messageId: job.messageId });
      changes = { status: "accepted", acceptedAt: clock(), lastError: "", lastErrorCode: "" };
    }
  } catch (error) {
    if (stage === "relevance") {
      changes = { status: "queued", attempts: job.attempts - 1, nextAttemptAt: new Date(clock().getTime() + retryDelay(1)),
        lastError: "Отправка отложена: временно не удалось проверить актуальность письма.", lastErrorCode: "RELEVANCE_CHECK_FAILED" };
    } else {
      const retry = retryableEmailError(error) && job.attempts < maxAttempts;
      const code = String(error.code || error.responseCode || "SEND_FAILED");
      changes = { status: retry ? "queued" : "failed", nextAttemptAt: new Date(clock().getTime() + retryDelay(job.attempts)),
        lastError: safeEmailError(error), lastErrorCode: /^[A-Z0-9_]{1,40}$/.test(code) ? code : "SEND_FAILED" };
    }
  } finally {
    clearInterval(heartbeat);
  }
  const updated = await EmailJob.findOneAndUpdate({ _id: job._id, lockToken, status: "processing" }, {
    $set: { ...changes, statusSynced: false }, $unset: { lockToken: "", leaseUntil: "" }
  }, { new: true });
  if (updated) {
    console.info("[taskspot:email-queue]", JSON.stringify({ jobId: String(job._id), messageId: job.messageId,
      status: updated.status, attempt: job.attempts, code: updated.lastErrorCode, nextAttemptAt: updated.nextAttemptAt }));
    try { await syncEmailStatus(updated); }
    catch { console.error("[taskspot:email-queue]", { event: "status_sync_failed", jobId: String(job._id) }); }
  }
  return true;
}

export async function reconcileEmailStatuses() {
  const jobs = await EmailJob.find({ statusSynced: false, status: { $ne: "processing" } }).limit(100);
  for (const job of jobs) {
    try { await syncEmailStatus(job); }
    catch { console.error("[taskspot:email-queue]", { event: "status_sync_failed", jobId: String(job._id) }); }
  }
}
