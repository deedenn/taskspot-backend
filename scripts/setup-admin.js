import dotenv from "dotenv";
import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setupAdmin } from "../src/services/adminSetup.js";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(root, ".env"), quiet: true });
try {
  if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI не задан");
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const result = await setupAdmin({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD,
    name: process.env.ADMIN_NAME, promote: process.argv.includes("--promote"), rotate: process.argv.includes("--rotate-password") });
  console.log(result.created ? "Администратор создан. Вход подтверждается кодом из почты." : "Администратор обновлён. Предыдущие сессии отозваны.");
} catch (error) {
  console.error(error.safeMessage ? error.message : "Не удалось настроить администратора. Проверьте MongoDB и параметры.");
  process.exitCode = 1;
} finally { await mongoose.disconnect(); }
