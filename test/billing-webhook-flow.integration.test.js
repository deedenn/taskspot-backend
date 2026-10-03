import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, before, test } from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";

function isolatedDatabaseUri() {
  if (!process.env.TEST_MONGODB_URI) return "";
  const url = new URL(process.env.TEST_MONGODB_URI);
  url.pathname = `/ts_billing_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  return url.toString();
}

if (!process.env.TEST_MONGODB_URI) {
  test("signed webhook activates subscription and creates a receipt", {
    skip: "Set TEST_MONGODB_URI to a local replica set"
  }, () => {});
} else {
  const databaseUri = isolatedDatabaseUri();
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  Object.assign(process.env, {
    NODE_ENV: "test",
    JWT_SECRET: "billing-flow-test",
    TOCHKA_WEBHOOK_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString(),
    TOCHKA_MERCHANT_ID: "merchant-test",
    DIGITALKASSA_API_URL: "https://digitalkassa.test/v2.1",
    DIGITALKASSA_ACTOR_ID: "actor-test",
    DIGITALKASSA_ACTOR_TOKEN: "token-test",
    DIGITALKASSA_C_GROUP_ID: "group-test"
  });

  const { createApp } = await import("../src/app.js");
  const { BillingEvent } = await import("../src/models/BillingEvent.js");
  const { Organization } = await import("../src/models/Organization.js");
  const { PaymentOrder } = await import("../src/models/PaymentOrder.js");
  const { Subscription } = await import("../src/models/Subscription.js");
  const { SubscriptionPeriod } = await import("../src/models/SubscriptionPeriod.js");
  const { User } = await import("../src/models/User.js");
  const { synchronizeOrganizationSubscription } = await import("../src/services/subscriptions.js");

  let server;
  let baseUrl;
  let originalFetch;

  before(async () => {
    await mongoose.connect(databaseUri);
    server = createApp().listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    originalFetch = globalThis.fetch;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise((resolve) => server.close(resolve));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test("signed webhook activates subscription and creates a receipt", async () => {
    const user = await User.create({
      name: "Покупатель",
      email: "old@example.com",
      passwordHash: "not-used-in-this-test",
      emailVerifiedAt: new Date(),
      emailVerificationStatus: "verified"
    });
    const organization = await Organization.create({
      name: "Billing E2E",
      personalOwner: user._id,
      members: [{ user: user._id, role: "owner" }]
    });
    await synchronizeOrganizationSubscription(organization);
    const order = await PaymentOrder.create({
      organization: organization._id,
      requestedBy: user._id,
      targetPlan: "team",
      planVersion: 1,
      planName: "Команда",
      periodMonths: 1,
      transitionType: "activate",
      amountKopecks: 99000,
      priceSnapshot: { plan: "team", version: 1, name: "Команда", monthlyPriceKopecks: 99000, periodMonths: 1 },
      idempotencyKey: "billing-flow-order",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      payment: {
        provider: "tochka_sbp",
        status: "pending",
        providerPaymentId: "qrc-e2e",
        expiresAt: new Date(Date.now() + 30 * 60 * 1000)
      }
    });

    await User.updateOne({ _id: user._id }, { $set: { email: "current@example.com" } });
    let receiptRequest;
    globalThis.fetch = async (url, options = {}) => {
      if (String(url).startsWith("https://digitalkassa.test/")) {
        receiptRequest = JSON.parse(options.body);
        return new Response(JSON.stringify({ service: { receipt_url: "https://receipt.test/e2e" } }), { status: 201 });
      }
      return originalFetch(url, options);
    };

    const token = jwt.sign({
      Data: {
        webhookType: "incomingSbpPayment",
        paymentType: "sbpPayment",
        qrcId: "qrc-e2e",
        merchantId: "merchant-test",
        operationId: "1".repeat(32),
        refTransactionId: "2".repeat(32),
        amount: "990.00",
        purpose: `Доступ к Taskspot. Заказ ${order._id}. НДС не облагается`
      }
    }, privateKey, { algorithm: "RS256", expiresIn: "5m" });
    const response = await originalFetch(`${baseUrl}/api/webhooks/tochka/sbp`, {
      method: "POST",
      headers: { "Content-Type": "application/jwt" },
      body: token
    });
    assert.equal(response.status, 200, await response.text());

    const [paidOrder, subscription, period, events] = await Promise.all([
      PaymentOrder.findById(order._id).lean(),
      Subscription.findOne({ organization: organization._id }).lean(),
      SubscriptionPeriod.findOne({ sourceOrder: order._id }).lean(),
      BillingEvent.find({ correlationId: String(order._id) }).lean()
    ]);
    assert.equal(paidOrder.status, "paid");
    assert.equal(paidOrder.fiscalization.status, "succeeded");
    assert.equal(paidOrder.fiscalization.receiptEmailUsed, "current@example.com");
    assert.deepEqual(receiptRequest.notify.emails, ["current@example.com"]);
    assert.equal(subscription.currentPlan, "team");
    assert.equal(String(subscription.currentPeriod), String(period._id));
    assert.equal(period.status, "active");
    assert.equal(period.plan, "team");
    assert.ok(events.some((event) => event.type === "PaymentSucceeded"));
    assert.ok(events.some((event) => event.type === "SubscriptionPeriodActivated"));
    assert.ok(events.some((event) => event.type === "FiscalReceiptIssued"));
  });
}
