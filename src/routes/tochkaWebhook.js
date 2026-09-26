import express from "express";
import { handleTochkaPaymentWebhook } from "../services/subscriptions.js";
import { verifyWebhookToken } from "../services/tochkaSbp.js";

export const tochkaWebhookRouter = express.Router();

tochkaWebhookRouter.post("/", async (req, res, next) => {
  try {
    const payload = await verifyWebhookToken(req.body);
    const result = await handleTochkaPaymentWebhook(payload);
    res.json({ ok: true, handled: result.handled });
  } catch (error) {
    next(error);
  }
});
