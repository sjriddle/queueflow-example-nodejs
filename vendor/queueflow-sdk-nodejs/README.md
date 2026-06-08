# @queueflow/sdk

Ergonomic TypeScript/JavaScript client for [QueueFlow](https://queueflow.dev) — a
PostgreSQL/PGMQ-native distributed job queue and workflow engine.

- **Typed end-to-end** — request/response shapes mirror the server's OpenAPI 3.1 spec.
- **Ergonomic** — `qf.jobs.create({ task, payload })`, a `waitFor()` poller, and a workflow builder DSL.
- **Typed errors** — `NotFoundError`, `UnauthorizedError`, `BadRequestError`, `TimeoutError`, …
- **Zero runtime dependencies** — uses the built-in `fetch` (Node ≥ 18), with retries and timeouts.
- **ESM**, ships its own `.d.ts`.

> This client is hand-written (not generated) for a nicer developer experience. It targets the
> same REST API as the [code-generated OpenAPI spec](https://github.com/queueflow/queueflow-core/blob/main/spec/openapi.yaml).

## Install

```bash
npm install @queueflow/sdk
```

## Quick start

```ts
import { QueueFlow, wf } from "@queueflow/sdk";

const qf = new QueueFlow({
  baseUrl: "http://localhost:8000",
  token: process.env.QUEUEFLOW_TOKEN ?? "dev",
});

// Enqueue a job and wait for the result.
const job = await qf.jobs.create({
  task: "echo",
  payload: { hello: "world" },
  maxRetries: 3,
  timeout: 30, // seconds
});

const done = await qf.jobs.waitFor(job.id);
console.log(done.status, done.result);

// Declare and run a DAG workflow.
const workflow = await qf.workflows.create(
  wf("etl")
    .step("extract", "echo")
    .step("transform", "echo", { after: ["extract"] })
    .step("load", "echo", { after: ["transform"], onFailure: "halt" }),
);

const finished = await qf.workflows.waitFor(workflow.id);
console.log(finished.status, finished.context);
```

## API

### Client

```ts
const qf = new QueueFlow({
  baseUrl,            // required
  token,              // required — any non-empty token on the dev server
  timeoutMs,          // per-request timeout (default 30_000)
  maxRetries,         // retries for idempotent calls on network/5xx (default 2)
  headers,            // extra headers on every request
  fetch,              // inject a custom fetch (tests, proxies)
});

await qf.health();    // GET /health
await qf.ready();     // GET /ready
```

### Jobs — `qf.jobs`

| Method | Description |
| --- | --- |
| `create(input)` | Enqueue a job, returns the created `Job`. |
| `enqueue(input)` | Enqueue and return just the new job id (no follow-up fetch). |
| `createBatch(inputs)` | Enqueue up to 1000 jobs at once. |
| `get(id)` | Fetch a job. |
| `list(opts?)` | List jobs (`status`, `queue`, `limit`, `offset`, `orderBy`). |
| `cancel(id)` | Cancel a job. |
| `waitFor(id, opts?)` | Poll until `completed` / `failed` / `cancelled`. |

`input` is `{ task, payload?, priority?, maxRetries?, timeout?, queue? }`.

### Workflows — `qf.workflows`

| Method | Description |
| --- | --- |
| `create(builderOrBody)` | Create a workflow from a `wf()` builder or a raw request. |
| `get(id)` · `list(opts?)` · `cancel(id)` | Fetch / list / cancel. |
| `diagram(id)` | Mermaid (`graph TD`) diagram of the DAG. |
| `waitFor(id, opts?)` | Poll until a terminal workflow state. |

### Workflow builder — `wf()`

```ts
import { wf } from "@queueflow/sdk";

const dag = wf("order_123")
  .step("validate", "validate_order")
  .step("pay", "process_payment", { after: ["validate"] })
  .step("ship", "create_shipment", { after: ["pay"], onFailure: "continue" })
  .context({ source: "web" });
// .build() runs locally first: duplicate names, dangling deps, and cycles throw early.
```

### System — `qf.system`

```ts
await qf.system.stats();  // engine counters
await qf.system.tasks();  // registered task handler names
```

### Errors

All SDK errors extend `QueueFlowError`:

```ts
import { NotFoundError, ApiError } from "@queueflow/sdk";

try {
  await qf.jobs.get("missing");
} catch (err) {
  if (err instanceof NotFoundError) { /* 404 */ }
  else if (err instanceof ApiError) { console.error(err.status, err.body); }
  else throw err;
}
```

`ApiError` subclasses: `BadRequestError` (400), `UnauthorizedError` (401),
`ForbiddenError` (403), `NotFoundError` (404). Network/abort failures throw
`ConnectionError`; an exhausted `waitFor` throws `TimeoutError`.

## Try it against a real server

A complete, runnable Express integration that uses this SDK lives in
[`../queueflow-examples/nodejs/express`](../queueflow-examples/nodejs/express). With
Docker + Rust + Node installed it brings up Postgres, the QueueFlow server, builds
this SDK, and runs an end-to-end smoke test in one command:

```bash
cd ../queueflow-examples/nodejs/express
make demo                 # stack up + SDK build + smoke test
make app                  # run the example API on :3000
make down                 # stop the server + remove the Postgres container
```

Override ports if the defaults are taken, passing the **same** values to each
command (`make demo PG_PORT=5440 API_PORT=8055`, then `make app API_PORT=8055`,
`make down API_PORT=8055 PG_PORT=5440`). See that example's README for endpoint
docs, hitting the engine directly, teardown, and troubleshooting.

## Requirements

- Node.js ≥ 18 (for the global `fetch`).
- A running QueueFlow server — see [queueflow-core](https://github.com/queueflow/queueflow-core).

## License

[MIT](./LICENSE)
