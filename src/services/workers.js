import { EmailJob } from "../models/EmailJob.js";
import { Notification } from "../models/Notification.js";
import { Task } from "../models/Task.js";
import { processEmailJob, reconcileEmailStatuses } from "./emailWorker.js";
import { runScheduledTasks } from "./taskScheduler.js";
import { drainEmailOutbox } from "./emailOutbox.js";
import { validTimeZone } from "./taskSchedule.js";

export async function startWorkers() {
  if (!validTimeZone(process.env.TASK_TIME_ZONE || "Europe/Moscow")) throw new Error("Invalid TASK_TIME_ZONE");
  // Unique indexes are required for idempotency before any worker starts.
  await Promise.all([EmailJob.createIndexes(), Notification.createIndexes(), Task.createIndexes()]);
  let stopped = false;
  const timers = new Set();
  const active = new Set();
  function loop(work, interval) {
    async function tick() {
      if (stopped) return;
      const promise = work();
      active.add(promise);
      try { await promise; } catch (error) {
        console.error("[taskspot:worker]", { name: work.name, code: error.code || error.name });
      } finally {
        active.delete(promise);
        if (!stopped) {
          const timer = setTimeout(() => { timers.delete(timer); void tick(); }, interval);
          timer.unref();
          timers.add(timer);
        }
      }
    }
    void tick();
  }
  loop(async function emailQueue() {
    await drainEmailOutbox();
    await reconcileEmailStatuses();
    for (let count = 0; count < 10 && !stopped; count += 1) {
      if (!await processEmailJob()) break;
    }
  }, 5000);
  loop(runScheduledTasks, 60000);
  return async () => {
    stopped = true;
    timers.forEach(clearTimeout);
    await Promise.allSettled([...active]);
  };
}
