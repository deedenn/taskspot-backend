import crypto from "node:crypto";
import jwt from "jsonwebtoken";

const DEFAULT_API_URL = "https://enter.tochka.com/uapi";
const DEFAULT_PUBLIC_KEY_URL = "https://enter.tochka.com/doc/openapi/static/keys/public";
const REQUEST_TIMEOUT_MS = 15000;
const PUBLIC_KEY_CACHE_MS = 6 * 60 * 60 * 1000;

let cachedPublicKey = null;
let publicKeyCachedAt = 0;

function configuration() {
  const configuredAccountId = process.env.TOCHKA_ACCOUNT_ID?.trim() || "";
  const bankCode = process.env.TOCHKA_BIC?.trim() || process.env.TOCHKA_BANK_CODE?.trim() || "";
  return {
    apiUrl: (process.env.TOCHKA_API_URL || DEFAULT_API_URL).replace(/\/$/, ""),
    token: process.env.TOCHKA_JWT_TOKEN?.trim() || "",
    clientId: process.env.TOCHKA_CLIENT_ID?.trim() || "",
    merchantId: process.env.TOCHKA_MERCHANT_ID?.trim() || "",
    accountId: configuredAccountId && !configuredAccountId.includes("/") && bankCode
      ? `${configuredAccountId}/${bankCode}`
      : configuredAccountId,
    publicKeyUrl: process.env.TOCHKA_WEBHOOK_PUBLIC_KEY_URL?.trim() || DEFAULT_PUBLIC_KEY_URL,
    publicKey: process.env.TOCHKA_WEBHOOK_PUBLIC_KEY?.replace(/\\n/g, "\n").trim() || ""
  };
}

function integrationError(message, { statusCode = 502, code = "TOCHKA_INTEGRATION_ERROR", cause, providerStatus } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.statusCode = statusCode;
  error.code = code;
  error.providerStatus = providerStatus;
  return error;
}

