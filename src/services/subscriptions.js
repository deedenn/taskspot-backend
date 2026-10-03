import crypto from "node:crypto";
import mongoose from "mongoose";
import { BillingEvent } from "../models/BillingEvent.js";
import { Organization } from "../models/Organization.js";
import { PaymentOrder } from "../models/PaymentOrder.js";
import { PaymentRefund } from "../models/PaymentRefund.js";
import { Subscription } from "../models/Subscription.js";
import { SubscriptionPeriod } from "../models/SubscriptionPeriod.js";
import { User } from "../models/User.js";
import { activeBillingProvider, billingIntegrationPayload, providerFor } from "./billingProviders.js";
import {
  createRefundReceipt,
  createSaleReceipt,
  getReceiptStatus,
  receiptIdForOrder,
  receiptIdForRefund
} from "./digitalKassa.js";
import { PLANS } from "./planCatalog.js";
import {
  createDynamicQr,
  expectedMerchantId,
  getRefundStatus,
  getQrPaymentStatuses,
  normalizeIncomingPayment,
  rublesToKopecks,
  startRefund
} from "./tochkaSbp.js";

const OPEN_ORDER_TTL_MS = 30 * 60 * 1000;
const QR_CREATION_LOCK_MS = 30 * 1000;

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

async function initializeSubscription(subscription, organization, {
  session = null,
  now = new Date(),
  initialSource = "migration",
  initialNote = ""
} = {}) {
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
      source: initialSource,
      transitionType: "initial",
      note: initialNote || organization.planChangeReason || (initialSource === "system"
        ? "Тариф Free назначен при регистрации"
        : "Перенесено из текущего тарифа организации")
    }, session);
  }

  subscription.currentPeriod = currentPeriod._id;
  subscription.currentPlan = currentPeriod.plan;
  await subscription.save(session ? { session } : undefined);
  await mirrorOrganization(organization, subscription, currentPeriod, { session });
  return subscription;
}

