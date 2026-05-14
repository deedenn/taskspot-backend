export function requireJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    throw new Error("JWT_SECRET is required");
  }

  return secret;
}

export function validateRuntimeEnv() {
  const missing = ["MONGODB_URI", "JWT_SECRET"].filter((key) => !process.env[key]);

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  if (process.env.NODE_ENV === "production" && process.env.JWT_SECRET.length < 32) {
    throw new Error("JWT_SECRET must be at least 32 characters in production");
  }
}
