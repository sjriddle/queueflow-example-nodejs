/**
 * A TypeScript QueueFlow worker, built on the remote worker protocol
 * (`POST /queues/{queue}/lease`, then heartbeat and complete/fail).
 *
 * The handlers below run here, in Node — not inside the Rust server. The
 * engine still owns retries, timeouts, the dead-letter queue, and workflow
 * advancement; this process just leases jobs, heartbeats while a handler
 * runs, and reports the outcome. Delivery is at-least-once, so handlers
 * should be idempotent.
 *
 * For the demo it runs in-process next to Express (see ./index.ts); in
 * production you'd run it as its own deployment and scale it independently —
 * nothing about the code changes.
 */

import type { Job, JsonObject } from "@queueflow/sdk";
import { qf, APP_QUEUE, TASKS } from "./queueflow.js";

/** This app's real task handlers, keyed by task name. */
export const handlers: Record<string, (job: Job) => Promise<JsonObject>> = {
  [TASKS.sendWelcomeEmail]: async (job) => {
    const { to, name } = (job.payload ?? {}) as {
      to?: string;
      name?: string | null;
    };
    // ... here you'd render a template and call your email provider ...
    console.log(`[worker] sending welcome email to ${to} (job ${job.id})`);
    await new Promise((resolve) => setTimeout(resolve, 250)); // provider latency
    return { delivered: true, to: to ?? null, name: name ?? null, template: "welcome" };
  },
};

/**
 * Run the lease/heartbeat/report loop until `signal` aborts. The loop
 * long-polls the queue (`waitSecs`), so an idle worker costs one cheap
 * request every 20 seconds.
 */
export function startWorker(signal: AbortSignal): Promise<void> {
  console.log(
    `[worker] consuming queue "${APP_QUEUE}" (tasks: ${Object.keys(handlers).join(", ")})`,
  );
  return qf.worker.run(APP_QUEUE, handlers, {
    leaseSecs: 30,
    waitSecs: 20,
    signal,
  });
}
