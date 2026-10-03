import "dotenv/config";
import { billingIntegrationPayload, providerFor } from "../src/services/billingProviders.js";
import { checkDigitalKassaGroup } from "../src/services/digitalKassa.js";
import { getWebhookConfiguration } from "../src/services/tochkaSbp.js";

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
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error.code || error.name, message: error.message }, null, 2));
  process.exitCode = 1;
});
