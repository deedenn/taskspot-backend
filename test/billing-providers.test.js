import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { PaymentOrder } from "../src/models/PaymentOrder.js";
import { User } from "../src/models/User.js";
import { tochkaWebhookRouter } from "../src/routes/tochkaWebhook.js";
import { billingIntegrationPayload } from "../src/services/billingProviders.js";
import {
  buildRefundReceipt,
  buildSaleReceipt,
  createRefundReceipt,
  createSaleReceipt,
  receiptIdForOrder,
  receiptIdForRefund
} from "../src/services/digitalKassa.js";
import {
  createDynamicQr,
  getRefundStatus,
  getQrPaymentStatuses,
  normalizeIncomingPayment,
  rublesToKopecks,
  startRefund,
  upsertWebhookConfiguration,
  verifyWebhookToken
} from "../src/services/tochkaSbp.js";
import { fiscalizePaymentOrder } from "../src/services/subscriptions.js";

function withEnvironment(values, callback) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  return Promise.resolve()
    .then(callback)
    .finally(() => {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("Tochka creates a dynamic SBP QR and normalizes the response", async () => {
  await withEnvironment({
    TOCHKA_API_URL: "https://tochka.example/uapi",
    TOCHKA_JWT_TOKEN: "jwt-token",
    TOCHKA_MERCHANT_ID: "merchant-1",
    TOCHKA_ACCOUNT_ID: "account/bic",
    CLIENT_URL: "https://taskspot.ru"
  }, async () => {
    let request;
    const result = await createDynamicQr({
      order: {
        _id: "order-1",
        planName: "Команда",
        amountKopecks: 99000
      },
      fetchImpl: async (url, options) => {
        request = { url, options, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({
          Data: { qrcId: "qrc-1", payload: "https://qr.example/pay", image: "aW1hZ2U=" }
        }), { status: 200 });
      }
    });

    assert.equal(request.url, "https://tochka.example/uapi/sbp/v1.0/qr-code/merchant/merchant-1/account%2Fbic");
    assert.equal(request.options.headers.Authorization, "Bearer jwt-token");
    assert.equal(request.body.Data.amount, 99000);
    assert.equal(request.body.Data.qrcType, "02");
    assert.equal(result.qrcId, "qrc-1");
    assert.equal(result.paymentUrl, "https://qr.example/pay");
    assert.equal(result.qrImage, "data:image/png;base64,aW1hZ2U=");
  });
});

test("production billing readiness requires Tochka, DigitalKassa, HTTPS webhook and workers", async () => {
  await withEnvironment({
    NODE_ENV: "production",
    BILLING_PROVIDER: "tochka_sbp",
    TOCHKA_JWT_TOKEN: "jwt-token",
    TOCHKA_CLIENT_ID: "client-id",
    TOCHKA_MERCHANT_ID: "merchant-id",
    TOCHKA_ACCOUNT_ID: "40802810920000021178",
    TOCHKA_BIC: "044525104",
    DIGITALKASSA_ACTOR_ID: "actor",
    DIGITALKASSA_ACTOR_TOKEN: "token",
    DIGITALKASSA_C_GROUP_ID: "3634",
    BILLING_WEBHOOK_URL: "https://api.taskspot.ru/api/webhooks/tochka/sbp",
    BACKGROUND_WORKERS_ENABLED: "true"
  }, async () => {
    assert.equal(billingIntegrationPayload().ready, true);
    process.env.BACKGROUND_WORKERS_ENABLED = "false";
    const stoppedWorkers = billingIntegrationPayload();
    assert.equal(stoppedWorkers.ready, false);
    assert.ok(stoppedWorkers.missing.includes("фоновые workers"));
    process.env.BACKGROUND_WORKERS_ENABLED = "true";
    process.env.BILLING_WEBHOOK_URL = "http://api.taskspot.ru/webhook";
    const insecureWebhook = billingIntegrationPayload();
    assert.equal(insecureWebhook.ready, false);
    assert.ok(insecureWebhook.missing.includes("HTTPS webhook"));
  });
});

test("Tochka webhook requires a valid RS256 signature", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const token = jwt.sign({ webhookType: "incomingSbpPayment", qrcId: "qrc-1" }, privateKey, {
    algorithm: "RS256",
    expiresIn: "5m"
  });
  await withEnvironment({
    TOCHKA_WEBHOOK_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString()
  }, async () => {
    const payload = await verifyWebhookToken(token);
    assert.equal(payload.qrcId, "qrc-1");
    const [header, body, signature] = token.split(".");
    const tamperedSignature = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
    await assert.rejects(
      () => verifyWebhookToken(`${header}.${body}.${tamperedSignature}`),
      (error) => error.code === "TOCHKA_INVALID_SIGNATURE" && error.statusCode === 401
    );
  });
});

test("public webhook route accepts a signed token string", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const token = jwt.sign({ webhookType: "connectionTest" }, privateKey, { algorithm: "RS256", expiresIn: "5m" });
  await withEnvironment({
    NODE_ENV: "test",
    TOCHKA_WEBHOOK_PUBLIC_KEY: publicKey.export({ type: "spki", format: "pem" }).toString()
  }, async () => {
    const handler = tochkaWebhookRouter.stack.find((layer) => layer.route?.path === "/").route.stack[0].handle;
    let responseBody;
    await handler(
      { body: token },
      { json(value) { responseBody = value; } },
      (error) => { throw error; }
    );
    assert.deepEqual(responseBody, { ok: true, handled: false });
  });
});

