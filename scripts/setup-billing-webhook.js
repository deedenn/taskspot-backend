import "dotenv/config";
import { upsertWebhookConfiguration } from "../src/services/tochkaSbp.js";

async function main() {
  const url = process.env.BILLING_WEBHOOK_URL || "https://api.taskspot.ru/api/webhooks/tochka/sbp";
  const response = await upsertWebhookConfiguration({
    url,
    webhooksList: ["incomingSbpPayment"]
  });
  const webhook = response?.Data || response?.data || response;
  console.log(JSON.stringify({
    ok: true,
    url: webhook?.url || url,
    events: webhook?.webhooksList || ["incomingSbpPayment"]
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error.code || error.name, message: error.message }, null, 2));
  process.exitCode = 1;
});
