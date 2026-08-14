export const BILLING_PROVIDERS = {
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
    activeProvider: BILLING_PROVIDERS.manual,
    plannedProviders: [BILLING_PROVIDERS.digitalkassa_sbp, BILLING_PROVIDERS.tochka_sbp],
    note: "Сейчас тариф включается вручную администратором. Модель заявки уже хранит provider/payment поля для будущего СБП."
  };
}