test("Tochka QR status fallback normalizes accepted operations", async () => {
  await withEnvironment({
    TOCHKA_API_URL: "https://tochka.example/uapi",
    TOCHKA_JWT_TOKEN: "jwt-token",
    TOCHKA_MERCHANT_ID: "merchant-1",
    TOCHKA_ACCOUNT_ID: "account/bic"
  }, async () => {
    let requestedUrl;
    const statuses = await getQrPaymentStatuses(["qrc-1", "qrc-2"], {
      fetchImpl: async (url) => {
        requestedUrl = url;
        return new Response(JSON.stringify({
          Data: {
            paymentList: [{ qrcId: "qrc-1", status: "Accepted", trxId: "1".repeat(32), code: "RQ00000", message: "OK" }]
          }
        }), { status: 200 });
      }
    });
    assert.equal(requestedUrl, "https://tochka.example/uapi/sbp/v1.0/qr-codes/qrc-1%2Cqrc-2/payment-status");
    assert.deepEqual(statuses[0], {
      qrcId: "qrc-1",
      status: "Accepted",
      operationId: "1".repeat(32),
      code: "RQ00000",
      message: "OK"
    });
  });
});

test("money parsing is exact and rejects ambiguous amounts", () => {
  assert.equal(rublesToKopecks("990.00"), 99000);
  assert.equal(rublesToKopecks("990.5"), 99050);
  assert.equal(rublesToKopecks("990,00"), null);
  assert.equal(rublesToKopecks("1.001"), null);
});

test("Tochka webhook preserves payment purpose for order recovery", () => {
  const payload = normalizeIncomingPayment({
    Data: {
      webhookType: "incomingSbpPayment",
      paymentType: "sbpPayment",
      qrcId: "qrc-1",
      purpose: "Доступ к Taskspot. Заказ 507f1f77bcf86cd799439011. НДС не облагается"
    }
  });
  assert.equal(payload.purpose, "Доступ к Taskspot. Заказ 507f1f77bcf86cd799439011. НДС не облагается");
});

