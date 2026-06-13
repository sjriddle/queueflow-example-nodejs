/**
 * End-to-end smoke test of the SDK against a running QueueFlow server.
 *
 *   npm run smoke
 *
 * Covers both execution models plus the SSE/idempotency surface:
 *   1. a job run by the engine's built-in handlers (default queue),
 *   2. a job run by a TypeScript handler in *this process* via the remote
 *      worker protocol (lease / heartbeat / complete), followed live over
 *      Server-Sent Events, with an idempotent-replay check,
 *   3. a 3-step DAG workflow,
 *   4. list pagination with `includeTotal` and the engine counters.
 *
 * Requires a server reachable at QUEUEFLOW_URL (default http://localhost:8000).
 */

import { QueueFlow, wf } from "@queueflow/sdk";

const qf = new QueueFlow({
  baseUrl: process.env.QUEUEFLOW_URL ?? "http://localhost:8000",
  token: process.env.QUEUEFLOW_TOKEN ?? "dev",
});

const SMOKE_QUEUE = "smoke";

async function main() {
  console.log("health:", await qf.health());
  console.log("registered tasks (engine):", await qf.system.tasks());

  // 1) A single job on the default queue, run by an engine built-in handler.
  const job = await qf.jobs.create({
    task: "echo",
    payload: { hello: "world" },
    maxRetries: 3,
  });
  console.log(`\nenqueued job ${job.id} (${job.status})`);
  const done = await qf.jobs.waitFor(job.id, { timeoutMs: 15_000 });
  console.log(`job ${done.id} -> ${done.status}`, done.result ?? "");

  // 2) A real TypeScript handler via the remote worker protocol. The engine's
  //    workers only consume the default queue, so jobs on SMOKE_QUEUE belong
  //    exclusively to this process's worker loop.
  const stopWorker = new AbortController();
  const worker = qf.worker.run(
    SMOKE_QUEUE,
    {
      send_welcome_email: async (j) => {
        console.log(`  [worker] leased ${j.id}, sending welcome email...`);
        return { delivered: true, to: (j.payload as { to?: string })?.to ?? null };
      },
    },
    { waitSecs: 5, signal: stopWorker.signal },
  );

  // Unique per run; replaying it within the run must return the same job.
  const idemKey = `smoke:welcome:${Date.now()}`;
  const emailJobId = await qf.jobs.enqueue({
    task: "send_welcome_email",
    payload: { to: "ada@example.com" },
    queue: SMOKE_QUEUE,
    idempotencyKey: idemKey,
  });
  console.log(`\nenqueued ${emailJobId} on "${SMOKE_QUEUE}" (handled in-process)`);

  const replayed = await qf.jobs.enqueue({
    task: "send_welcome_email",
    payload: { to: "ada@example.com" },
    queue: SMOKE_QUEUE,
    idempotencyKey: idemKey,
  });
  if (replayed !== emailJobId) {
    throw new Error(`idempotent replay returned ${replayed}, expected ${emailJobId}`);
  }
  console.log("idempotent replay returned the same job id ✓");

  // Follow the job live over SSE instead of polling.
  for await (const update of qf.jobs.watch(emailJobId)) {
    console.log(`  [watch] ${update.id} -> ${update.status}`);
    if (update.status === "completed") console.log("  [watch] result:", update.result);
  }
  stopWorker.abort();

  // 3) A DAG workflow (steps run on the engine's default queue via built-ins).
  const workflow = await qf.workflows.create(
    wf("etl-smoke")
      .step("extract", "echo")
      .step("transform", "echo", { after: ["extract"] })
      .step("load", "echo", { after: ["transform"] }),
  );
  console.log(`\nstarted workflow ${workflow.id} (${workflow.status})`);
  const finished = await qf.workflows.waitFor(workflow.id, {
    timeoutMs: 30_000,
  });
  console.log(`workflow ${finished.id} -> ${finished.status}`);

  const { diagram } = await qf.workflows.diagram(finished.id);
  console.log("\nDAG:\n" + diagram);

  // 4) Lists + counters. `total` is opt-in (it costs an extra count query).
  const page = await qf.jobs.list({ queue: SMOKE_QUEUE, includeTotal: true });
  console.log(`jobs on "${SMOKE_QUEUE}": total=${page.total}, has_more=${page.has_more}`);
  console.log("\nstats:", await qf.system.stats());

  // Let the worker loop notice the abort (its long-poll returns within ~5s).
  await worker;
  console.log("\n✓ smoke test passed");
}

main().catch((err) => {
  console.error("\n✗ smoke test failed:", err);
  process.exit(1);
});
