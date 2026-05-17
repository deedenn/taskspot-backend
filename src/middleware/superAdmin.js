import { requireAuth } from "./auth.js";

export function requireSuperAdmin(req, res, next) {
  return requireAuth(req, res, () => {
    if (!req.user?.isSuperAdmin) {
      return res.status(403).json({ message: "Super admin access is required" });
    }

    next();
  });
}