test("Tochka starts and checks a partial SBP refund", async () => {
  await withEnvironment({
    TOCHKA_API_URL: "https://tochka.example/uapi",
    TOCHKA_JWT_TOKEN: "jwt-token",
    TOCHKA_MERCHANT_ID: "merchant-1",
    TOCHKA_ACCOUNT_ID: "40802810920000021178",
    TOCHKA_BIC: "044525104"
  }, async () => {
    const requests = [];
    const order = {
      _id: "507f1f77bcf86cd799439011",
      payment: { providerPaymentId: "qrc-1", refTransactionId: "ref-1", operationId: "trx-1" }
    };
    const refund = await startRefund({
      order,
      amountKopecks: 12345,
      reason: "Возврат по обращению клиента",
      fetchImpl: async (url, options) => {
        requests.push({ url, method: options.method, body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ Data: { requestId: "refund-1", status: "InProgress" } }), { status: 200 });
      }
    });
    assert.equal(requests[0].url, "https://tochka.example/uapi/sbp/v1.0/refund");
    assert.equal(requests[0].body.Data.amount, "123.45");
    assert.equal(requests[0].body.Data.accountCode, "40802810920000021178");
    assert.equal(requests[0].body.Data.bankCode, "044525104");
    assert.equal(requests[0].body.Data.refTransactionId, "ref-1");
    assert.deepEqual(refund, { requestId: "refund-1", status: "InProgress" });

    const status = await getRefundStatus("refund-1", {
      fetchImpl: async (url, options) => {
        requests.push({ url, method: options.method });
        return new Response(JSON.stringify({ Data: { requestId: "refund-1", status: "Accepted" } }), { status: 200 });
      }
    });
    assert.equal(requests[1].url, "https://tochka.example/uapi/sbp/v1.0/refund/refund-1");
    assert.equal(status.status, "Accepted");
  });
});

test("Tochka webhook setup edits an existing subscription", async () => {
  await withEnvironment({
    TOCHKA_API_URL: "https://tochka.example/uapi",
    TOCHKA_JWT_TOKEN: "jwt-token",
    TOCHKA_CLIENT_ID: "client-id"
  }, async () => {
    const requests = [];
    const response = await upsertWebhookConfiguration({
      url: "https://api.taskspot.ru/api/webhooks/tochka/sbp",
      fetchImpl: async (url, options) => {
        requests.push({ url, method: options.method, body: options.body ? JSON.parse(options.body) : undefined });
        if (options.method === "GET") {
          return new Response(JSON.stringify({ Data: { url: "https://old.example", webhooksList: [] } }), { status: 200 });
        }
        return new Response(JSON.stringify({ Data: JSON.parse(options.body) }), { status: 200 });
      }
    });
    assert.equal(requests[0].method, "GET");
    assert.equal(requests[1].method, "POST");
    assert.deepEqual(requests[1].body, {
      webhooksList: ["incomingSbpPayment"],
      url: "https://api.taskspot.ru/api/webhooks/tochka/sbp"
    });
    assert.equal(response.Data.url, "https://api.taskspot.ru/api/webhooks/tochka/sbp");
  });
});

test("DigitalKassa receipt contains agreed tax and service attributes", async () => {
  await withEnvironment({
    DIGITALKASSA_API_URL: "https://kassa.example/v2.1",
    DIGITALKASSA_ACTOR_ID: "actor",
    DIGITALKASSA_ACTOR_TOKEN: "token",
    DIGITALKASSA_C_GROUP_ID: "3634",
    DIGITALKASSA_BILLING_PLACE: "https://taskspot.ru"
  }, async () => {
    const order = {
      _id: "507f1f77bcf86cd799439011",
      planName: "Команда",
      amountKopecks: 99000,
      fiscalization: { receiptId: "" }
    };
    const receipt = buildSaleReceipt({ order, email: "user@example.com" });
    assert.equal(receipt.taxation, 2);
    assert.equal(receipt.is_internet, 1);
    assert.equal(receipt.timezone, 2);
    assert.deepEqual(receipt.amount, { cashless: 990 });
    assert.equal(receipt.items[0].type, 4);
    assert.equal(receipt.items[0].vat, 6);
    assert.equal(receipt.items[0].payment_method, 4);
    assert.equal(receipt.items[0].unit, 0);

    let request;
    const result = await createSaleReceipt({
      order,
      email: "user@example.com",
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response(JSON.stringify({ service: { receipt_url: "https://receipt.example/1" } }), { status: 201 });
      }
    });
    assert.equal(request.url, `https://kassa.example/v2.1/c_groups/3634/receipts/${receiptIdForOrder(order._id)}`);
    assert.equal(request.options.headers.Authorization, `Basic ${Buffer.from("actor:token").toString("base64")}`);
    assert.equal(result.succeeded, true);
    assert.equal(result.receiptUrl, "https://receipt.example/1");
  });
});

