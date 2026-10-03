import "dotenv/config";
import crypto from "node:crypto";
import { billingIntegrationPayload, providerFor } from "../src/services/billingProviders.js";
import { checkDigitalKassaGroup, createSaleReceipt, getReceiptStatus, receiptIdForOrder } from "../src/services/digitalKassa.js";
import { createDynamicQr, getQrPaymentStatuses, getWebhookConfiguration } from "../src/services/tochkaSbp.js";

const liveMode = process.argv.includes("--live");

function liveConfiguration() {
  const amountKopecks = Number(process.env.BILLING_CHECK_AMOUNT_KOPECKS);
  const email = process.env.BILLING_CHECK_RECEIPT_EMAIL?.trim().toLowerCase() || "";
  if (process.env.BILLING_CHECK_LIVE_CONFIRM !== "YES") {
    throw new Error("Для боевой проверки задайте BILLING_CHECK_LIVE_CONFIRM=YES");
  }
  if (!Number.isSafeInteger(amountKopecks) || amountKopecks < 100) {
    throw new Error("Задайте BILLING_CHECK_AMOUNT_KOPECKS целым числом не меньше 100");
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Задайте BILLING_CHECK_RECEIPT_EMAIL для контрольного чека");
  }
  return {
    amountKopecks,
    email,
    waitMinutes: Math.max(1, Math.min(25, Number(process.env.BILLING_CHECK_WAIT_MINUTES) || 10))
  };
}

async function runLiveCheck(report) {
  const config = liveConfiguration();
  const order = {
    _id: crypto.randomBytes(12).toString("hex"),
    planName: process.env.BILLING_CHECK_PLAN_NAME?.trim() || "Команда (контрольная оплата)",
    amountKopecks: config.amountKopecks,
    fiscalization: {}
  };
  order.fiscalization.receiptId = receiptIdForOrder(order._id);
  const qr = await createDynamicQr({ order });
  report.live = {
    qrcId: qr.qrcId,
    amountKopecks: config.amountKopecks,
    paymentUrl: qr.paymentUrl,
    status: "awaiting_payment"
  };
  console.log(JSON.stringify({
    livePayment: report.live,
    message: `Оплатите QR в течение ${config.waitMinutes} мин. После подтверждения будет отправлен контрольный чек.`
  }, null, 2));

  const deadline = Date.now() + config.waitMinutes * 60 * 1000;
  let payment;
  while (Date.now() < deadline) {
    const statuses = await getQrPaymentStatuses([qr.qrcId]);
    payment = statuses.find((item) => item.qrcId === qr.qrcId);
    if (payment?.status === "Accepted") break;
    if (payment?.status === "Rejected") throw new Error("Контрольный платёж отклонён банком");
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  if (payment?.status !== "Accepted") throw new Error("Не дождались оплаты контрольного QR");
  let receipt = await createSaleReceipt({ order, email: config.email });
  const receiptDeadline = Date.now() + 60 * 1000;
  while (!receipt.succeeded && Date.now() < receiptDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    receipt = await getReceiptStatus(receipt.receiptId);
  }
  report.live = {
    ...report.live,
    status: "paid",
    operationId: payment.operationId,
    receiptId: receipt.receiptId,
    receiptStatus: receipt.succeeded ? "succeeded" : "pending",
    receiptUrl: receipt.receiptUrl
  };
}

async function main() {
  const tochka = providerFor("tochka_sbp");
  const digitalKassa = providerFor("digitalkassa_sbp");
  const runtime = billingIntegrationPayload();
  const report = {
    ready: runtime.ready,
    runtime: {
      activeProvider: runtime.activeProvider.key,
      workersEnabled: runtime.workersEnabled,
      webhookReady: runtime.webhookReady,
      missing: runtime.missing
    },
    tochka: { configured: tochka.ready, apiReachable: false, webhook: null },
    digitalKassa: { configured: digitalKassa.ready, apiReachable: false }
  };

  if (!tochka.ready) throw new Error("Не заполнены обязательные переменные Точки");
  if (!digitalKassa.ready) throw new Error("Не заполнены обязательные переменные DigitalKassa");
  if (!runtime.ready) throw new Error(`Модуль оплаты не готов: ${runtime.missing.join(", ") || "неверная конфигурация"}`);

  const webhookResponse = await getWebhookConfiguration();
  const webhook = webhookResponse?.Data || webhookResponse?.data || webhookResponse;
  report.tochka.apiReachable = true;
  report.tochka.webhook = {
    url: webhook?.url || "",
    events: webhook?.webhooksList || []
  };
  const expectedWebhookUrl = process.env.BILLING_WEBHOOK_URL?.trim();
  if (report.tochka.webhook.url !== expectedWebhookUrl) {
    throw new Error(`Webhook Точки настроен на ${report.tochka.webhook.url || "пустой адрес"}, ожидается ${expectedWebhookUrl}`);
  }
  if (!report.tochka.webhook.events.includes("incomingSbpPayment")) {
    throw new Error("Webhook Точки не подписан на incomingSbpPayment");
  }

  await checkDigitalKassaGroup();
  report.digitalKassa.apiReachable = true;
  if (liveMode) await runLiveCheck(report);
  else report.live = { skipped: true, command: "npm run billing:check -- --live" };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error.code || error.name, message: error.message }, null, 2));
  process.exitCode = 1;
});
