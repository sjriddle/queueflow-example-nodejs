/**
 * A single, shared QueueFlow client built from the environment.
 *
 * In a real app you'd construct this once at startup and inject it; here we
 * export a module singleton for brevity.
 */

import { QueueFlow } from "@queueflow/sdk";

export const qf = new QueueFlow({
  baseUrl: process.env.QUEUEFLOW_URL ?? "http://localhost:8000",
  token: process.env.QUEUEFLOW_TOKEN ?? "dev",
  // Modest per-request timeout; the SDK retries idempotent calls on 5xx/network.
  timeoutMs: 10_000,
});

/**
 * The queue this app's TypeScript worker leases from (see ./worker.ts).
 *
 * The engine's in-process workers only consume its *default* queue, so jobs
 * enqueued here are never touched by the server's built-in handlers — they run
 * exclusively in this app, via the remote worker protocol.
 */
export const APP_QUEUE = process.env.QUEUEFLOW_APP_QUEUE ?? "app";

/**
 * Task names used by this app.
 *
 * `sendWelcomeEmail` is a real handler implemented in ./worker.ts and executed
 * over the remote worker protocol (lease / heartbeat / complete) on APP_QUEUE.
 *
 * Workflow steps are different: the engine always schedules step jobs on its
 * default queue, which its in-process workers consume, so the report steps map
 * onto the dev server's built-in handlers (`echo`, `log`, `sleep`, `fail`).
 * In production you'd register real step handlers in the Rust engine
 * (`Engine::builder(...).register("extract", ...)`) and use those names.
 */
export const TASKS = {
  // Handled by this app's own worker (./worker.ts).
  sendWelcomeEmail: "send_welcome_email",
  // Workflow steps: run by the engine's built-in handlers on the default queue.
  extract: "echo",
  transform: "echo",
  load: "echo",
} as const;
