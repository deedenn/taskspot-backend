import bcrypt from "bcryptjs";
import { User } from "../models/User.js";
import { normalizeEmail, strongPassword } from "./accountSecurity.js";

export async function setupAdmin({ email, password, name = "Администратор", promote = false, rotate = false, temporary = false }) {
  email = normalizeEmail(email);
  name = typeof name === "string" && name.trim() ? name.trim() : "Администратор";
  if (temporary && !rotate) {
    throw Object.assign(new Error("Временный пароль разрешён только вместе с --rotate-password"), { safeMessage: true });
  }
  const passwordIsValid = temporary ? strongPassword(password) : strongPassword(password, true);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !passwordIsValid) {
    throw Object.assign(new Error(temporary
      ? "Для временного ADMIN_PASSWORD нужны минимум 8 символов, буквы и цифры, максимум 72 байта"
      : "Нужны корректный ADMIN_EMAIL и ADMIN_PASSWORD: от 12 символов, буквы, цифры, специальный символ, максимум 72 байта"), { safeMessage: true });
  }
  const existing = await User.findOne({ email });
  if (temporary && !existing?.isSuperAdmin) {
    throw Object.assign(new Error("Временный пароль можно назначить только существующему суперадминистратору"), { safeMessage: true });
  }
  if (existing && !(existing.isSuperAdmin ? rotate : promote)) {
    throw Object.assign(new Error("Аккаунт существует. Для администратора укажите --rotate-password, для назначения обычного пользователя --promote"), { safeMessage: true });
  }
  if (existing && existing.status !== "active") throw Object.assign(new Error("Заблокированный или неактивный аккаунт нельзя изменить этой командой"), { safeMessage: true });
  const passwordHash = await bcrypt.hash(password, 12);
  if (existing) {
    const changed = await User.updateOne({ _id: existing._id, status: "active", passwordHash: existing.passwordHash, isSuperAdmin: existing.isSuperAdmin }, {
      $set: { isSuperAdmin: true, mustChangePassword: temporary, passwordHash, emailVerifiedAt: new Date(), emailVerificationStatus: "verified", emailVerificationTokenHash: "" },
      $inc: { sessionVersion: 1 }, $unset: { passwordReset: "", adminChallenge: "", emailOutbox: "" }
    });
    if (changed.modifiedCount !== 1) throw Object.assign(new Error("Аккаунт изменён другим запросом. Проверьте его состояние и повторите команду."), { safeMessage: true });
    return { updated: true };
  }
  await User.create({ email, name, passwordHash, isSuperAdmin: true, mustChangePassword: false, emailVerifiedAt: new Date(), emailVerificationStatus: "verified" });
  return { created: true };
}
