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
    name: "СБП через DigitalKassa",
    ready: false
  },
  tochka_sbp: {
    key: "tochka_sbp",
    name: "СБП банка Точка",
    ready: false
  }
};

export function providerFor(key) {
  return BILLING_PROVIDERS[key] || BILLING_PROVIDERS.manual;
}

export function billingIntegrationPayload() {
  return {
    activeProvider: BILLING_PROVIDERS.mock,
    manualProvider: BILLING_PROVIDERS.manual,
    plannedProviders: [BILLING_PROVIDERS.digitalkassa_sbp, BILLING_PROVIDERS.tochka_sbp],
    testMode: true,
    note: "Работает тестовая оплата: подтверждение пользователя обрабатывается как успешный платёж. Позже этот источник заменит webhook банка."
  };
}
