import crypto from "node:crypto";
import { EmailJob } from "../models/EmailJob.js";

export const EMAIL_JOB_KINDS = Object.freeze([
  "verification",
  "password_reset",
  "admin_login",
  "invitation",
  "member_added",
  "task",
  "reminder",
  "billing_alert"
]);

const EMAIL_PATTERN = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;

export function normalizeSingleEmailRecipient(value) {
  if (typeof value !== "string") return "";
  const recipient = value.trim().toLowerCase();
  return recipient.length <= 254 && EMAIL_PATTERN.test(recipient) ? recipient : "";
}

function requiredContextFields(kind) {
  if (["verification", "password_reset", "admin_login"].includes(kind)) return ["userId", "tokenHash"];
  if (kind === "invitation") return ["projectId", "invitationId", "token"];
  if (kind === "member_added") return ["projectId", "userId"];
  if (kind === "task") return ["projectId", "taskId", "userId"];
  if (kind === "reminder") return ["projectId", "taskId", "userId", "dueDate"];
  if (kind === "billing_alert") return ["userId", "orderId"];
  return [];
}

export function validateEmailJob(mail, context = {}) {
  const recipient = normalizeSingleEmailRecipient(mail?.to);
  if (!recipient || mail?.cc !== undefined || mail?.bcc !== undefined) {
    throw Object.assign(new Error("Email job must have exactly one recipient"), { code: "EMAIL_RECIPIENT_INVALID" });
  }
  if (typeof mail.subject !== "string" || !mail.subject.trim() ||
      ![mail.text, mail.html].some((value) => typeof value === "string" && value.length)) {
    throw Object.assign(new Error("Email job content is invalid"), { code: "EMAIL_CONTENT_INVALID" });
  }
  if (!EMAIL_JOB_KINDS.includes(context.kind) ||
      requiredContextFields(context.kind).some((field) => typeof context[field] !== "string" || !context[field])) {
    throw Object.assign(new Error("Email job context is invalid"), { code: "EMAIL_CONTEXT_INVALID" });
  }
  return {
    to: recipient,
    subject: mail.subject.trim(),
    ...(typeof mail.text === "string" ? { text: mail.text } : {}),
    ...(typeof mail.html === "string" ? { html: mail.html } : {})
  };
}

export async function enqueueEmail(mail, context = {}) {
  const dedupeKey = context.dedupeKey || crypto.randomUUID();
  const normalizedContext = { ...context, dedupeKey };
  const normalizedMail = validateEmailJob(mail, normalizedContext);
  let job;
  try {
    job = await EmailJob.findOneAndUpdate({ dedupeKey }, { $setOnInsert: {
      dedupeKey, mail: normalizedMail, context: normalizedContext,
      messageId: `<${crypto.createHash("sha256").update(dedupeKey).digest("hex")}@taskspot.ru>`
    } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  } catch (error) {
    if (error.code !== 11000) throw error;
    job = await EmailJob.findOne({ dedupeKey });
  }
  if (!job) throw new Error("Email queue entry missing after duplicate insert");
  return { queued: ["queued", "processing"].includes(job.status), failed: ["failed", "cancelled"].includes(job.status),
    error: job.lastError || "", jobId: job._id.toString(), status: job.status };
}

export function retryDelay(attempt) {
  return Math.min(6 * 60 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attempt - 1));
}

export function retryableEmailError(error) {
  return error?.code === "SMTP_NOT_CONFIGURED" ||
    ["ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND"].includes(error?.code) ||
    (Number(error?.responseCode) >= 400 && Number(error?.responseCode) < 500);
}

export function safeEmailError(error) {
  if (error?.code === "SMTP_NOT_CONFIGURED") return "Почтовый сервер не настроен";
  if (error?.code === "EAUTH" || error?.responseCode === 535) return "Почтовый сервер отклонил авторизацию";
  if (retryableEmailError(error)) return "Почтовый сервер временно недоступен";
  return "Почтовый сервер отклонил отправку";
}
