import crypto from "node:crypto";
import mongoose from "mongoose";
import { BillingEvent } from "../models/BillingEvent.js";
import { Organization } from "../models/Organization.js";
import { PaymentOrder } from "../models/PaymentOrder.js";
import { Subscription } from "../models/Subscription.js";
import { SubscriptionPeriod } from "../models/SubscriptionPeriod.js";
import { PLANS } from "./planCatalog.js";

const OPEN_ORDER_TTL_MS = 30 * 60 * 1000;

function querySession(query, session) {
  return session ? query.session(session) : query;
}

export function addCalendarMonths(value, months) {
  const date = new Date(value);
  const day = date.getUTCDate();
  const result = new Date(date);
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

export function transitionFor(currentPlanKey, targetPlanKey) {
  if (!currentPlanKey || currentPlanKey === "free") return "activate";
  if (currentPlanKey === targetPlanKey) return "renew";
  return PLANS[targetPlanKey].monthlyPriceKopecks > PLANS[currentPlanKey].monthlyPriceKopecks
    ? "upgrade"
    : "downgrade";
}

async function recordEvent({
  type,
  aggregateType,
  aggregateId,
  organizationId,
  actorType,
  actorId,
  idempotencyKey,
  correlationId,
  causationId,
  payload = {},
  session
}) {
  const [event] = await BillingEvent.create(
    [{
      type,
      aggregateType,
      aggregateId,
      organization: organizationId,
      actorType,
      actorId: actorId ? String(actorId) : "",
      correlationId: correlationId ? String(correlationId) : "",
      causationId: causationId ? String(causationId) : "",
      idempotencyKey,
      payload,
      occurredAt: new Date()
    }],
    session ? { session } : undefined
  );
  return event;
}

async function createPeriod(values, session) {
  const [period] = await SubscriptionPeriod.create([values], session ? { session } : undefined);
  return period;
}

async function mirrorOrganization(organization, subscription, currentPeriod, { session } = {}) {
  const planAssignedAt = currentPeriod.activatedAt || currentPeriod.startsAt;
  const update = {
    plan: currentPeriod.plan,
    planAssignedAt,
    planSource: currentPeriod.source === "payment"
      ? "billing"
      : currentPeriod.source === "manual"
        ? "manual"
        : "system",
    planChangeReason: currentPeriod.note || ""
  };
  const unset = {};

  if (currentPeriod.endsAt) update.planExpiresAt = currentPeriod.endsAt;
  else unset.planExpiresAt = "";

  if (currentPeriod.createdBy) update.planAssignedBy = currentPeriod.createdBy;
  else unset.planAssignedBy = "";

  await Organization.updateOne(
    { _id: organization._id },
    { $set: update, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
    session ? { session } : undefined
  );

  organization.plan = currentPeriod.plan;
  organization.planExpiresAt = currentPeriod.endsAt;
  organization.planAssignedAt = planAssignedAt;
  organization.planSource = update.planSource;
  organization.planChangeReason = update.planChangeReason;
  subscription.currentPlan = currentPeriod.plan;
}

async function initializeSubscription(subscription, organization, { session = null, now = new Date() } = {}) {
  const legacyPlan = PLANS[organization.plan] ? organization.plan : "free";
  const legacyStart = organization.planAssignedAt || organization.createdAt || now;
  let currentPeriod;

  if (legacyPlan !== "free" && organization.planExpiresAt && organization.planExpiresAt <= now) {
    await createPeriod({
      subscription: subscription._id,
      organization: organization._id,
      plan: legacyPlan,
      status: "expired",
      startsAt: legacyStart,
      endsAt: organization.planExpiresAt,
      activatedAt: legacyStart,
      endedAt: organization.planExpiresAt,
      source: "migration",
      transitionType: "initial",
      endReason: "legacy_period_expired"
    }, session);
    currentPeriod = await createPeriod({
      subscription: subscription._id,
      organization: organization._id,
      plan: "free",
      status: "active",
      startsAt: organization.planExpiresAt,
      activatedAt: now,
      source: "system",
      transitionType: "fallback",
      note: "Автоматический переход после окончания тарифа"
    }, session);
  } else {
    currentPeriod = await createPeriod({
      subscription: subscription._id,
      organization: organization._id,
      plan: legacyPlan,
      status: "active",
      startsAt: legacyStart,
      endsAt: legacyPlan === "free" ? undefined : organization.planExpiresAt,
      activatedAt: legacyStart,
      source: "migration",
      transitionType: "initial",
      note: organization.planChangeReason || "Перенесено из текущего тарифа организации"
    }, session);
  }

  subscription.currentPeriod = currentPeriod._id;
  subscription.currentPlan = currentPeriod.plan;
  await subscription.save(session ? { session } : undefined);
  await mirrorOrganization(organization, subscription, currentPeriod, { session });
  return subscription;
}

export async function ensureSubscription(organization, { session = null, now = new Date() } = {}) {
  let subscription = await querySession(Subscription.findOne({ organization: organization._id }), session);
  if (subscription?.currentPeriod) return subscription;

  if (!subscription) {
    subscription = await querySession(Subscription.findOneAndUpdate(
      { organization: organization._id },
      { $setOnInsert: { currentPlan: "free", status: "active" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ), session);
  }

  return initializeSubscription(subscription, organization, { session, now });
}

export async function synchronizeOrganizationSubscription(organization, { session = null, now = new Date() } = {}) {
  if (!organization) throw Object.assign(new Error("Компания не найдена"), { statusCode: 404 });
  if (!session) {
    const ownedSession = await mongoose.startSession();
    let result;
    try {
      await ownedSession.withTransaction(async () => {
        const freshOrganization = await Organization.findById(organization._id).session(ownedSession);
        result = await synchronizeOrganizationSubscription(freshOrganization, { session: ownedSession, now });
      });
    } finally {
      await ownedSession.endSession();
    }
    result.subscription.$session(null);
    result.currentPeriod.$session(null);
    organization.plan = result.currentPeriod.plan;
    organization.planExpiresAt = result.currentPeriod.endsAt;
    organization.planAssignedAt = result.currentPeriod.activatedAt || result.currentPeriod.startsAt;
    organization.planSource = result.currentPeriod.source === "payment"
      ? "billing"
      : result.currentPeriod.source === "manual" ? "manual" : "system";
    organization.planChangeReason = result.currentPeriod.note || "";
    return result;
  }

  const subscription = await ensureSubscription(organization, { session, now });
  let currentPeriod = subscription.currentPeriod
    ? await querySession(SubscriptionPeriod.findById(subscription.currentPeriod), session)
    : null;

  if (!currentPeriod) {
    currentPeriod = await createPeriod({
      subscription: subscription._id,
      organization: organization._id,
      plan: "free",
      status: "active",
      startsAt: now,
      activatedAt: now,
      source: "system",
      transitionType: "fallback"
    }, session);
    subscription.currentPeriod = currentPeriod._id;
  }

  if (currentPeriod.endsAt && currentPeriod.endsAt <= now) {
    currentPeriod.status = "expired";
    currentPeriod.endedAt = currentPeriod.endsAt;
    currentPeriod.endReason = "period_ended";
    await currentPeriod.save(session ? { session } : undefined);
    await recordEvent({
      type: "SubscriptionPeriodExpired",
      aggregateType: "subscription",
      aggregateId: subscription._id,
      organizationId: organization._id,
      actorType: "system",
      idempotencyKey: `subscription:${subscription._id}:expired:${currentPeriod._id}`,
      payload: { periodId: currentPeriod._id, plan: currentPeriod.plan, endedAt: currentPeriod.endsAt },
      session
    });

    let nextPeriod = subscription.scheduledPeriod
      ? await querySession(SubscriptionPeriod.findById(subscription.scheduledPeriod), session)
      : null;

    if (nextPeriod && nextPeriod.status === "scheduled" && nextPeriod.startsAt <= now) {
      nextPeriod.status = "active";
      nextPeriod.activatedAt = now;
      await nextPeriod.save(session ? { session } : undefined);
      subscription.scheduledPeriod = undefined;
      await recordEvent({
        type: "SubscriptionPeriodActivated",
        aggregateType: "subscription",
        aggregateId: subscription._id,
        organizationId: organization._id,
        actorType: "system",
        idempotencyKey: `subscription:${subscription._id}:activated:${nextPeriod._id}`,
        payload: { periodId: nextPeriod._id, plan: nextPeriod.plan, startsAt: nextPeriod.startsAt, endsAt: nextPeriod.endsAt },
        session
      });
    } else {
      const scheduledFuture = nextPeriod?.status === "scheduled" ? nextPeriod : null;
      nextPeriod = await createPeriod({
        subscription: subscription._id,
        organization: organization._id,
        plan: "free",
        status: "active",
        startsAt: currentPeriod.endsAt,
        endsAt: scheduledFuture?.startsAt,
        activatedAt: now,
        source: "system",
        transitionType: "fallback",
        previousPeriod: currentPeriod._id,
        note: "Автоматический переход после окончания тарифа"
      }, session);
      subscription.scheduledPeriod = scheduledFuture?._id;
      await recordEvent({
        type: "SubscriptionFellBackToFree",
        aggregateType: "subscription",
        aggregateId: subscription._id,
        organizationId: organization._id,
        actorType: "system",
        idempotencyKey: `subscription:${subscription._id}:fallback:${currentPeriod._id}`,
        payload: {
          expiredPeriodId: currentPeriod._id,
          scheduledPeriodId: scheduledFuture?._id
        },
        session
      });
    }

    subscription.currentPeriod = nextPeriod._id;
    subscription.currentPlan = nextPeriod.plan;
    subscription.revision += 1;
    currentPeriod = nextPeriod;
    await subscription.save(session ? { session } : undefined);
  }

  if (currentPeriod.endsAt && currentPeriod.endsAt <= now) {
    return synchronizeOrganizationSubscription(organization, { session, now });
  }

  await mirrorOrganization(organization, subscription, currentPeriod, { session });
  return { subscription, currentPeriod };
}

export async function subscriptionPayload(organization, { synchronize = true } = {}) {
  const synchronization = synchronize
    ? await synchronizeOrganizationSubscription(organization)
    : {
        subscription: await Subscription.findOne({ organization: organization._id }),
        currentPeriod: null
      };
  const { subscription } = synchronization;
  const currentPeriod = synchronization.currentPeriod
    || (subscription.currentPeriod ? await SubscriptionPeriod.findById(subscription.currentPeriod) : null);
  await expireStaleOpenOrders(organization._id, new Date());
  const [scheduledPeriod, periods, orders, events] = await Promise.all([
    subscription.scheduledPeriod ? SubscriptionPeriod.findById(subscription.scheduledPeriod).lean() : null,
    SubscriptionPeriod.find({ subscription: subscription._id }).sort({ startsAt: -1 }).limit(20).lean(),
    PaymentOrder.find({ organization: organization._id }).sort({ createdAt: -1 }).limit(10).lean(),
    BillingEvent.find({ organization: organization._id }).sort({ occurredAt: -1 }).limit(30).lean()
  ]);

  return {
    subscription: {
      _id: subscription._id,
      status: subscription.status,
      currentPlan: subscription.currentPlan,
      currentPeriod,
      scheduledPeriod
    },
    paymentOrders: orders,
    activePaymentOrder: orders.find((order) => order.isOpen) || null,
    subscriptionPeriods: periods,
    billingEvents: events
  };
}

async function expireStaleOpenOrders(organizationId, now, session) {
  let order;
  do {
    order = await querySession(PaymentOrder.findOneAndUpdate(
      { organization: organizationId, isOpen: true, expiresAt: { $lte: now } },
      {
        $set: {
          status: "expired",
          isOpen: false,
          "payment.status": "expired"
        }
      },
      { new: true }
    ), session);
    if (!order) break;
    await recordEvent({
      type: "PaymentOrderExpired",
      aggregateType: "payment_order",
      aggregateId: order._id,
      organizationId,
      actorType: "system",
      correlationId: order._id,
      idempotencyKey: `order:${order._id}:expired`,
      payload: { expiresAt: order.expiresAt },
      session
    });
  } while (order);
}

export async function createMockPaymentOrder({ organization, userId, targetPlan, periodMonths, idempotencyKey }) {
  const plan = PLANS[targetPlan];
  if (!plan || targetPlan === "free") throw Object.assign(new Error("Выберите платный тариф"), { statusCode: 400 });
  if (![1, 3, 6, 12].includes(periodMonths)) throw Object.assign(new Error("Выберите срок тарифа: 1, 3, 6 или 12 месяцев"), { statusCode: 400 });
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 120) {
    throw Object.assign(new Error("Некорректный ключ операции"), { statusCode: 400 });
  }

  const existing = await PaymentOrder.findOne({
    organization: organization._id,
    requestedBy: userId,
    idempotencyKey
  });
  if (existing) return existing;

  const session = await mongoose.startSession();
  let order;
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      const freshOrganization = await Organization.findById(organization._id).session(session);
      if (!freshOrganization) throw Object.assign(new Error("Компания не найдена"), { statusCode: 404 });
      const idempotentOrder = await PaymentOrder.findOne({
        organization: freshOrganization._id,
        requestedBy: userId,
        idempotencyKey
      }).session(session);
      if (idempotentOrder) {
        order = idempotentOrder;
        return;
      }
      const { subscription, currentPeriod } = await synchronizeOrganizationSubscription(freshOrganization, { session, now });
      await expireStaleOpenOrders(freshOrganization._id, now, session);
      const openOrder = await PaymentOrder.findOne({ organization: freshOrganization._id, isOpen: true }).session(session);
      if (openOrder) {
        throw Object.assign(new Error("По этой компании уже ожидается оплата"), {
          statusCode: 409,
          paymentOrder: openOrder
        });
      }
      if (subscription.scheduledPeriod) {
        throw Object.assign(new Error("Для компании уже запланирован следующий тарифный период"), { statusCode: 409 });
      }
      if (currentPeriod.plan === targetPlan && !currentPeriod.endsAt) {
        throw Object.assign(new Error("Текущий тариф уже действует без ограничения срока"), { statusCode: 409 });
      }

      const providerPaymentId = `mock_${crypto.randomUUID()}`;
      const expiresAt = new Date(now.getTime() + OPEN_ORDER_TTL_MS);
      const [created] = await PaymentOrder.create([{
        organization: freshOrganization._id,
        requestedBy: userId,
        targetPlan,
        planVersion: plan.version,
        planName: plan.name,
        periodMonths,
        transitionType: transitionFor(currentPeriod.plan, targetPlan),
        amountKopecks: plan.monthlyPriceKopecks * periodMonths,
        currency: "RUB",
        priceSnapshot: {
          plan: plan.key,
          version: plan.version,
          name: plan.name,
          monthlyPriceKopecks: plan.monthlyPriceKopecks,
          periodMonths
        },
        idempotencyKey,
        expiresAt,
        payment: {
          provider: "mock",
          status: "pending",
          providerPaymentId,
          expiresAt
        }
      }], { session });
      order = created;

      await recordEvent({
        type: "PaymentOrderCreated",
        aggregateType: "payment_order",
        aggregateId: order._id,
        organizationId: freshOrganization._id,
        actorType: "user",
        actorId: userId,
        correlationId: order._id,
        idempotencyKey: `order:${order._id}:created`,
        payload: {
          targetPlan,
          periodMonths,
          transitionType: order.transitionType,
          amountKopecks: order.amountKopecks,
          provider: "mock"
        },
        session
      });
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    order = await PaymentOrder.findOne({
      organization: organization._id,
      requestedBy: userId,
      idempotencyKey
    });
    if (!order) {
      throw Object.assign(new Error("По этой компании уже ожидается оплата"), { statusCode: 409 });
    }
  } finally {
    await session.endSession();
  }
  order.$session(null);
  return order;
}

async function endCurrentPeriod(currentPeriod, status, now, reason, session) {
  currentPeriod.status = status;
  currentPeriod.endsAt = now;
  currentPeriod.endedAt = now;
  currentPeriod.endReason = reason;
  await currentPeriod.save({ session });
}

export async function fulfillPaidOrder({
  organizationId,
  orderId,
  requestedByUserId = null,
  expectedProvider = null
}) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const now = new Date();
      const order = await PaymentOrder.findOne({ _id: orderId, organization: organizationId }).session(session);
      if (!order) throw Object.assign(new Error("Платёж не найден"), { statusCode: 404 });
      if (expectedProvider && order.payment.provider !== expectedProvider) {
        throw Object.assign(new Error("Платёж создан другим провайдером"), { statusCode: 409 });
      }
      if (requestedByUserId && order.requestedBy.toString() !== requestedByUserId.toString()) {
        throw Object.assign(new Error("Подтвердить оплату может пользователь, создавший её"), { statusCode: 403 });
      }
      if (order.status === "paid") {
        result = { order, repeated: true };
        return;
      }
      if (!order.isOpen || order.status !== "awaiting_payment") {
        throw Object.assign(new Error("Этот платёж уже завершён"), { statusCode: 409 });
      }
      if (order.expiresAt <= now) {
        order.status = "expired";
        order.isOpen = false;
        order.payment.status = "expired";
        await order.save({ session });
        await recordEvent({
          type: "PaymentOrderExpired",
          aggregateType: "payment_order",
          aggregateId: order._id,
          organizationId,
          actorType: "system",
          correlationId: order._id,
          idempotencyKey: `order:${order._id}:expired`,
          payload: { expiresAt: order.expiresAt },
          session
        });
        result = { order, expired: true };
        return;
      }
      const organization = await Organization.findById(organizationId).session(session);
      if (!organization) throw Object.assign(new Error("Компания не найдена"), { statusCode: 404 });
      const { subscription, currentPeriod } = await synchronizeOrganizationSubscription(organization, { session, now });
      const plan = PLANS[order.targetPlan];
      let nextPeriod;
      order.transitionType = transitionFor(currentPeriod.plan, order.targetPlan);

      if (order.transitionType === "renew" && currentPeriod.plan === order.targetPlan && currentPeriod.endsAt) {
        const startsAt = currentPeriod.endsAt;
        nextPeriod = await createPeriod({
          subscription: subscription._id,
          organization: organization._id,
          plan: order.targetPlan,
          planVersion: order.planVersion,
          status: "scheduled",
          startsAt,
          endsAt: addCalendarMonths(startsAt, order.periodMonths),
          source: "payment",
          sourceOrder: order._id,
          previousPeriod: currentPeriod._id,
          transitionType: "renew",
          createdBy: order.requestedBy,
          note: `Продление тарифа ${plan.name}`
        }, session);
        subscription.scheduledPeriod = nextPeriod._id;
      } else if (order.transitionType === "downgrade" && currentPeriod.plan !== "free" && currentPeriod.endsAt) {
        nextPeriod = await createPeriod({
          subscription: subscription._id,
          organization: organization._id,
          plan: order.targetPlan,
          planVersion: order.planVersion,
          status: "scheduled",
          startsAt: currentPeriod.endsAt,
          endsAt: addCalendarMonths(currentPeriod.endsAt, order.periodMonths),
          source: "payment",
          sourceOrder: order._id,
          previousPeriod: currentPeriod._id,
          transitionType: "downgrade",
          createdBy: order.requestedBy,
          note: `Запланирован переход на тариф ${plan.name}`
        }, session);
        subscription.scheduledPeriod = nextPeriod._id;
      } else {
        const transitionType = order.transitionType;
        await endCurrentPeriod(currentPeriod, "superseded", now, `payment_${transitionType}`, session);
        nextPeriod = await createPeriod({
          subscription: subscription._id,
          organization: organization._id,
          plan: order.targetPlan,
          planVersion: order.planVersion,
          status: "active",
          startsAt: now,
          endsAt: addCalendarMonths(now, order.periodMonths),
          activatedAt: now,
          source: "payment",
          sourceOrder: order._id,
          previousPeriod: currentPeriod._id,
          transitionType,
          createdBy: order.requestedBy,
          note: `Оплата тарифа ${plan.name}`
        }, session);
        subscription.currentPeriod = nextPeriod._id;
        subscription.currentPlan = nextPeriod.plan;
      }

      subscription.revision += 1;
      await subscription.save({ session });
      const effectivePeriod = order.transitionType === "downgrade" ? currentPeriod : order.transitionType === "renew" ? currentPeriod : nextPeriod;
      await mirrorOrganization(organization, subscription, effectivePeriod, { session });

      order.status = "paid";
      order.isOpen = false;
      order.paidAt = now;
      order.payment.status = "succeeded";
      order.payment.succeededAt = now;
      await order.save({ session });

      await recordEvent({
        type: "PaymentSucceeded",
        aggregateType: "payment_order",
        aggregateId: order._id,
        organizationId: organization._id,
        actorType: "provider",
        actorId: order.payment.provider,
        correlationId: order._id,
        causationId: order.payment.providerPaymentId,
        idempotencyKey: `payment:${order.payment.providerPaymentId}:succeeded`,
        payload: { amountKopecks: order.amountKopecks, currency: order.currency },
        session
      });
      await recordEvent({
        type: order.transitionType === "renew"
          ? "SubscriptionRenewed"
          : order.transitionType === "downgrade" && nextPeriod.status === "scheduled"
            ? "SubscriptionDowngradeScheduled"
            : order.transitionType === "upgrade"
              ? "SubscriptionUpgraded"
              : "SubscriptionPeriodActivated",
        aggregateType: "subscription",
        aggregateId: subscription._id,
        organizationId: organization._id,
        actorType: "provider",
        actorId: order.payment.provider,
        correlationId: order._id,
        causationId: order.payment.providerPaymentId,
        idempotencyKey: `subscription:${subscription._id}:order:${order._id}`,
        payload: {
          orderId: order._id,
          periodId: nextPeriod._id,
          plan: nextPeriod.plan,
          startsAt: nextPeriod.startsAt,
          endsAt: nextPeriod.endsAt
        },
        session
      });
      result = { order, subscription, period: nextPeriod, repeated: false };
    });
  } finally {
    await session.endSession();
  }
  if (result?.expired) {
    throw Object.assign(new Error("Время оплаты истекло. Создайте новый платёж"), { statusCode: 409 });
  }
  result.order.$session(null);
  return result;
}

