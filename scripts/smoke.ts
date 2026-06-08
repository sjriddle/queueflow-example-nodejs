/**
 * End-to-end smoke test of the SDK against a running QueueFlow server.
 *
 *   npm run smoke
 *
 * Enqueues a job, waits for it, runs a 3-step workflow, and prints the results.
 * Requires a server reachable at QUEUEFLOW_URL (default http://localhost:8000).
 */

import { QueueFlow, wf } from "@queueflow/sdk";

const qf = new QueueFlow({
  baseUrl: process.env.QUEUEFLOW_URL ?? "http://localhost:8000",
  token: process.env.QUEUEFLOW_TOKEN ?? "dev",
});

async function main() {
  console.log("health:", await qf.health());
  console.log("registered tasks:", await qf.system.tasks());

  // 1) A single job, awaited to completion.
  const job = await qf.jobs.create({
    task: "echo",
    payload: { hello: "world" },
    maxRetries: 3,
  });
  console.log(`\nenqueued job ${job.id} (${job.status})`);
  const done = await qf.jobs.waitFor(job.id, { timeoutMs: 15_000 });
  console.log(`job ${done.id} -> ${done.status}`, done.result ?? "");

  // 2) A DAG workflow.
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

  console.log("\nstats:", await qf.system.stats());
  console.log("\n✓ smoke test passed");
}

main().catch((err) => {
  console.error("\n✗ smoke test failed:", err);
  process.exit(1);
});
