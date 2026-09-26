import "dotenv/config";
import { providerFor } from "../src/services/billingProviders.js";
import { checkDigitalKassaGroup } from "../src/services/digitalKassa.js";
import { getWebhookConfiguration } from "../src/services/tochkaSbp.js";

async function main() {
  const tochka = providerFor("tochka_sbp");
  const digitalKassa = providerFor("digitalkassa_sbp");
  const report = {
    tochka: { configured: tochka.ready, apiReachable: false, webhook: null },
    digitalKassa: { configured: digitalKassa.ready, apiReachable: false }
  };

  if (!tochka.ready) throw new Error("Не заполнены обязательные переменные Точки");
  if (!digitalKassa.ready) throw new Error("Не заполнены обязательные переменные DigitalKassa");

  const webhookResponse = await getWebhookConfiguration();
  const webhook = webhookResponse?.Data || webhookResponse?.data || webhookResponse;
  report.tochka.apiReachable = true;
  report.tochka.webhook = {
    url: webhook?.url || "",
    events: webhook?.webhooksList || []
  };

  await checkDigitalKassaGroup();
  report.digitalKassa.apiReachable = true;
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, code: error.code || error.name, message: error.message }, null, 2));
  process.exitCode = 1;
});
