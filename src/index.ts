import { createApp } from "./server.js";
import { startWorker } from "./worker.js";

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

// The worker runs in-process so the demo stays one command; in production it
// would be its own deployment, scaled independently of the HTTP tier.
const stop = new AbortController();
const worker = startWorker(stop.signal);

const server = app.listen(port, () => {
  console.log(`queueflow-express-example listening on http://localhost:${port}`);
  console.log(`  QueueFlow:  ${process.env.QUEUEFLOW_URL ?? "http://localhost:8000"}`);
  console.log("  Try:        curl -s -XPOST localhost:" + port + "/signup -H 'content-type: application/json' -d '{\"email\":\"ada@example.com\"}'");
});

async function shutdown(sig: string) {
  console.log(`\n${sig}: shutting down`);
  stop.abort();
  server.close();
  // The worker loop exits once its in-flight long-poll returns (up to
  // ~waitSecs); give it a short grace, then exit. A job leased but unreported
  // is simply redelivered after its lease expires — at-least-once delivery.
  await Promise.race([
    worker.catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
