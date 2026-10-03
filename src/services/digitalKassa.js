const DEFAULT_API_URL = "https://api.digitalkassa.ru/v2.1";
const REQUEST_TIMEOUT_MS = 15000;

function configuration() {
  return {
    apiUrl: (process.env.DIGITALKASSA_API_URL || DEFAULT_API_URL).replace(/\/$/, ""),
    actorId: process.env.DIGITALKASSA_ACTOR_ID?.trim() || "",
    actorToken: process.env.DIGITALKASSA_ACTOR_TOKEN?.trim() || "",
    groupId: process.env.DIGITALKASSA_C_GROUP_ID?.trim() || "",
    billingPlace: process.env.DIGITALKASSA_BILLING_PLACE?.trim() || "https://taskspot.ru"
  };
}

function integrationError(message, { code = "DIGITALKASSA_INTEGRATION_ERROR", cause, providerPayload } = {}) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.statusCode = 502;
  error.code = code;
  error.providerPayload = providerPayload;
  return error;
}

function errorDescription(payload, fallback) {
  if (Array.isArray(payload)) {
    return payload.map((item) => [item.path, item.desc].filter(Boolean).join(": ")).filter(Boolean).join("; ") || fallback;
  }
  return payload?.message || payload?.error || payload?.desc || fallback;
}

async function request(path, { method = "GET", body, fetchImpl = fetch } = {}) {
  const config = configuration();
  if (!config.actorId || !config.actorToken || !config.groupId) {
    throw integrationError("Интеграция с DigitalKassa не настроена", { code: "DIGITALKASSA_NOT_CONFIGURED" });
  }
  const authorization = Buffer.from(`${config.actorId}:${config.actorToken}`).toString("base64");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${config.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${authorization}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json; charset=utf-8" } : {})
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = { raw: text }; }
    }
    if (![200, 201, 202].includes(response.status)) {
      throw integrationError(`DigitalKassa отклонила чек: ${errorDescription(payload, `HTTP ${response.status}`)}`, {
        code: "DIGITALKASSA_REQUEST_FAILED",
        providerPayload: payload
      });
    }
    return { statusCode: response.status, payload };
  } catch (error) {
    if (error.code?.startsWith("DIGITALKASSA_")) throw error;
    if (error.name === "AbortError") {
      throw integrationError("DigitalKassa не ответила вовремя", { code: "DIGITALKASSA_TIMEOUT", cause: error });
    }
    throw integrationError("Не удалось выполнить запрос в DigitalKassa", {
      code: "DIGITALKASSA_NETWORK_ERROR",
      cause: error
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function receiptIdForOrder(orderId) {
  return `taskspot${String(orderId).replace(/[^a-zA-Z0-9]/g, "")}`.slice(0, 64);
}

export function receiptIdForRefund(refundId) {
  return `taskspotrefund${String(refundId).replace(/[^a-zA-Z0-9]/g, "")}`.slice(0, 64);
}

function receiptBody({ type, name, amountKopecks, email }) {
  const amountRubles = amountKopecks / 100;
  return {
    type,
    items: [{
      type: 4,
      name: name.slice(0, 128),
      price: amountRubles,
      quantity: 1,
      amount: amountRubles,
      vat: 6,
      payment_method: 4,
      unit: 0
    }],
    taxation: 2,
    is_internet: 1,
    timezone: 2,
    amount: { cashless: amountRubles },
    notify: { emails: [email] },
    loc: { billing_place: configuration().billingPlace }
  };
}

export function buildSaleReceipt({ order, email }) {
  return receiptBody({
    type: 1,
    name: `Доступ к веб-сервису Taskspot по тарифу ${order.planName}`,
    amountKopecks: order.amountKopecks,
    email
  });
}

export function buildRefundReceipt({ order, refund, email }) {
  return receiptBody({
    type: 2,
    name: `Возврат оплаты доступа к веб-сервису Taskspot по тарифу ${order.planName}`,
    amountKopecks: refund.amountKopecks,
    email
  });
}

function normalizedResult(receiptId, response) {
  return {
    receiptId,
    pending: response.statusCode === 202,
    succeeded: [200, 201].includes(response.statusCode),
    receiptUrl: response.payload?.service?.receipt_url || "",
    providerPayload: response.payload
  };
}

export async function createSaleReceipt({ order, email, fetchImpl = fetch }) {
  const config = configuration();
  const receiptId = order.fiscalization?.receiptId || receiptIdForOrder(order._id);
  const response = await request(
    `/c_groups/${encodeURIComponent(config.groupId)}/receipts/${encodeURIComponent(receiptId)}`,
    { method: "POST", body: buildSaleReceipt({ order, email }), fetchImpl }
  );
  return normalizedResult(receiptId, response);
}

export async function createRefundReceipt({ order, refund, email, fetchImpl = fetch }) {
  const config = configuration();
  const receiptId = refund.fiscalization?.receiptId || receiptIdForRefund(refund._id);
  const response = await request(
    `/c_groups/${encodeURIComponent(config.groupId)}/receipts/${encodeURIComponent(receiptId)}`,
    { method: "POST", body: buildRefundReceipt({ order, refund, email }), fetchImpl }
  );
  return normalizedResult(receiptId, response);
}

export async function getReceiptStatus(receiptId, { fetchImpl = fetch } = {}) {
  const config = configuration();
  const response = await request(
    `/c_groups/${encodeURIComponent(config.groupId)}/receipts/${encodeURIComponent(receiptId)}`,
    { fetchImpl }
  );
  return normalizedResult(receiptId, response);
}

export async function checkDigitalKassaGroup({ fetchImpl = fetch } = {}) {
  const config = configuration();
  const response = await request(`/c_groups/${encodeURIComponent(config.groupId)}`, { fetchImpl });
  return response.payload;
}
