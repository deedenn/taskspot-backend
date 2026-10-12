import { User } from "../models/User.js";
import { normalizeEmail } from "./accountSecurity.js";

function safeError(message) {
  return Object.assign(new Error(message), { safeMessage: true });
}

export async function changeAdminEmail({ currentEmail, email }) {
  const normalizedCurrentEmail = normalizeEmail(currentEmail);
  const normalizedEmail = normalizeEmail(email);

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedCurrentEmail) ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    throw safeError("Нужны корректные ADMIN_CURRENT_EMAIL и ADMIN_EMAIL");
  }

  const admin = await User.findOne({
    email: normalizedCurrentEmail,
    isSuperAdmin: true,
    status: "active"
  });
  if (!admin) {
    throw safeError("Активный суперадминистратор с ADMIN_CURRENT_EMAIL не найден");
  }

  if (normalizedCurrentEmail === normalizedEmail) {
    return { updated: false };
  }

  if (await User.exists({ email: normalizedEmail, _id: { $ne: admin._id } })) {
    throw safeError("ADMIN_EMAIL уже используется другим аккаунтом");
  }

  let updated;
  try {
    updated = await User.findOneAndUpdate({
      _id: admin._id,
      email: normalizedCurrentEmail,
      isSuperAdmin: true,
      status: "active"
    }, {
      $set: {
        email: normalizedEmail,
        emailVerifiedAt: new Date(),
        emailVerificationStatus: "verified",
        emailVerificationTokenHash: "",
        emailVerificationError: ""
      },
      $inc: { sessionVersion: 1 },
      $unset: {
        passwordReset: "",
        adminChallenge: "",
        emailOutbox: "",
        emailVerificationExpiresAt: "",
        emailVerificationSentAt: ""
      }
    }, { new: true });
  } catch (error) {
    if (error?.code === 11000) {
      throw safeError("ADMIN_EMAIL уже используется другим аккаунтом");
    }
    throw error;
  }

  if (!updated) {
    throw safeError("Аккаунт администратора изменён другим запросом. Проверьте email и повторите команду.");
  }

  return { updated: true };
}
