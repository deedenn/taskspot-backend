import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { normalizeEmail, strongPassword } from "./accountSecurity.js";

export async function setupAdmin({ email, password, name = "Администратор", promote = false, rotate = false }) {
  email = normalizeEmail(email);
  name = typeof name === "string" && name.trim() ? name.trim() : "Администратор";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !strongPassword(password, true)) {
    throw Object.assign(new Error("Нужны корректный ADMIN_EMAIL и ADMIN_PASSWORD: от 12 символов, буквы, цифры, специальный символ, максимум 72 байта"), { safeMessage: true });
  }
  const existing = await User.findOne({ email });
  if (existing && !(existing.isSuperAdmin ? rotate : promote)) {
    throw Object.assign(new Error("Аккаунт существует. Для администратора укажите --rotate-password, для назначения обычного пользователя --promote"), { safeMessage: true });
  }
  if (existing && existing.status !== "active") throw Object.assign(new Error("Заблокированный или неактивный аккаунт нельзя изменить этой командой"), { safeMessage: true });
  const passwordHash = await bcrypt.hash(password, 12);
  if (existing) {
    const changed = await User.updateOne({ _id: existing._id, status: "active", passwordHash: existing.passwordHash, isSuperAdmin: existing.isSuperAdmin }, {
      $set: { isSuperAdmin: true, passwordHash, emailVerifiedAt: new Date(), emailVerificationStatus: "verified", emailVerificationTokenHash: "" },
      $inc: { sessionVersion: 1 }, $unset: { passwordReset: "", adminChallenge: "", emailOutbox: "" }
    });
    if (changed.modifiedCount !== 1) throw Object.assign(new Error("Аккаунт изменён другим запросом. Проверьте его состояние и повторите команду."), { safeMessage: true });
    return { updated: true };
  }
  await User.create({ email, name, passwordHash, isSuperAdmin: true, emailVerifiedAt: new Date(), emailVerificationStatus: "verified" });
  return { created: true };
}