test("fiscalization reads the current profile email instead of an order snapshot", async (t) => {
  await withEnvironment({
    DIGITALKASSA_API_URL: "https://kassa.example/v2.1",
    DIGITALKASSA_ACTOR_ID: "actor",
    DIGITALKASSA_ACTOR_TOKEN: "token",
    DIGITALKASSA_C_GROUP_ID: "3634"
  }, async () => {
    const userId = new mongoose.Types.ObjectId();
    const order = new PaymentOrder({
      organization: new mongoose.Types.ObjectId(),
      requestedBy: userId,
      targetPlan: "team",
      planVersion: 2,
      planName: "Команда",
      periodMonths: 1,
      transitionType: "activate",
      status: "paid",
      amountKopecks: 99000,
      priceSnapshot: { plan: "team" },
      idempotencyKey: "current-email-test",
      isOpen: false,
      expiresAt: new Date(Date.now() + 60000),
      payment: { provider: "tochka_sbp", status: "succeeded", providerPaymentId: "qrc-email" }
    });
    t.mock.method(order, "save", async () => order);
    t.mock.method(PaymentOrder, "findById", async () => order);
    t.mock.method(User, "findById", () => ({
      select: () => ({ lean: async () => ({ email: "current@example.com" }) })
    }));
    const previousFetch = globalThis.fetch;
    let body;
    globalThis.fetch = async (_url, options) => {
      body = JSON.parse(options.body);
      return new Response(JSON.stringify({ status: "pending" }), { status: 202 });
    };
    try {
      const result = await fiscalizePaymentOrder(order._id, { trigger: "manual" });
      assert.deepEqual(body.notify.emails, ["current@example.com"]);
      assert.equal(result.fiscalization.receiptEmailUsed, "current@example.com");
      assert.equal(result.fiscalization.attemptLog[0].email, "current@example.com");
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

test("DigitalKassa creates a return receipt for the refunded amount", async () => {
  await withEnvironment({
    DIGITALKASSA_API_URL: "https://kassa.example/v2.1",
    DIGITALKASSA_ACTOR_ID: "actor",
    DIGITALKASSA_ACTOR_TOKEN: "token",
    DIGITALKASSA_C_GROUP_ID: "3634"
  }, async () => {
    const order = { _id: "order-1", planName: "Команда", amountKopecks: 99000 };
    const refund = {
      _id: "refund-1",
      amountKopecks: 25000,
      fiscalization: { receiptId: "" }
    };
    const receipt = buildRefundReceipt({ order, refund, email: "user@example.com" });
    assert.equal(receipt.type, 2);
    assert.equal(receipt.amount.cashless, 250);
    assert.equal(receipt.items[0].amount, 250);
    assert.deepEqual(receipt.notify.emails, ["user@example.com"]);

    let request;
    const result = await createRefundReceipt({
      order,
      refund,
      email: "user@example.com",
      fetchImpl: async (url, options) => {
        request = { url, body: JSON.parse(options.body) };
        return new Response(JSON.stringify({ service: { receipt_url: "https://receipt.example/refund" } }), { status: 201 });
      }
    });
    assert.equal(request.url, `https://kassa.example/v2.1/c_groups/3634/receipts/${receiptIdForRefund(refund._id)}`);
    assert.equal(request.body.type, 2);
    assert.equal(result.succeeded, true);
  });
});
