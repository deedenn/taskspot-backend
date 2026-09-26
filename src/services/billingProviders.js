const hasValues = (...names) => names.every((name) => Boolean(process.env[name]?.trim()));

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
  const provider = BILLING_PROVIDERS[key] || BILLING_PROVIDERS.manual;
  if (provider.key === "tochka_sbp") {
    return {
      ...provider,
      ready: hasValues("TOCHKA_JWT_TOKEN", "TOCHKA_MERCHANT_ID", "TOCHKA_ACCOUNT_ID")
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
  return {
    activeProvider,
    fiscalProvider,
    manualProvider: providerFor("manual"),
    testMode,
    ready: activeProvider.ready,
    note: testMode
      ? "Тестовый режим: подтверждение пользователя имитирует успешный платёж."
      : activeProvider.ready
        ? "Оплата проходит через СБП банка Точка. Статус обновляется автоматически после подтверждения банка."
        : "Платёжный провайдер не настроен. Обратитесь к администратору."
  };
}
