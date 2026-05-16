import crypto from "crypto";

const DEFAULT_REGION = "ru-1";
const DEFAULT_UPLOAD_TTL_SECONDS = 300;
const DEFAULT_DOWNLOAD_TTL_SECONDS = 300;
const DEFAULT_MAX_FILE_SIZE = 20 * 1024 * 1024;

function env(name) {
  return process.env[name]?.trim();
}

export function isStorageConfigured() {
  return Boolean(
    env("S3_ENDPOINT") &&
      env("S3_BUCKET") &&
      env("S3_ACCESS_KEY_ID") &&
      env("S3_SECRET_ACCESS_KEY")
  );
}

export function maxUploadSize() {
  const megabytes = Number(process.env.S3_MAX_FILE_SIZE_MB || 20);
  return Number.isFinite(megabytes) && megabytes > 0
    ? megabytes * 1024 * 1024
    : DEFAULT_MAX_FILE_SIZE;
}

export function safeFileName(fileName) {
  const fallback = "attachment";
  const normalized = String(fileName || fallback)
    .normalize("NFKD")
    .replace(/[^\w.\-\sа-яА-ЯёЁ]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 120);

  return normalized || fallback;
}

export function attachmentKey({ projectId, taskId, userId, fileName }) {
  const scope = projectId && taskId
    ? `${projectId}/${taskId}/${userId}`
    : `${userId}`;
  return `attachments/${scope}/${Date.now()}-${crypto.randomUUID()}-${safeFileName(fileName)}`;
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function amzDate(date = new Date()) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function dateStamp(amzTimestamp) {
  return amzTimestamp.slice(0, 8);
}

function encodePath(value) {
  return value
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function canonicalQuery(params) {
  return Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
}

function signingKey(secretKey, date, region) {
  const kDate = hmac(`AWS4${secretKey}`, date);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
}

export function presignedS3Url({ key, method = "GET", expires = DEFAULT_DOWNLOAD_TTL_SECONDS }) {
  if (!isStorageConfigured()) {
    const error = new Error("File storage is not configured");
    error.statusCode = 503;
    throw error;
  }

  const endpoint = env("S3_ENDPOINT").replace(/\/$/, "");
  const bucket = env("S3_BUCKET");
  const accessKey = env("S3_ACCESS_KEY_ID");
  const secretKey = env("S3_SECRET_ACCESS_KEY");
  const region = env("S3_REGION") || DEFAULT_REGION;
  const timestamp = amzDate();
  const date = dateStamp(timestamp);
  const credentialScope = `${date}/${region}/s3/aws4_request`;
  const host = new URL(endpoint).host;
  const canonicalUri = `/${bucket}/${encodePath(key)}`;
  const query = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Content-Sha256": "UNSIGNED-PAYLOAD",
    "X-Amz-Credential": `${accessKey}/${credentialScope}`,
    "X-Amz-Date": timestamp,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host"
  };
  const queryString = canonicalQuery(query);
  const canonicalRequest = [
    method,
    canonicalUri,
    queryString,
    `host:${host}`,
    "",
    "host",
    "UNSIGNED-PAYLOAD"
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    credentialScope,
    sha256(canonicalRequest)
  ].join("\n");
  const signature = hmac(signingKey(secretKey, date, region), stringToSign, "hex");

  return `${endpoint}${canonicalUri}?${queryString}&X-Amz-Signature=${signature}`;
}

export function uploadUrlForKey(key) {
  return presignedS3Url({ key, method: "PUT", expires: DEFAULT_UPLOAD_TTL_SECONDS });
}

export function downloadUrlForKey(key) {
  return presignedS3Url({ key, method: "GET", expires: DEFAULT_DOWNLOAD_TTL_SECONDS });
}

export async function deleteObjectForKey(key) {
  const deleteUrl = presignedS3Url({ key, method: "DELETE", expires: DEFAULT_DOWNLOAD_TTL_SECONDS });
  const response = await fetch(deleteUrl, { method: "DELETE" });

  if (!response.ok && response.status !== 404) {
    const error = new Error("Failed to delete file from storage");
    error.statusCode = response.status;
    throw error;
  }
}
