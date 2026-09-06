import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { requireJwtSecret } from "../config/env.js";

export const hashToken = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
export const normalizeEmail = (value) => typeof value === "string" && value.trim().length <= 254 ? value.trim().toLowerCase() : "";
export function strongPassword(value, admin = false) {
  return typeof value === "string" && value.length >= (admin ? 12 : 8) && Buffer.byteLength(value, "utf8") <= 72 &&
    /[A-Za-zА-Яа-яЁё]/.test(value) && /\d/.test(value) && (!admin || /[^\p{L}\p{N}\s]/u.test(value));
}
export function sessionToken(user, adminVerified = false) {
  return jwt.sign({ userId: user._id, sessionVersion: user.sessionVersion || 0,
    ...(adminVerified ? { amr: "email_otp" } : {}) }, requireJwtSecret(), {
    algorithm: "HS256", expiresIn: user.isSuperAdmin ? "30m" : "7d"
  });
}
export function validSession(user, payload) {
  return (user.sessionVersion || 0) === (payload.sessionVersion || 0) &&
    (!user.isSuperAdmin || payload.amr === "email_otp");
}
const eligible = (user) => user && user.status === "active" && user.emailVerificationStatus === "verified";
export async function requestPasswordReset(email, now = new Date()) {
  const user = await User.findOne({ email: normalizeEmail(email) });
  if (!eligible(user)) return;
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashToken(token);
  const url = new URL("/reset-password", process.env.CLIENT_URL || "https://taskspot.ru");
  url.searchParams.set("token", token);
  const key = `password-reset:${user._id}:${tokenHash}`;
  await User.updateOne({ _id: user._id, status: "active", $or: [
    { "passwordReset.requestedAt": { $exists: false } }, { "passwordReset.requestedAt": { $lte: new Date(now.getTime() - 60000) } }
  ] }, { $set: { passwordReset: {
    tokenHash, requestedAt: now, expiresAt: new Date(now.getTime() + 30 * 60000),
    outbox: { key, createdAt: now, context: { kind: "password_reset", userId: String(user._id), tokenHash, dedupeKey: key },
      mail: { to: user.email, subject: "Восстановление пароля Taskspot",
        text: `Для смены пароля перейдите по ссылке: ${url}\nСсылка действует 30 минут и может быть использована один раз. Если вы не запрашивали смену пароля, проигнорируйте письмо.` } }
  } } });
}
export async function resetPassword(token, password, now = new Date()) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) return null;
  const filter = { "passwordReset.tokenHash": hashToken(token), "passwordReset.expiresAt": { $gt: now },
    status: "active", emailVerificationStatus: "verified" };
  const user = await User.findOne(filter);
  if (!user) return null;
  if (!strongPassword(password, user.isSuperAdmin)) throw Object.assign(new Error(user.isSuperAdmin
    ? "Пароль администратора: от 12 символов, буквы, цифры и специальный символ"
    : "Пароль: от 8 символов, буквы и цифры; не более 72 байт"), { statusCode: 400 });
  const passwordHash = await bcrypt.hash(password, 12);
  return User.findOneAndUpdate({ ...filter, _id: user._id }, {
    $set: { passwordHash }, $inc: { sessionVersion: 1 }, $unset: { passwordReset: "", adminChallenge: "" }
  }, { new: true });
}
export async function startAdminChallenge(user, now = new Date()) {
  const id = crypto.randomBytes(32).toString("hex");
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const tokenHash = hashToken(id + ":" + code);
  const key = `admin-login:${user._id}:${id}`;
  const updated = await User.updateOne({ _id: user._id, status: "active", isSuperAdmin: true, passwordHash: user.passwordHash,
    $or: [{ "adminChallenge.requestedAt": { $exists: false } }, { "adminChallenge.requestedAt": { $lte: new Date(now.getTime() - 60000) } }]
  }, { $set: { adminChallenge: { id, tokenHash, attempts: 0, requestedAt: now, expiresAt: new Date(now.getTime() + 10 * 60000),
    outbox: { key, createdAt: now, context: { kind: "admin_login", userId: String(user._id), tokenHash, dedupeKey: key },
      mail: { to: user.email, subject: "Код входа в админку Taskspot", text: `Код входа: ${code}\nДействует 10 минут. Никому не сообщайте этот код.` } }
  } } });
  if (updated.modifiedCount !== 1) throw Object.assign(new Error("Подождите минуту перед повторным запросом кода"), { statusCode: 429 });
  return { requiresAdminCode: true, challengeId: id };
}
export async function finishAdminChallenge(id, code, now = new Date()) {
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id) || typeof code !== "string" || !/^\d{6}$/.test(code)) return null;
  // Reserve an attempt atomically across all backend replicas before checking the code.
  const filter = { "adminChallenge.id": id, "adminChallenge.expiresAt": { $gt: now },
    "adminChallenge.attempts": { $lt: 5 }, status: "active", isSuperAdmin: true };
  const user = await User.findOneAndUpdate(filter, { $inc: { "adminChallenge.attempts": 1 } }, { new: true }).select("+adminChallenge");
  if (!user || user.adminChallenge.tokenHash !== hashToken(id + ":" + code)) return null;
  return User.findOneAndUpdate({ _id: user._id, "adminChallenge.id": id,
    "adminChallenge.tokenHash": user.adminChallenge.tokenHash, status: "active", isSuperAdmin: true },
  { $unset: { adminChallenge: "" }, $set: { lastLoginAt: now } }, { new: true });
}