function unwrapResponse(payload) {
  return payload?.Data || payload?.data || payload?.result || payload;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function request(path, { method = "GET", body, fetchImpl = fetch, requiresPaymentConfig = true } = {}) {
  const config = configuration();
  if (!config.token || (requiresPaymentConfig && (!config.merchantId || !config.accountId))) {
    throw integrationError("Интеграция с банком Точка не настроена", {
      statusCode: 503,
      code: "TOCHKA_NOT_CONFIGURED"
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${config.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.token}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const payload = await parseResponse(response);
    if (!response.ok) {
      const providerMessage = payload?.message
        || payload?.Message
        || payload?.error?.message
        || payload?.error
        || `HTTP ${response.status}`;
      throw integrationError(`Банк Точка отклонил запрос: ${providerMessage}`, {
        code: "TOCHKA_REQUEST_FAILED",
        providerStatus: response.status
      });
    }
    return payload;
  } catch (error) {
    if (error.code?.startsWith("TOCHKA_")) throw error;
    if (error.name === "AbortError") {
      throw integrationError("Банк Точка не ответил вовремя", { code: "TOCHKA_TIMEOUT", cause: error });
    }
    throw integrationError("Не удалось выполнить запрос в банк Точка", {
      code: "TOCHKA_NETWORK_ERROR",
      cause: error
    });
  } finally {
    clearTimeout(timeout);
  }
}

function imageDataUrl(image) {
  if (!image) return "";
  if (typeof image === "string") {
    if (image.startsWith("data:")) return image.startsWith("data:image/png;base64,") ? image : "";
    return `data:image/png;base64,${image}`;
  }
  const content = image.content || image.data || image.base64 || "";
  if (!content) return "";
  const mediaType = image.mediaType || image.mimeType || "image/png";
  if (mediaType !== "image/png") return "";
  return content.startsWith("data:") ? content : `data:${mediaType};base64,${content}`;
}

export async function createDynamicQr({ order, fetchImpl = fetch }) {
  const config = configuration();
  const paymentPurpose = `Доступ к веб-сервису Taskspot по тарифу ${order.planName}. Заказ ${order._id}. НДС не облагается`.slice(0, 140);
  const redirectUrl = `${process.env.CLIENT_URL || "https://taskspot.ru"}/app/billing?payment=${order._id}`;
  const response = await request(
    `/sbp/v1.0/qr-code/merchant/${encodeURIComponent(config.merchantId)}/${encodeURIComponent(config.accountId)}`,
    {
      method: "POST",
      fetchImpl,
      body: {
        Data: {
          amount: order.amountKopecks,
          currency: "RUB",
          paymentPurpose,
          qrcType: "02",
          imageParams: { width: 320, height: 320, mediaType: "image/png" },
          ttl: 30,
          sourceName: "Taskspot",
          redirectUrl
        }
      }
    }
  );
  const data = unwrapResponse(response);
  const qrcId = data?.qrcId || data?.qrCodeId || data?.id;
  const qrPayload = data?.payload || data?.qrcPayload || data?.qrPayload || "";
  if (!qrcId || !qrPayload) {
    throw integrationError("Банк Точка вернул неполные данные QR-кода", {
      code: "TOCHKA_INVALID_RESPONSE"
    });
  }
  return {
    qrcId: String(qrcId),
    qrPayload: String(qrPayload),
    paymentUrl: String(qrPayload),
    qrImage: imageDataUrl(data?.image || data?.qrImage)
  };
}

export async function getQrPaymentStatuses(qrcIds, { fetchImpl = fetch } = {}) {
  const ids = [...new Set((Array.isArray(qrcIds) ? qrcIds : [qrcIds]).filter(Boolean).map(String))];
  if (!ids.length) return [];
  const response = await request(
    `/sbp/v1.0/qr-codes/${encodeURIComponent(ids.join(","))}/payment-status`,
    { fetchImpl }
  );
  const data = unwrapResponse(response);
  const list = data?.paymentList || data?.payments || [];
  return Array.isArray(list) ? list.map((item) => ({
    qrcId: String(item.qrcId || ""),
    status: String(item.status || "NotStarted"),
    operationId: String(item.trxId || item.operationId || ""),
    code: String(item.code || ""),
    message: String(item.message || "")
  })) : [];
}

export async function getWebhookConfiguration({ fetchImpl = fetch } = {}) {
  const config = configuration();
  if (!config.clientId) {
    throw integrationError("Не задан TOCHKA_CLIENT_ID", { statusCode: 503, code: "TOCHKA_CLIENT_ID_MISSING" });
  }
  return request(`/webhook/v1.0/${encodeURIComponent(config.clientId)}`, {
    fetchImpl,
    requiresPaymentConfig: false
  });
}

export async function upsertWebhookConfiguration({
  url = process.env.BILLING_WEBHOOK_URL || "https://api.taskspot.ru/api/webhooks/tochka/sbp",
  webhooksList = ["incomingSbpPayment"],
  fetchImpl = fetch
} = {}) {
  const config = configuration();
  if (!config.clientId) {
    throw integrationError("Не задан TOCHKA_CLIENT_ID", { statusCode: 503, code: "TOCHKA_CLIENT_ID_MISSING" });
  }
  let method = "POST";
  try {
    await getWebhookConfiguration({ fetchImpl });
  } catch (error) {
    if (error.providerStatus === 404) method = "PUT";
    else throw error;
  }
  return request(`/webhook/v1.0/${encodeURIComponent(config.clientId)}`, {
    method,
    body: { webhooksList, url },
    fetchImpl,
    requiresPaymentConfig: false
  });
}

async function loadPublicKey({ fetchImpl = fetch, forceRefresh = false } = {}) {
  const config = configuration();
  if (config.publicKey) return crypto.createPublicKey(config.publicKey);
  if (!forceRefresh && cachedPublicKey && Date.now() - publicKeyCachedAt < PUBLIC_KEY_CACHE_MS) {
    return cachedPublicKey;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(config.publicKeyUrl, {
      headers: { Accept: "application/json, text/plain" },
      signal: controller.signal
    });
  } catch (error) {
    throw integrationError("Не удалось получить публичный ключ Точки", {
      code: error.name === "AbortError" ? "TOCHKA_KEY_TIMEOUT" : "TOCHKA_KEY_FETCH_FAILED",
      cause: error
    });
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw integrationError("Не удалось получить публичный ключ Точки", { code: "TOCHKA_KEY_FETCH_FAILED" });
  }
  const text = await response.text();
  let key;
  try {
    const payload = JSON.parse(text);
    const jwk = payload?.key || payload?.publicKey || payload?.Data || payload;
    key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    key = crypto.createPublicKey(text);
  }
  cachedPublicKey = key;
  publicKeyCachedAt = Date.now();
  return key;
}

export async function verifyWebhookToken(token, { fetchImpl = fetch } = {}) {
  if (typeof token !== "string" || !token.trim()) {
    throw integrationError("Пустое уведомление Точки", { statusCode: 400, code: "TOCHKA_EMPTY_WEBHOOK" });
  }

  let key = await loadPublicKey({ fetchImpl });
  try {
    return jwt.verify(token.trim(), key, { algorithms: ["RS256"] });
  } catch (firstError) {
    if (configuration().publicKey) {
      throw integrationError("Неверная подпись уведомления Точки", {
        statusCode: 401,
        code: "TOCHKA_INVALID_SIGNATURE",
        cause: firstError
      });
    }
    key = await loadPublicKey({ fetchImpl, forceRefresh: true });
    try {
      return jwt.verify(token.trim(), key, { algorithms: ["RS256"] });
    } catch (error) {
      throw integrationError("Неверная подпись уведомления Точки", {
        statusCode: 401,
        code: "TOCHKA_INVALID_SIGNATURE",
        cause: error
      });
    }
  }
}

export function normalizeIncomingPayment(payload) {
  const data = unwrapResponse(payload);
  return {
    webhookType: data?.webhookType || payload?.webhookType || "",
    paymentType: data?.paymentType || payload?.paymentType || "",
    qrcId: String(data?.qrcId || payload?.qrcId || ""),
    merchantId: String(data?.merchantId || payload?.merchantId || ""),
    operationId: String(data?.operationId || payload?.operationId || ""),
    refTransactionId: String(data?.refTransactionId || payload?.refTransactionId || ""),
    amountRubles: String(data?.amount || payload?.amount || "")
  };
}

export function rublesToKopecks(value) {
  if (!/^\d+(?:\.\d{1,2})?$/.test(String(value))) return null;
  const [rubles, kopecks = ""] = String(value).split(".");
  return Number(rubles) * 100 + Number(kopecks.padEnd(2, "0"));
}

export function expectedMerchantId() {
  return configuration().merchantId;
}
