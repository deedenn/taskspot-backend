import jwt from "jsonwebtoken";
import { requireJwtSecret } from "../config/env.js";
import { User } from "../models/User.js";

export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;

    if (!token) {
      return res.status(401).json({ message: "Authentication is required" });
    }

    const payload = jwt.verify(token, requireJwtSecret(), { algorithms: ["HS256"] });
    const user = await User.findById(payload.userId);

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    if (user.status && user.status !== "active") {
      return res.status(403).json({ message: user.status === "blocked" ? "User is blocked" : "User is inactive" });
    }

    req.user = user;
    next();
  } catch (error) {
    res.status(401).json({ message: "Invalid token" });
  }
}

export function requireRegularUser(req, res, next) {
  return requireAuth(req, res, () => {
    if (!req.user?.emailVerifiedAt && ["pending", "sent", "failed", "skipped"].includes(req.user?.emailVerificationStatus)) {
      return res.status(403).json({
        message: "Подтвердите email, чтобы продолжить работу",
        requiresEmailVerification: true
      });
    }

    if (req.user?.isSuperAdmin) {
      return res.status(403).json({ message: "Super admin cannot use workspace features" });
    }

    next();
  });
}
