import { dateKey } from "./taskSchedule.js";
const DAY = 86400000;
const key = (value) => String(value?._id || value);
export function buildProductAnalytics({ users, projects, tasks, payments, events, coverageStart, now = new Date() }) {
  const first = (rows) => new Map(rows.map((row) => [key(row._id), new Date(row.at)]));
  const projectMap = first(projects), taskMap = first(tasks), paymentMap = first(payments);
  let verified = 0, withProject = 0, activated = 0, paid = 0, returned = 0, d7Eligible = 0, d7Returned = 0, billingViewed = 0;
  const days = new Map(), billingUsers = new Set();
  for (const event of events) {
    const id = key(event.user);
    if (event.event === "billing_viewed") { billingUsers.add(id); continue; }
    const dates = days.get(id) || new Set(); dates.add(event.day); days.set(id, dates);
  }
  for (const user of users) {
    const id = key(user._id);
    if (user.emailVerifiedAt || user.emailVerificationStatus === "verified") verified += 1;
    if (projectMap.has(id)) withProject += 1;
    // Invited members can activate without creating their own project.
    if (taskMap.has(id)) activated += 1;
    if (paymentMap.has(id)) paid += 1;
    if (billingUsers.has(id)) billingViewed += 1;
    if ((days.get(id)?.size || 0) >= 2) returned += 1;
    const registeredDay = dateKey(new Date(user.createdAt), "Europe/Moscow");
    const seventh = new Date(registeredDay + "T00:00:00+03:00").getTime() + 7 * DAY;
    if (coverageStart && new Date(user.createdAt) >= new Date(coverageStart) && seventh + DAY <= now.getTime()) {
      d7Eligible += 1;
      if (days.get(id)?.has(dateKey(new Date(seventh), "Europe/Moscow"))) d7Returned += 1;
    }
  }
  const count = users.length;
  const metric = (key, label, value) => ({ key, label, value, percent: value == null ? null : count ? Math.round(value / count * 1000) / 10 : 0 });
  return { registered: count, milestones: [
    metric("verified", "Подтвердили email", verified), metric("project", "Создали свой проект", withProject),
    metric("activated", "Создали хотя бы одну задачу", activated), metric("billing", "Открыли тарифы (с начала наблюдений)", coverageStart ? billingViewed : null),
    metric("paid", "Совершили оплату", paid), metric("returned", "Вернулись в другой день (с начала наблюдений)", coverageStart ? returned : null)
  ], withoutTask: count - activated, unverified: count - verified,
    d7: { eligible: d7Eligible, returned: d7Returned, percent: d7Eligible ? Math.round(d7Returned / d7Eligible * 1000) / 10 : null },
    coverageStart, measuredAt: now };
}