export async function ensureSubscription(organization, {
  session = null,
  now = new Date(),
  initialSource = "migration",
  initialNote = ""
} = {}) {
  let subscription = await querySession(Subscription.findOne({ organization: organization._id }), session);
  if (subscription?.currentPeriod) return subscription;

  if (!subscription) {
    subscription = await querySession(Subscription.findOneAndUpdate(
      { organization: organization._id },
      { $setOnInsert: { currentPlan: "free", status: "active" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ), session);
  }

  return initializeSubscription(subscription, organization, { session, now, initialSource, initialNote });
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

async function createPaymentOrderRecord({
  organization,
  userId,
  targetPlan,
  periodMonths,
  idempotencyKey,
  receiptEmail = "",
  provider = "mock"
}) {
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

      const providerPaymentId = `${provider}_creating_${crypto.randomUUID()}`;
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
        receiptEmail: typeof receiptEmail === "string" ? receiptEmail.trim().toLowerCase() : "",
        expiresAt,
        payment: {
          provider,
          status: provider === "mock" ? "pending" : "creating",
          providerPaymentId,
          expiresAt
        }
      }], { session });
      order = created;
      order.$locals.paymentOrderCreated = true;

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
          provider
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

export function createMockPaymentOrder(values) {
  return createPaymentOrderRecord({ ...values, provider: "mock" });
}

function retryableQrCreationError(error) {
  return ["TOCHKA_NETWORK_ERROR", "TOCHKA_TIMEOUT", "TOCHKA_INVALID_RESPONSE"].includes(error?.code)
    || Number(error?.providerStatus) >= 500
    || Number(error?.providerStatus) === 424;
}

async function initializeTochkaPaymentOrder(orderOrId) {
  const orderId = orderOrId?._id || orderOrId;
  const now = new Date();
  const lockId = crypto.randomUUID();
  const lockedUntil = new Date(now.getTime() + QR_CREATION_LOCK_MS);
  const claimed = await PaymentOrder.findOneAndUpdate(
    {
      _id: orderId,
      status: "awaiting_payment",
      isOpen: true,
      "payment.provider": "tochka_sbp",
      "payment.status": "creating",
      "payment.creationAttempts": 0,
      $or: [
        { "payment.creationLockedUntil": { $exists: false } },
        { "payment.creationLockedUntil": { $lte: now } }
      ]
    },
    {
      $set: {
        "payment.status": "creating",
        "payment.creationLockId": lockId,
        "payment.creationLockedUntil": lockedUntil,
        "payment.creationLastAttemptAt": now,
        "payment.lastCheckedAt": now,
        "payment.creationErrorCode": "",
        "payment.creationErrorMessage": ""
      },
      $inc: { "payment.creationAttempts": 1 }
    },
    { new: true }
  );
  if (!claimed) {
    await PaymentOrder.updateOne(
      {
        _id: orderId,
        status: "awaiting_payment",
        "payment.provider": "tochka_sbp",
        "payment.status": "creating",
        "payment.creationAttempts": { $gt: 0 },
        "payment.creationLockedUntil": { $lte: now }
      },
      {
        $set: {
          "payment.status": "creation_unknown",
          "payment.creationErrorCode": "TOCHKA_CREATION_RESULT_UNKNOWN",
          "payment.creationErrorMessage": "Результат создания QR неизвестен; повторный запрос заблокирован до истечения заказа"
        },
        $unset: {
          "payment.creationLockId": "",
          "payment.creationLockedUntil": ""
        }
      }
    );
    return PaymentOrder.findById(orderId);
  }

  try {
    const qr = await createDynamicQr({ order: claimed });
    const updatedOrder = await PaymentOrder.findOneAndUpdate(
      { _id: claimed._id, "payment.creationLockId": lockId },
      {
        $set: {
          "payment.status": "pending",
          "payment.providerPaymentId": qr.qrcId,
          "payment.qrPayload": qr.qrPayload,
          "payment.paymentUrl": qr.paymentUrl,
          "payment.qrImage": qr.qrImage,
          "payment.creationErrorCode": "",
          "payment.creationErrorMessage": ""
        },
        $unset: {
          "payment.creationLockId": "",
          "payment.creationLockedUntil": ""
        }
      },
      { new: true }
    );
    if (!updatedOrder) return PaymentOrder.findById(claimed._id);
    try {
      await recordEvent({
        type: "PaymentQrCreated",
        aggregateType: "payment_order",
        aggregateId: updatedOrder._id,
        organizationId: updatedOrder.organization,
        actorType: "provider",
        actorId: "tochka_sbp",
        correlationId: updatedOrder._id,
        causationId: qr.qrcId,
        idempotencyKey: `order:${updatedOrder._id}:qr-created`,
        payload: { provider: "tochka_sbp", expiresAt: updatedOrder.expiresAt }
      });
    } catch (eventError) {
      if (eventError.code !== 11000) {
        console.error("[taskspot:billing-event]", { orderId: String(updatedOrder._id), code: eventError.code || eventError.name });
      }
    }
    return updatedOrder;
  } catch (error) {
    const retryable = retryableQrCreationError(error);
    await PaymentOrder.updateOne(
      { _id: claimed._id, "payment.creationLockId": lockId },
      {
        $set: {
          ...(retryable ? {} : { status: "failed", isOpen: false }),
          "payment.status": retryable ? "creation_unknown" : "failed",
          "payment.creationErrorCode": error.code || error.name,
          "payment.creationErrorMessage": error.message
        },
        $unset: {
          "payment.creationLockId": "",
          "payment.creationLockedUntil": ""
        }
      }
    );
    try {
      await recordEvent({
        type: retryable ? "PaymentQrCreationDeferred" : "PaymentInitializationFailed",
        aggregateType: "payment_order",
        aggregateId: claimed._id,
        organizationId: claimed.organization,
        actorType: "provider",
        actorId: "tochka_sbp",
        correlationId: claimed._id,
        idempotencyKey: `order:${claimed._id}:${retryable ? "qr-deferred" : "initialization-failed"}`,
        payload: { code: error.code || error.name }
      });
    } catch (eventError) {
      if (eventError.code !== 11000) {
        console.error("[taskspot:billing-event]", { orderId: String(claimed._id), code: eventError.code || eventError.name });
      }
    }
    if (retryable) return PaymentOrder.findById(claimed._id);
    throw error;
  }
}

export async function createPaymentOrder(values) {
  const provider = activeBillingProvider();
  const integration = billingIntegrationPayload();
  if (!provider.ready || !["mock", "tochka_sbp"].includes(provider.key) || !integration.ready) {
    throw Object.assign(new Error("Платёжный провайдер временно недоступен"), { statusCode: 503 });
  }
  if (provider.key === "mock") return createMockPaymentOrder(values);

  const order = await createPaymentOrderRecord({ ...values, provider: provider.key });
  if (order.payment.status !== "creating" || order.payment.creationAttempts > 0) return order;
  return initializeTochkaPaymentOrder(order);
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
  expectedProvider = null,
  providerConfirmed = false,
  paidAt = null,
  operationId = "",
  refTransactionId = "",
  paymentRail = "sbp"
}) {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const parsedPaidAt = paidAt ? new Date(paidAt) : new Date();
      const now = Number.isNaN(parsedPaidAt.getTime()) ? new Date() : parsedPaidAt;
      const order = await PaymentOrder.findOne({ _id: orderId, organization: organizationId }).session(session);
      if (!order) throw Object.assign(new Error("Платёж не найден"), { statusCode: 404 });
      if (expectedProvider && order.payment.provider !== expectedProvider) {
        throw Object.assign(new Error("Платёж создан другим провайдером"), { statusCode: 409 });
      }
      if (requestedByUserId && order.requestedBy.toString() !== requestedByUserId.toString()) {
        throw Object.assign(new Error("Подтвердить оплату может пользователь, создавший её"), { statusCode: 403 });
      }
      if (["paid", "partially_refunded", "refunded"].includes(order.status)) {
        result = { order, repeated: true };
        return;
      }
      const mayRestoreProviderPayment = providerConfirmed
        && order.payment.provider !== "mock"
        && ["expired", "cancelled", "failed"].includes(order.status);
      if ((!order.isOpen || order.status !== "awaiting_payment") && !mayRestoreProviderPayment) {
        throw Object.assign(new Error("Этот платёж уже завершён"), { statusCode: 409 });
      }
      if (order.expiresAt <= now && !providerConfirmed) {
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
      order.payment.operationId = operationId || order.payment.operationId;
      order.payment.refTransactionId = refTransactionId || order.payment.refTransactionId;
      order.payment.rail = paymentRail;
      if (order.payment.provider !== "mock") {
        order.fiscalization.status = "pending";
        order.fiscalization.receiptId = order.fiscalization.receiptId || receiptIdForOrder(order._id);
        order.fiscalization.errorCode = "";
        order.fiscalization.errorMessage = "";
      }
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
    { _id: orderId, organization: organizationId, isOpen: true, "payment.provider": "mock" },
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

export async function handleTochkaPaymentWebhook(payload) {
  const payment = normalizeIncomingPayment(payload);
  if (payment.webhookType !== "incomingSbpPayment" || !["sbpPayment", "drPayment"].includes(payment.paymentType)) {
    return { handled: false, reason: "unsupported_event" };
  }
  if (!payment.qrcId || !payment.operationId) {
    return { handled: false, reason: "incomplete_event" };
  }
  if (!payment.merchantId || payment.merchantId !== expectedMerchantId()) {
    return { handled: false, reason: "merchant_mismatch" };
  }

  let order = await PaymentOrder.findOne({
    "payment.provider": "tochka_sbp",
    "payment.providerPaymentId": payment.qrcId
  });
  let recoveredFromPurpose = false;
  if (!order) {
    const orderId = payment.purpose.match(/Заказ\s+([a-f\d]{24})(?:\.|\s|$)/i)?.[1];
    if (orderId) {
      order = await PaymentOrder.findOne({
        _id: orderId,
        "payment.provider": "tochka_sbp",
        status: "awaiting_payment",
        "payment.status": { $in: ["creating", "creation_unknown"] }
      });
      recoveredFromPurpose = Boolean(order);
    }
  }
  if (!order) return { handled: false, reason: "order_not_found" };

  const amountKopecks = rublesToKopecks(payment.amountRubles);
  if (amountKopecks !== order.amountKopecks) {
    try {
      await recordEvent({
        type: "PaymentWebhookRejected",
        aggregateType: "payment_order",
        aggregateId: order._id,
        organizationId: order.organization,
        actorType: "provider",
        actorId: "tochka_sbp",
        correlationId: order._id,
        causationId: payment.operationId,
        idempotencyKey: `payment:${payment.operationId}:amount-mismatch`,
        payload: { expectedAmountKopecks: order.amountKopecks, receivedAmountKopecks: amountKopecks }
      });
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
    return { handled: false, reason: "amount_mismatch" };
  }

  if (recoveredFromPurpose) {
    order = await PaymentOrder.findOneAndUpdate(
      {
        _id: order._id,
        status: "awaiting_payment",
        "payment.status": { $in: ["creating", "creation_unknown"] }
      },
      {
        $set: {
          "payment.providerPaymentId": payment.qrcId,
          "payment.status": "pending",
          "payment.creationErrorCode": "",
          "payment.creationErrorMessage": ""
        },
        $unset: {
          "payment.creationLockId": "",
          "payment.creationLockedUntil": ""
        }
      },
      { new: true }
    );
    if (!order) return { handled: false, reason: "order_recovery_conflict" };
  }

  const duplicateOperation = await PaymentOrder.findOne({
    _id: { $ne: order._id },
    "payment.operationId": payment.operationId
  }).select("_id").lean();
  if (duplicateOperation) return { handled: false, reason: "duplicate_operation" };

  const result = await fulfillPaidOrder({
    organizationId: order.organization,
    orderId: order._id,
    expectedProvider: "tochka_sbp",
    providerConfirmed: true,
    operationId: payment.operationId,
    refTransactionId: payment.refTransactionId,
    paymentRail: payment.paymentType === "drPayment" ? "digital_ruble" : "sbp"
  });

  try {
    await fiscalizePaymentOrder(order._id);
  } catch (error) {
    console.error("[taskspot:fiscalization]", { orderId: String(order._id), code: error.code || error.name });
  }
  return { handled: true, repeated: result.repeated, orderId: order._id };
}

async function applyQrStatus(order, status) {
  await PaymentOrder.updateOne(
    { _id: order._id },
    { $set: { "payment.lastCheckedAt": new Date() } }
  );
  if (status.status === "Accepted" && status.operationId) {
    const result = await fulfillPaidOrder({
      organizationId: order.organization,
      orderId: order._id,
      expectedProvider: "tochka_sbp",
      providerConfirmed: true,
      operationId: status.operationId,
      paymentRail: status.operationId.length === 36 ? "digital_ruble" : "sbp"
    });
    try {
      await fiscalizePaymentOrder(order._id);
    } catch (error) {
      console.error("[taskspot:fiscalization]", { orderId: String(order._id), code: error.code || error.name });
    }
    return result.order;
  }
  if (status.status === "Rejected" && order.status === "awaiting_payment") {
    await PaymentOrder.updateOne(
      { _id: order._id, status: "awaiting_payment" },
      { $set: { status: "failed", isOpen: false, "payment.status": "failed" } }
    );
  }
  return PaymentOrder.findById(order._id);
}

export async function reconcileTochkaPaymentOrder(orderOrId) {
  const order = typeof orderOrId === "object" && orderOrId?._id
    ? orderOrId
    : await PaymentOrder.findById(orderOrId);
  if (!order || order.payment.provider !== "tochka_sbp" || ["paid", "partially_refunded", "refunded"].includes(order.status)) return order;
  if (order.payment.status === "creating") {
    return initializeTochkaPaymentOrder(order);
  }
  if (order.payment.status === "creation_unknown") return order;
  if (order.payment.status !== "pending" || order.payment.providerPaymentId.includes("_creating_")) return order;
  const [status] = await getQrPaymentStatuses(order.payment.providerPaymentId);
  if (!status || status.qrcId !== order.payment.providerPaymentId) {
    await PaymentOrder.updateOne({ _id: order._id }, { $set: { "payment.lastCheckedAt": new Date() } });
    return PaymentOrder.findById(order._id);
  }
  return applyQrStatus(order, status);
}

export async function reconcilePendingTochkaPayments(now = new Date()) {
  const createdAfter = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const checkedBefore = new Date(now.getTime() - 60 * 1000);
  const orders = await PaymentOrder.find({
    "payment.provider": "tochka_sbp",
    status: { $in: ["awaiting_payment", "expired"] },
    createdAt: { $gte: createdAfter },
    $or: [
      { "payment.lastCheckedAt": { $exists: false } },
      { "payment.lastCheckedAt": { $lte: checkedBefore } }
    ]
  }).limit(50);
  if (!orders.length) return;

  const qrCreationOrders = orders.filter((order) => ["creating", "creation_unknown"].includes(order.payment.status));
  for (const order of qrCreationOrders) {
    try {
      await initializeTochkaPaymentOrder(order);
    } catch (error) {
      console.error("[taskspot:payment-initialization]", { orderId: String(order._id), code: error.code || error.name });
    }
  }
  const payableOrders = orders.filter((order) => order.payment.status === "pending" && !order.payment.providerPaymentId.includes("_creating_"));
  if (!payableOrders.length) return;
  const statuses = await getQrPaymentStatuses(payableOrders.map((order) => order.payment.providerPaymentId));
  const statusByQr = new Map(statuses.map((status) => [status.qrcId, status]));
  for (const order of payableOrders) {
    const status = statusByQr.get(order.payment.providerPaymentId);
    if (status) await applyQrStatus(order, status);
    else await PaymentOrder.updateOne({ _id: order._id }, { $set: { "payment.lastCheckedAt": now } });
  }
}

export async function fiscalizePaymentOrder(orderId) {
  const order = await PaymentOrder.findById(orderId);
  if (!order || order.status !== "paid" || order.payment.provider === "mock") return null;
  if (order.fiscalization.status === "succeeded") return order;

  const fiscalProvider = providerFor("digitalkassa_sbp");
  if (!fiscalProvider.ready) {
    const error = Object.assign(new Error("DigitalKassa не настроена"), { code: "DIGITALKASSA_NOT_CONFIGURED" });
    order.fiscalization.status = "failed";
    order.fiscalization.attempts += 1;
    order.fiscalization.lastAttemptAt = new Date();
    order.fiscalization.errorCode = error.code;
    order.fiscalization.errorMessage = error.message;
    await order.save();
    throw error;
  }

  const user = order.receiptEmail ? null : await User.findById(order.requestedBy).select("email").lean();
  const receiptEmail = order.receiptEmail || user?.email || "";
  if (!receiptEmail) {
    const error = Object.assign(new Error("Не найден email покупателя для чека"), { code: "RECEIPT_EMAIL_MISSING" });
    order.fiscalization.status = "failed";
    order.fiscalization.attempts += 1;
    order.fiscalization.lastAttemptAt = new Date();
    order.fiscalization.errorCode = error.code;
    order.fiscalization.errorMessage = error.message;
    await order.save();
    throw error;
  }

  const previousStatus = order.fiscalization.status;
  const previousAttempts = order.fiscalization.attempts;
  order.fiscalization.status = "pending";
  order.fiscalization.receiptId = order.fiscalization.receiptId || receiptIdForOrder(order._id);
  order.fiscalization.attempts += 1;
  order.fiscalization.lastAttemptAt = new Date();
  await order.save();

  try {
    const result = previousStatus === "pending" && previousAttempts > 0
      ? await getReceiptStatus(order.fiscalization.receiptId)
      : await createSaleReceipt({ order, email: receiptEmail });
    order.fiscalization.status = result.succeeded ? "succeeded" : "pending";
    order.fiscalization.receiptUrl = result.receiptUrl || order.fiscalization.receiptUrl;
    order.fiscalization.errorCode = "";
    order.fiscalization.errorMessage = "";
    if (result.succeeded) order.fiscalization.completedAt = new Date();
    await order.save();

    if (result.succeeded) {
      try {
        await recordEvent({
          type: "FiscalReceiptIssued",
          aggregateType: "payment_order",
          aggregateId: order._id,
          organizationId: order.organization,
          actorType: "provider",
          actorId: "digitalkassa",
          correlationId: order._id,
          causationId: order.payment.operationId || order.payment.providerPaymentId,
          idempotencyKey: `order:${order._id}:receipt-issued`,
          payload: { receiptId: result.receiptId, receiptUrl: result.receiptUrl }
        });
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
    }
    return order;
  } catch (error) {
    order.fiscalization.status = "failed";
    order.fiscalization.errorCode = error.code || error.name;
    order.fiscalization.errorMessage = error.message;
    await order.save();
    throw error;
  }
}

export async function processPendingFiscalReceipts(now = new Date()) {
  const retryBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const orders = await PaymentOrder.find({
    status: { $in: ["paid", "partially_refunded", "refunded"] },
    "payment.provider": { $ne: "mock" },
    "fiscalization.status": { $in: ["pending", "failed"] },
    $or: [
      { "fiscalization.lastAttemptAt": { $exists: false } },
      { "fiscalization.lastAttemptAt": { $lte: retryBefore } }
    ]
  }).select("_id").limit(20).lean();

  for (const order of orders) {
    try {
      await fiscalizePaymentOrder(order._id);
    } catch (error) {
      console.error("[taskspot:fiscalization]", { orderId: String(order._id), code: error.code || error.name });
    }
  }
}

async function revokeFullyRefundedPeriod({ order, session, now }) {
  const period = await SubscriptionPeriod.findOne({ sourceOrder: order._id }).session(session);
  if (!period || !["active", "scheduled"].includes(period.status)) return;
  const subscription = await Subscription.findOne({ organization: order.organization }).session(session);
  if (!subscription) return;

  if (period.status === "scheduled") {
    period.status = "cancelled";
    period.endedAt = now;
    period.endReason = "payment_refunded";
    await period.save({ session });
    if (subscription.scheduledPeriod?.toString() === period._id.toString()) {
      subscription.scheduledPeriod = undefined;
      subscription.revision += 1;
      await subscription.save({ session });
    }
    return;
  }

  if (subscription.currentPeriod?.toString() !== period._id.toString()) return;
  period.status = "cancelled";
  period.endsAt = now;
  period.endedAt = now;
  period.endReason = "payment_refunded";
  await period.save({ session });
  const fallback = await createPeriod({
    subscription: subscription._id,
    organization: order.organization,
    plan: "free",
    status: "active",
    startsAt: now,
    activatedAt: now,
    source: "system",
    previousPeriod: period._id,
    transitionType: "fallback",
    note: "Переход на Free после полного возврата оплаты"
  }, session);
  subscription.currentPeriod = fallback._id;
  subscription.currentPlan = "free";
  subscription.revision += 1;
  await subscription.save({ session });
  const organization = await Organization.findById(order.organization).session(session);
  if (organization) await mirrorOrganization(organization, subscription, fallback, { session });
}

export async function finalizePaymentRefund(refundId, providerStatus = "Accepted") {
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const refund = await PaymentRefund.findById(refundId).session(session);
      if (!refund) throw Object.assign(new Error("Возврат не найден"), { statusCode: 404 });
      if (refund.status === "succeeded") {
        result = { refund, repeated: true };
        return;
      }
      const order = await PaymentOrder.findById(refund.paymentOrder).session(session);
      if (!order) throw Object.assign(new Error("Платёж возврата не найден"), { statusCode: 404 });
      const now = new Date();
      refund.status = "succeeded";
      refund.providerStatus = providerStatus;
      refund.completedAt = now;
      refund.errorCode = "";
      refund.errorMessage = "";
      refund.fiscalization.status = "pending";
      refund.fiscalization.receiptId = refund.fiscalization.receiptId || receiptIdForRefund(refund._id);
      await refund.save({ session });

      const totals = await PaymentRefund.aggregate([
        { $match: { paymentOrder: order._id, status: "succeeded" } },
        { $group: { _id: null, amount: { $sum: "$amountKopecks" } } }
      ]).session(session);
      const refundedAmountKopecks = Math.min(order.amountKopecks, totals[0]?.amount || refund.amountKopecks);
      const fullyRefunded = refundedAmountKopecks >= order.amountKopecks;
      order.refundedAmountKopecks = refundedAmountKopecks;
      order.status = fullyRefunded ? "refunded" : "partially_refunded";
      if (fullyRefunded) order.payment.status = "refunded";
      await order.save({ session });
      if (fullyRefunded) await revokeFullyRefundedPeriod({ order, session, now });

      await recordEvent({
        type: fullyRefunded ? "PaymentRefunded" : "PaymentPartiallyRefunded",
        aggregateType: "payment_order",
        aggregateId: order._id,
        organizationId: order.organization,
        actorType: "provider",
        actorId: "tochka_sbp",
        correlationId: order._id,
        causationId: refund.providerRequestId,
        idempotencyKey: `refund:${refund._id}:succeeded`,
        payload: { refundId: refund._id, amountKopecks: refund.amountKopecks, refundedAmountKopecks },
        session
      });
      result = { refund, order, fullyRefunded, repeated: false };
    });
  } finally {
    await session.endSession();
  }
  result.refund.$session(null);
  return result;
}

export async function fiscalizePaymentRefund(refundId) {
  const refund = await PaymentRefund.findById(refundId);
  if (!refund || refund.status !== "succeeded") return null;
  if (refund.fiscalization.status === "succeeded") return refund;
  const order = await PaymentOrder.findById(refund.paymentOrder);
  if (!order) throw Object.assign(new Error("Платёж возврата не найден"), { code: "REFUND_ORDER_MISSING" });
  const fiscalProvider = providerFor("digitalkassa_sbp");
  if (!fiscalProvider.ready) {
    const error = Object.assign(new Error("DigitalKassa не настроена"), { code: "DIGITALKASSA_NOT_CONFIGURED" });
    refund.fiscalization.status = "failed";
    refund.fiscalization.attempts += 1;
    refund.fiscalization.lastAttemptAt = new Date();
    refund.fiscalization.errorCode = error.code;
    refund.fiscalization.errorMessage = error.message;
    await refund.save();
    throw error;
  }
  const user = order.receiptEmail ? null : await User.findById(order.requestedBy).select("email").lean();
  const receiptEmail = order.receiptEmail || user?.email || "";
  if (!receiptEmail) {
    const error = Object.assign(new Error("Не найден email покупателя для чека возврата"), { code: "RECEIPT_EMAIL_MISSING" });
    refund.fiscalization.status = "failed";
    refund.fiscalization.attempts += 1;
    refund.fiscalization.lastAttemptAt = new Date();
    refund.fiscalization.errorCode = error.code;
    refund.fiscalization.errorMessage = error.message;
    await refund.save();
    throw error;
  }

  const previousStatus = refund.fiscalization.status;
  const previousAttempts = refund.fiscalization.attempts;
  refund.fiscalization.status = "pending";
  refund.fiscalization.receiptId = refund.fiscalization.receiptId || receiptIdForRefund(refund._id);
  refund.fiscalization.attempts += 1;
  refund.fiscalization.lastAttemptAt = new Date();
  await refund.save();
  try {
    const fiscalResult = previousStatus === "pending" && previousAttempts > 0
      ? await getReceiptStatus(refund.fiscalization.receiptId)
      : await createRefundReceipt({ order, refund, email: receiptEmail });
    refund.fiscalization.status = fiscalResult.succeeded ? "succeeded" : "pending";
    refund.fiscalization.receiptUrl = fiscalResult.receiptUrl || refund.fiscalization.receiptUrl;
    refund.fiscalization.errorCode = "";
    refund.fiscalization.errorMessage = "";
    if (fiscalResult.succeeded) refund.fiscalization.completedAt = new Date();
    await refund.save();
    return refund;
  } catch (error) {
    refund.fiscalization.status = "failed";
    refund.fiscalization.errorCode = error.code || error.name;
    refund.fiscalization.errorMessage = error.message;
    await refund.save();
    throw error;
  }
}

async function failPaymentRefund(refundId, {
  providerRequestId = "",
  providerStatus = "",
  errorCode = "",
  errorMessage = ""
} = {}) {
  const session = await mongoose.startSession();
  let refund;
  try {
    await session.withTransaction(async () => {
      refund = await PaymentRefund.findOneAndUpdate(
        { _id: refundId, status: { $in: ["creating", "pending", "unknown"] } },
        {
          $set: {
            status: "failed",
            ...(providerRequestId ? { providerRequestId } : {}),
            providerStatus,
            failedAt: new Date(),
            errorCode,
            errorMessage
          }
        },
        { new: true, session }
      );
      if (!refund) {
        refund = await PaymentRefund.findById(refundId).session(session);
        return;
      }
      await PaymentOrder.updateOne(
        { _id: refund.paymentOrder },
        { $inc: { refundReservedAmountKopecks: -refund.amountKopecks } },
        { session }
      );
    });
  } finally {
    await session.endSession();
  }
  refund?.$session(null);
  return refund;
}

export async function requestPaymentRefund({ orderId, amountKopecks, actorId, reason = "", idempotencyKey }) {
  if (typeof idempotencyKey !== "string" || idempotencyKey.length < 8 || idempotencyKey.length > 120) {
    throw Object.assign(new Error("Некорректный ключ операции возврата"), { statusCode: 400 });
  }
  const normalizedAmount = Number(amountKopecks);
  if (!Number.isInteger(normalizedAmount) || normalizedAmount <= 0) {
    throw Object.assign(new Error("Сумма возврата должна быть указана в копейках"), { statusCode: 400 });
  }
  const normalizedReason = typeof reason === "string" ? reason.trim() : "";
  if (normalizedReason.length < 3 || normalizedReason.length > 140) {
    throw Object.assign(new Error("Укажите основание возврата длиной от 3 до 140 символов"), { statusCode: 400 });
  }

  const existing = await PaymentRefund.findOne({ paymentOrder: orderId, idempotencyKey });
  if (existing) return existing;
  const session = await mongoose.startSession();
  let refund;
  let createdRefund = false;
  try {
    await session.withTransaction(async () => {
      const order = await PaymentOrder.findById(orderId).session(session);
      if (!order || !["paid", "partially_refunded"].includes(order.status)) {
        throw Object.assign(new Error("Возврат доступен только для оплаченного заказа"), { statusCode: 409 });
      }
      if (order.payment.provider !== "tochka_sbp" || order.payment.rail !== "sbp") {
        throw Object.assign(new Error("Автоматический возврат доступен только для платежей СБП Точки"), { statusCode: 409 });
      }
      const reservedOrder = await PaymentOrder.findOneAndUpdate(
        {
          _id: order._id,
          status: { $in: ["paid", "partially_refunded"] },
          $expr: {
            $lte: [
              { $add: [{ $ifNull: ["$refundReservedAmountKopecks", 0] }, normalizedAmount] },
              "$amountKopecks"
            ]
          }
        },
        { $inc: { refundReservedAmountKopecks: normalizedAmount } },
        { new: true, session }
      );
      if (!reservedOrder) {
        const remaining = Math.max(0, order.amountKopecks - (order.refundReservedAmountKopecks || 0));
        throw Object.assign(new Error(`Доступно к возврату: ${(remaining / 100).toFixed(2)} ₽`), { statusCode: 409 });
      }
      [refund] = await PaymentRefund.create([{
        organization: order.organization,
        paymentOrder: order._id,
        requestedBy: actorId,
        idempotencyKey,
        amountKopecks: normalizedAmount,
        reason: normalizedReason
      }], { session });
      createdRefund = true;
    });
  } catch (error) {
    if (error.code !== 11000) throw error;
    refund = await PaymentRefund.findOne({ paymentOrder: orderId, idempotencyKey });
    if (!refund) throw error;
  } finally {
    await session.endSession();
  }
  if (!createdRefund) return refund;

  const order = await PaymentOrder.findById(orderId);
  let providerResult;
  try {
    providerResult = await startRefund({ order, amountKopecks: normalizedAmount, reason: normalizedReason });
  } catch (error) {
    const unknown = ["TOCHKA_NETWORK_ERROR", "TOCHKA_TIMEOUT"].includes(error.code) || Number(error.providerStatus) >= 500;
    refund = unknown
      ? await PaymentRefund.findByIdAndUpdate(refund._id, {
          $set: {
            status: "unknown",
            errorCode: error.code || error.name,
            errorMessage: error.message
          }
        }, { new: true })
      : await failPaymentRefund(refund._id, {
          errorCode: error.code || error.name,
          errorMessage: error.message
        });
    return refund;
  }

  if (providerResult.status === "Rejected") {
    return failPaymentRefund(refund._id, {
      providerRequestId: providerResult.requestId,
      providerStatus: providerResult.status
    });
  }
  refund = await PaymentRefund.findByIdAndUpdate(refund._id, {
    $set: {
      providerRequestId: providerResult.requestId,
      providerStatus: providerResult.status,
      status: "pending"
    }
  }, { new: true });
  if (providerResult.status === "Accepted") {
    try {
      const finalized = await finalizePaymentRefund(refund._id, providerResult.status);
      refund = finalized.refund;
      try { await fiscalizePaymentRefund(refund._id); } catch (error) {
        console.error("[taskspot:refund-fiscalization]", { refundId: String(refund._id), code: error.code || error.name });
      }
    } catch (error) {
      refund = await PaymentRefund.findByIdAndUpdate(refund._id, {
        $set: { errorCode: error.code || error.name, errorMessage: error.message }
      }, { new: true });
      console.error("[taskspot:refund-finalization]", { refundId: String(refund._id), code: error.code || error.name });
    }
  }
  return refund;
}

export async function reconcilePendingPaymentRefunds() {
  const refunds = await PaymentRefund.find({ status: "pending", providerRequestId: { $gt: "" } })
    .sort({ updatedAt: 1 })
    .limit(20);
  for (const refund of refunds) {
    try {
      const providerResult = await getRefundStatus(refund.providerRequestId);
      if (providerResult.status === "Accepted") {
        await finalizePaymentRefund(refund._id, providerResult.status);
        try { await fiscalizePaymentRefund(refund._id); } catch (error) {
          console.error("[taskspot:refund-fiscalization]", { refundId: String(refund._id), code: error.code || error.name });
        }
      } else if (providerResult.status === "Rejected") {
        await failPaymentRefund(refund._id, { providerStatus: providerResult.status });
      } else {
        refund.providerStatus = providerResult.status;
        await refund.save();
      }
    } catch (error) {
      console.error("[taskspot:refund-reconciliation]", { refundId: String(refund._id), code: error.code || error.name });
    }
  }
}

export async function processPendingRefundReceipts(now = new Date()) {
  const retryBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const refunds = await PaymentRefund.find({
    status: "succeeded",
    "fiscalization.status": { $in: ["pending", "failed"] },
    $or: [
      { "fiscalization.lastAttemptAt": { $exists: false } },
      { "fiscalization.lastAttemptAt": { $lte: retryBefore } }
    ]
  }).select("_id").limit(20).lean();
  for (const refund of refunds) {
    try { await fiscalizePaymentRefund(refund._id); } catch (error) {
      console.error("[taskspot:refund-fiscalization]", { refundId: String(refund._id), code: error.code || error.name });
    }
  }
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
