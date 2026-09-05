import crypto from "node:crypto";
import { EmailJob } from "../models/EmailJob.js";

export async function enqueueEmail(mail, context = {}) {
  const dedupeKey = context.dedupeKey || crypto.randomUUID();
  let job;
  try {
    job = await EmailJob.findOneAndUpdate({ dedupeKey }, { $setOnInsert: {
      dedupeKey, mail, context,
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