export function confirmMockPayment({ organizationId, orderId }) {
  return fulfillPaidOrder({
    organizationId,
    orderId,
    expectedProvider: "mock"
  });
}

export async function cancelMockPayment({ organizationId, orderId, userId }) {
  const now = new Date();
  const order = await PaymentOrder.findOneAndUpdate(
    { _id: orderId, organization: organizationId, isOpen: true },
    {
      $set: {
        status: "cancelled",
        isOpen: false,
        cancelledAt: now,
        "payment.status": "cancelled"
      }
    },
    { new: true }
  );
  if (!order) throw Object.assign(new Error("Активный платёж не найден"), { statusCode: 404 });
  await recordEvent({
    type: "PaymentOrderCancelled",
    aggregateType: "payment_order",
    aggregateId: order._id,
    organizationId,
    actorType: "user",
    actorId: userId,
    correlationId: order._id,
    idempotencyKey: `order:${order._id}:cancelled`
  });
  return order;
}

export async function applyManualSubscriptionChange({ organization, plan, expiresAt, actorId, note = "" }) {
  if (!PLANS[plan]) throw Object.assign(new Error("Неизвестный тариф"), { statusCode: 400 });
  const now = new Date();
  const parsedExpiresAt = expiresAt ? new Date(expiresAt) : undefined;
  if (parsedExpiresAt && Number.isNaN(parsedExpiresAt.getTime())) {
    throw Object.assign(new Error("Некорректная дата окончания тарифа"), { statusCode: 400 });
  }

  const session = await mongoose.startSession();
  let period;
  try {
    await session.withTransaction(async () => {
      const freshOrganization = await Organization.findById(organization._id).session(session);
      if (!freshOrganization) throw Object.assign(new Error("Компания не найдена"), { statusCode: 404 });
      const { subscription, currentPeriod } = await synchronizeOrganizationSubscription(freshOrganization, { session, now });
      const scheduledPeriod = subscription.scheduledPeriod
        ? await SubscriptionPeriod.findById(subscription.scheduledPeriod).session(session)
        : null;
      if (scheduledPeriod?.status === "scheduled") {
        scheduledPeriod.status = "cancelled";
        scheduledPeriod.endedAt = now;
        scheduledPeriod.endReason = "manual_change";
        await scheduledPeriod.save({ session });
        await recordEvent({
          type: "SubscriptionScheduledPeriodCancelled",
          aggregateType: "subscription",
          aggregateId: subscription._id,
          organizationId: freshOrganization._id,
          actorType: "admin",
          actorId,
          idempotencyKey: `manual:${subscription._id}:cancelled:${scheduledPeriod._id}`,
          payload: { periodId: scheduledPeriod._id, plan: scheduledPeriod.plan },
          session
        });
      }
      await endCurrentPeriod(currentPeriod, "superseded", now, "manual_change", session);
      period = await createPeriod({
        subscription: subscription._id,
        organization: freshOrganization._id,
        plan,
        status: "active",
        startsAt: now,
        endsAt: plan === "free" ? undefined : parsedExpiresAt,
        activatedAt: now,
        source: "manual",
        previousPeriod: currentPeriod._id,
        transitionType: "manual",
        createdBy: actorId,
        note
      }, session);
      subscription.currentPeriod = period._id;
      subscription.currentPlan = plan;
      subscription.scheduledPeriod = undefined;
      subscription.revision += 1;
      await subscription.save({ session });
      await mirrorOrganization(freshOrganization, subscription, period, { session });
      await recordEvent({
        type: "SubscriptionPlanManuallyChanged",
        aggregateType: "subscription",
        aggregateId: subscription._id,
        organizationId: freshOrganization._id,
        actorType: "admin",
        actorId,
        idempotencyKey: `manual:${subscription._id}:${period._id}`,
        payload: { plan, startsAt: period.startsAt, endsAt: period.endsAt, note },
        session
      });
    });
  } finally {
    await session.endSession();
  }
  period.$session(null);
  if (period.endsAt && period.endsAt <= now) {
    const refreshedOrganization = await Organization.findById(organization._id);
    if (refreshedOrganization) await synchronizeOrganizationSubscription(refreshedOrganization, { now });
  }
  return period;
}

export async function synchronizeExpiredSubscriptions(now = new Date()) {
  const expiredPeriods = await SubscriptionPeriod.find({
    status: "active",
    endsAt: { $lte: now }
  }).select("_id").sort({ endsAt: 1 }).limit(100).lean();
  const subscriptions = await Subscription.find({
    currentPeriod: { $in: expiredPeriods.map((period) => period._id) }
  }).select("organization").lean();

  for (const subscription of subscriptions) {
    const organization = await Organization.findById(subscription.organization);
    if (!organization) continue;
    try {
      await synchronizeOrganizationSubscription(organization, { now });
    } catch (error) {
      if (error.code !== 11000 && error.name !== "VersionError") throw error;
    }
  }
}

export async function expireOpenPaymentOrders(now = new Date()) {
  const organizationIds = await PaymentOrder.find({
    isOpen: true,
    expiresAt: { $lte: now }
  }).distinct("organization");

  for (const organizationId of organizationIds.slice(0, 100)) {
    await expireStaleOpenOrders(organizationId, now);
  }
}
