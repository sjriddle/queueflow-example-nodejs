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
 * Map the *business* tasks this app cares about onto the task handlers that the
 * stock QueueFlow dev server actually registers (`echo`, `log`, `sleep`,
 * `fail`).
 *
 * In production you would register real handlers in the Rust worker
 * (`Engine::builder(...).register("send_welcome_email", ...)`) and use those
 * names directly. Mapping them here keeps the example runnable against an
 * unmodified server while still demonstrating the end-to-end flow.
 */
export const TASKS = {
  sendWelcomeEmail: "echo",
  generateReport: "sleep",
  extract: "echo",
  transform: "echo",
  load: "echo",
} as const;
