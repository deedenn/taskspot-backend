import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { DeviceSession } from "../models/DeviceSession.js";
import { User } from "../models/User.js";
import { requireJwtSecret } from "../config/env.js";
import { hashToken } from "./accountSecurity.js";

const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function publicSession(session, refreshToken, user) {
  const accessToken = jwt.sign(
    {
      userId: user._id,
      sessionVersion: user.sessionVersion || 0,
      sid: session._id,
      type: "mobile"
    },
    requireJwtSecret(),
    { algorithm: "HS256", expiresIn: ACCESS_TTL_SECONDS }
  );

  return { accessToken, refreshToken, expiresIn: ACCESS_TTL_SECONDS, user };
}

export async function createMobileSession(user, { installationId, platform = "unknown" }) {
  const refreshToken = crypto.randomBytes(48).toString("base64url");
  const session = await DeviceSession.create({
    user: user._id,
    installationId,
    platform: ["ios", "android"].includes(platform) ? platform : "unknown",
    refreshTokenHash: hashToken(refreshToken),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS)
  });
  return publicSession(session, refreshToken, user);
}

export async function rotateMobileSession(refreshToken) {
  if (typeof refreshToken !== "string" || refreshToken.length < 32) return null;
  const currentHash = hashToken(refreshToken);
  const nextToken = crypto.randomBytes(48).toString("base64url");
  const session = await DeviceSession.findOneAndUpdate(
    { refreshTokenHash: currentHash, revokedAt: null, expiresAt: { $gt: new Date() } },
    {
      $set: {
        refreshTokenHash: hashToken(nextToken),
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS)
      }
    },
    { new: true }
  );
  if (!session) return null;
  const user = await User.findById(session.user);
  if (!user || user.status !== "active" || user.isSuperAdmin || !user.emailVerifiedAt) {
    await DeviceSession.updateOne({ _id: session._id }, { revokedAt: new Date() });
    return null;
  }
  return publicSession(session, nextToken, user);
}

export async function revokeMobileSession({ sessionId, refreshToken }) {
  const filter = sessionId
    ? { _id: sessionId }
    : refreshToken
      ? { refreshTokenHash: hashToken(refreshToken) }
      : null;
  if (!filter) return;
  await DeviceSession.updateOne(filter, { $set: { revokedAt: new Date() } });
}

export async function requireMobileAuth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const payload = jwt.verify(token, requireJwtSecret(), { algorithms: ["HS256"] });
    if (payload.type !== "mobile" || !payload.sid) throw new Error("Invalid token type");
    const [user, session] = await Promise.all([
      User.findById(payload.userId),
      DeviceSession.findOne({ _id: payload.sid, user: payload.userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    ]);
    if (!user || !session || user.status !== "active" || user.isSuperAdmin || !user.emailVerifiedAt ||
        (user.sessionVersion || 0) !== (payload.sessionVersion || 0)) {
      return res.status(401).json({ message: "Mobile session is no longer valid" });
    }
    req.user = user;
    req.mobileSession = session;
    next();
  } catch {
    res.status(401).json({ message: "Invalid or expired mobile token" });
  }
}
