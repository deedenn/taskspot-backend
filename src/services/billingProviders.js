const hasValues = (...names) => names.every((name) => Boolean(process.env[name]?.trim()));

function validHttpsUrl(value) {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

export const BILLING_PROVIDERS = {
  mock: {
    key: "mock",
    name: "Тестовая оплата",
    ready: true,
    testMode: true
  },
  manual: {
    key: "manual",
    name: "Ручное включение",
    ready: true
  },
  digitalkassa_sbp: {
    key: "digitalkassa_sbp",
    name: "Чеки DigitalKassa",
    ready: false
  },
  tochka_sbp: {
    key: "tochka_sbp",
    name: "СБП банка Точка",
    ready: false
  }
};

export function providerFor(key) {
  const provider = BILLING_PROVIDERS[key];
  if (!provider) return { key: String(key || "unknown"), name: "Неизвестный провайдер", ready: false };
  if (provider.key === "tochka_sbp") {
    const accountId = process.env.TOCHKA_ACCOUNT_ID?.trim() || "";
    const hasBankCode = accountId.includes("/") || Boolean(process.env.TOCHKA_BIC?.trim() || process.env.TOCHKA_BANK_CODE?.trim());
    return {
      ...provider,
      ready: hasValues("TOCHKA_JWT_TOKEN", "TOCHKA_CLIENT_ID", "TOCHKA_MERCHANT_ID", "TOCHKA_ACCOUNT_ID") && hasBankCode
    };
  }
  if (provider.key === "digitalkassa_sbp") {
    return {
      ...provider,
      ready: hasValues("DIGITALKASSA_ACTOR_ID", "DIGITALKASSA_ACTOR_TOKEN", "DIGITALKASSA_C_GROUP_ID")
    };
  }
  return provider;
}

export function activeBillingProvider() {
  if (process.env.NODE_ENV === "test") return providerFor("mock");

  const explicitlySelected = process.env.BILLING_PROVIDER?.trim();
  if (explicitlySelected) return providerFor(explicitlySelected);

  const tochka = providerFor("tochka_sbp");
  if (process.env.NODE_ENV === "production" && tochka.ready) return tochka;
  if (process.env.NODE_ENV === "production") return { ...providerFor("manual"), ready: false };
  return providerFor("mock");
}

export function billingIntegrationPayload() {
  const activeProvider = activeBillingProvider();
  const fiscalProvider = providerFor("digitalkassa_sbp");
  const testMode = activeProvider.key === "mock";
  const workersEnabled = process.env.BACKGROUND_WORKERS_ENABLED !== "false";
  const webhookUrl = process.env.BILLING_WEBHOOK_URL?.trim() || "";
  const webhookReady = validHttpsUrl(webhookUrl);
  const productionReady = activeProvider.key === "tochka_sbp"
    && activeProvider.ready
    && fiscalProvider.ready
    && workersEnabled
    && webhookReady;
  const ready = testMode ? activeProvider.ready : productionReady;
  const missing = [];
  if (!testMode && !activeProvider.ready) missing.push("Точка");
  if (!testMode && !fiscalProvider.ready) missing.push("DigitalKassa");
  if (!testMode && !webhookReady) missing.push("HTTPS webhook");
  if (!testMode && !workersEnabled) missing.push("фоновые workers");
  return {
    activeProvider,
    fiscalProvider,
    manualProvider: providerFor("manual"),
    testMode,
    ready,
    workersEnabled,
    webhookReady,
    missing,
    note: testMode
      ? "Тестовый режим: подтверждение пользователя имитирует успешный платёж."
      : ready
        ? "Оплата проходит через СБП банка Точка. Статус обновляется автоматически после подтверждения банка."
        : `Оплата временно недоступна: ${missing.join(", ") || "неверная конфигурация"}.`
  };
}
