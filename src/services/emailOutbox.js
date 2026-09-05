import crypto from "node:crypto";
import { User } from "../models/User.js";
import { Project } from "../models/Project.js";
import { enqueueEmail } from "./emailQueue.js";

// The source change and its email intent are committed in one document save.
export function persistEmailWith(document, path) {
  return async (mail, context = {}) => {
    const key = context.dedupeKey || crypto.randomUUID();
    document.set(path, { key, mail, context: { ...context, dedupeKey: key }, createdAt: new Date() });
    await document.save();
    return { queued: true, status: "queued" };
  };
}

export async function transferEmailIntent(Model, filter, path, intent) {
  await enqueueEmail(intent.mail, intent.context);
  // The caller's key condition protects an intent replaced by a concurrent resend.
  await Model.updateOne(filter, { $unset: { [path]: "" } });
}

export async function drainEmailOutbox() {
  const users = await User.find({ "emailOutbox.key": { $exists: true } }).select("+emailOutbox").limit(100);
  const projects = await Project.find({ $or: [
    { "invitations.emailOutbox.key": { $exists: true } },
    { "members.emailOutbox.key": { $exists: true } }
  ] }).select("+invitations.emailOutbox +members.emailOutbox").limit(100);
  const transfer = async (Model, filter, path, intent) => {
    try { await transferEmailIntent(Model, filter, path, intent); }
    catch { console.error("[taskspot:email-queue]", { event: "outbox_transfer_failed", sourceId: String(filter._id) }); }
  };
  for (const user of users) {
    await transfer(User, { _id: user._id, "emailOutbox.key": user.emailOutbox.key }, "emailOutbox", user.emailOutbox);
  }
  for (const project of projects) {
    for (const collection of ["invitations", "members"]) {
      for (const item of project[collection]) {
        if (!item.emailOutbox) continue;
        await transfer(Project, { _id: project._id,
          [collection]: { $elemMatch: { "emailOutbox.key": item.emailOutbox.key } }
        }, `${collection}.$.emailOutbox`, item.emailOutbox);
      }
    }
  }
}
