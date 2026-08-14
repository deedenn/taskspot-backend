const buckets = new Map();

export function rateLimit({ windowMs, max, keyPrefix }) {
  return (req, res, next) => {
    if (process.env.NODE_ENV === "test") {
      return next();
    }

    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const key = `${keyPrefix}:${ip}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    bucket.count += 1;

    if (bucket.count > max) {
      res.set("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ message: "Too many attempts. Try again later." });
    }

    next();
  };
}
