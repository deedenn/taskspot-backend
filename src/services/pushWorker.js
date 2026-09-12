import { PushDevice } from "../models/PushDevice.js";
import { PushJob } from "../models/PushJob.js";

const SEND_URL = "https://exp.host/--/api/v2/push/send";
const RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";

function retryAt(attempts) {
  return new Date(Date.now() + Math.min(60 * 60 * 1000, 5000 * 2 ** attempts));
}

export async function processPushJob() {
  if (process.env.EXPO_PUSH_ENABLED === "false") return false;
  const staleLock = new Date(Date.now() - 5 * 60 * 1000);
  const job = await PushJob.findOneAndUpdate(
    {
      $or: [
        { status: { $in: ["queued", "retry"] }, nextAttemptAt: { $lte: new Date() } },
        { status: "processing", lockedAt: { $lt: staleLock } }
      ],
      attempts: { $lt: 8 }
    },
    { $set: { status: "processing", lockedAt: new Date() }, $inc: { attempts: 1 } },
    { new: true, sort: { nextAttemptAt: 1 } }
  );
  if (!job) return false;

  try {
    const devices = await PushDevice.find({ user: job.user, enabled: true });
    if (!devices.length) {
      await PushJob.updateOne({ _id: job._id }, { status: "sent", tickets: [], lastError: "" });
      return true;
    }
    const messages = devices.map((device) => ({
      to: device.token,
      title: job.title,
      body: job.body,
      data: job.data,
      sound: "default",
      channelId: "tasks"
    }));
    const response = await fetch(SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(messages)
    });
    if (!response.ok) throw new Error(`Expo push returned ${response.status}`);
    const result = await response.json();
    const tickets = (Array.isArray(result.data) ? result.data : [result.data]).map((ticket, index) => ({
      id: ticket?.id || "",
      token: devices[index]?.token || "",
      error: ticket?.details?.error || ""
    }));
    const invalid = tickets.filter((ticket) => ticket.error === "DeviceNotRegistered").map((ticket) => ticket.token);
    if (invalid.length) await PushDevice.updateMany({ token: { $in: invalid } }, { enabled: false, disabledAt: new Date() });
    await PushJob.updateOne(
      { _id: job._id },
      { status: "sent", tickets: tickets.filter((ticket) => ticket.id), lastError: "", $unset: { lockedAt: "" } }
    );
  } catch (error) {
    const failed = job.attempts >= 8;
    await PushJob.updateOne(
      { _id: job._id },
      {
        status: failed ? "failed" : "retry",
        nextAttemptAt: retryAt(job.attempts),
        lastError: String(error.message || error).slice(0, 500),
        $unset: { lockedAt: "" }
      }
    );
  }
  return true;
}

export async function processPushReceipts() {
  if (process.env.EXPO_PUSH_ENABLED === "false") return false;
  const job = await PushJob.findOne({
    status: "sent",
    receiptsCheckedAt: null,
    "tickets.0": { $exists: true },
    updatedAt: { $lt: new Date(Date.now() - 15000) }
  });
  if (!job) return false;
  try {
    const response = await fetch(RECEIPTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ids: job.tickets.map((ticket) => ticket.id) })
    });
    if (!response.ok) throw new Error(`Expo receipts returned ${response.status}`);
    const result = await response.json();
    const invalidTokens = job.tickets.filter((ticket) => result.data?.[ticket.id]?.details?.error === "DeviceNotRegistered")
      .map((ticket) => ticket.token);
    if (invalidTokens.length) await PushDevice.updateMany({ token: { $in: invalidTokens } }, { enabled: false, disabledAt: new Date() });
    await PushJob.updateOne({ _id: job._id }, { receiptsCheckedAt: new Date() });
  } catch (error) {
    await PushJob.updateOne({ _id: job._id }, { lastError: String(error.message || error).slice(0, 500) });
  }
  return true;
}
