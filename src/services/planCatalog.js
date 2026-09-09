export const PLAN_VERSION = 1;

export const PLANS = {
  free: {
    key: "free",
    version: PLAN_VERSION,
    name: "Бесплатный",
    price: "0 ₽",
    monthlyPrice: 0,
    monthlyPriceKopecks: 0,
    limits: {
      organizations: 1,
      users: 3,
      projects: 2,
      activeTasks: 50,
      attachments: 20,
      templates: 3,
      recurringTasks: 0,
      historyDays: 30
    }
  },
  team: {
    key: "team",
    version: PLAN_VERSION,
    name: "Команда",
    price: "990 ₽/мес",
    monthlyPrice: 990,
    monthlyPriceKopecks: 99000,
    limits: {
      organizations: 3,
      users: 20,
      projects: 50,
      activeTasks: 1000,
      attachments: 500,
      templates: 50,
      recurringTasks: 100,
      historyDays: 365
    }
  },
  business: {
    key: "business",
    version: PLAN_VERSION,
    name: "Бизнес",
    price: "2490 ₽/мес",
    monthlyPrice: 2490,
    monthlyPriceKopecks: 249000,
    limits: {
      organizations: 10,
      users: 100,
      projects: 200,
      activeTasks: 10000,
      attachments: 5000,
      templates: 200,
      recurringTasks: 1000,
      historyDays: 0
    }
  }
};

export function publicPlan(plan) {
  return {
    key: plan.key,
    version: plan.version,
    name: plan.name,
    price: plan.price,
    monthlyPrice: plan.monthlyPrice,
    monthlyPriceKopecks: plan.monthlyPriceKopecks,
    limits: plan.limits
  };
}
