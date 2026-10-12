import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { changeAdminEmail } from "../src/services/adminEmail.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });

try {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI не задан");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const result = await changeAdminEmail({
    currentEmail: process.env.ADMIN_CURRENT_EMAIL,
    email: process.env.ADMIN_EMAIL
  });
  console.log(result.updated
    ? "Email суперадминистратора обновлён. Предыдущие сессии отозваны."
    : "Email суперадминистратора уже установлен.");
} catch (error) {
  console.error(error.safeMessage ? error.message : "Не удалось изменить email суперадминистратора. Проверьте MongoDB и параметры.");
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
