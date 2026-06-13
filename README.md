# QueueFlow × Express example

A small [Express](https://expressjs.com/) service that offloads background work to
**QueueFlow** using the hand-written [`@queueflow/sdk`](./vendor/queueflow-sdk-nodejs),
which is vendored into this repo under [`vendor/`](./vendor/queueflow-sdk-nodejs).

It demonstrates the realistic backend pattern: HTTP handlers stay fast by
**enqueuing** work and returning `202 Accepted` with a status URL, instead of
blocking on slow operations. The jobs themselves are executed by a
**TypeScript worker in this app** (via QueueFlow's remote worker protocol);
clients poll the status URL — or stream it over SSE — for the outcome.

```
client ──POST /signup──▶ Express ──enqueue "welcome email"──▶ QueueFlow
   ▲                        │                                     │ lease/complete
   └────202 + statusUrl─────┘                                     ▼
         GET /jobs/:id ◀── status/result ──────────── worker (src/worker.ts)
```

> **QueueFlow** is a PostgreSQL-native distributed job queue and workflow
> engine — any plain PostgreSQL 13+, no extensions. The engine itself (Rust)
> lives in its own repo,
> [queueflow-core](https://github.com/sjriddle/queueflow-core); this repo
> is just a client-side example. The Node SDK it uses
> ([`@queueflow/sdk`](./vendor/queueflow-sdk-nodejs)) is **hand-written** — not
> code-generated — for an ergonomic developer experience, and targets the same
> [OpenAPI 3.1 spec](https://github.com/sjriddle/queueflow-core/blob/main/spec/openapi.yaml)
> the engine serves at `/openapi.json`.

## What it shows

- **Fire-and-forget jobs** — `POST /signup` enqueues a welcome email and returns immediately.
- **Real TypeScript handlers** — the welcome email runs in [`src/worker.ts`](./src/worker.ts) over the remote worker protocol (lease / heartbeat / complete), not in the Rust server.
- **Idempotent enqueue** — signup sends an `Idempotency-Key`, so re-submitting the same email returns the original job instead of double-sending.
- **Status polling and streaming** — `GET /jobs/:id` proxies a job's status/result; `GET /jobs/:id/stream` pushes every status transition as Server-Sent Events.
- **DAG workflows** — `POST /reports` builds a 3-step `extract → transform → load` workflow with the SDK's `wf()` builder.
- **Mermaid diagram** — `GET /workflows/:id/diagram` returns the DAG as Mermaid.
- **Typed error mapping** — SDK errors (`NotFoundError`, `ApiError`, …) are translated to HTTP status codes.

## One command (recommended)

If you have Docker + Rust + Node, the included `Makefile` brings up Postgres, the
QueueFlow server, builds the SDK, and runs the end-to-end smoke test:

```bash
make demo
# then, to drive the Express app and tear down:
make app      # runs the app in the foreground
make down     # stops the server + removes the Postgres container
```

Ports are overridable if the defaults are taken:

```bash
make demo PG_PORT=5440 API_PORT=8055 METRICS_PORT=9077 PORT=3055
```

> ⚠️ **Pass the *same* port overrides to every `make` command.** The app reaches
> the engine at `http://localhost:$(API_PORT)`, so if you start the server with
> `make up API_PORT=8055`, you must also run `make app API_PORT=8055` — otherwise
> the app talks to the default `:8000`, nothing is listening there, and you get
> `ECONNREFUSED`. Same goes for `make down` (it needs `PG_PORT`/`API_PORT` to find
> what to stop). See [Troubleshooting](#troubleshooting).

Run `make help` to list every target. The manual steps below are the same thing,
spelled out.

## Prerequisites

1. A running QueueFlow server. From a checkout of the [queueflow-core](https://github.com/sjriddle/queueflow-core) engine repo (the `Makefile` here expects it at `../queueflow-core-rs`):

   ```bash
   # Any plain PostgreSQL 13+ works — no extensions needed.
   docker run -d --name qf-pg -p 5432:5432 \
     -e POSTGRES_PASSWORD=postgres postgres:16-alpine

   export DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres
   cargo run -p queueflow-server -- serve --mode all --workers 5 --api-port 8000
   ```

2. The vendored SDK built (this example depends on it via a local `file:` path):

   ```bash
   cd vendor/queueflow-sdk-nodejs && npm install && npm run build
   ```

   Or just run `make sdk` from the repo root, which does the same thing.

## Run

```bash
cp .env.example .env        # adjust QUEUEFLOW_URL / TOKEN / PORT if needed
npm install
npm run dev                 # or: npm start
```

> The app demonstrates **both execution models**. The welcome email is a real
> TypeScript handler in [`src/worker.ts`](./src/worker.ts): it leases jobs from
> its own queue (`QUEUEFLOW_APP_QUEUE`, default `app`) via the remote worker
> protocol, so the handler code lives here, in Node. Workflow *steps*, by
> contrast, always run on the engine's default queue, which the server's
> in-process workers consume — so the report steps are mapped onto the dev
> server's built-in handlers (`echo`, `log`, `sleep`, `fail`) in
> [`src/queueflow.ts`](./src/queueflow.ts). In production you'd register real
> step handlers in the Rust engine and use their names directly.

## Try it

```bash
# Sign up — enqueues the welcome email, returns a job id
curl -s -XPOST localhost:3000/signup \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","name":"Ada"}'

# Poll the job
curl -s localhost:3000/jobs/<jobId>

# ...or stream its status transitions live (SSE; ends when the job finishes)
curl -N localhost:3000/jobs/<jobId>/stream

# Sign up the same email again: the Idempotency-Key means you get the
# original job back — no second welcome email.
curl -s -XPOST localhost:3000/signup \
  -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","name":"Ada"}'

# Start a report workflow
curl -s -XPOST localhost:3000/reports \
  -H 'content-type: application/json' \
  -d '{"dataset":"orders-2026-06"}'

# Poll the workflow and view its DAG
curl -s localhost:3000/workflows/<workflowId>
curl -s localhost:3000/workflows/<workflowId>/diagram
```

## Smoke test

Exercise the SDK directly against a running server (no Express needed):

```bash
npm run smoke
```

## Endpoints

| Method & path | Description |
| --- | --- |
| `GET /healthz` | Liveness; also reports QueueFlow's health. |
| `POST /signup` | Enqueue a welcome-email job (idempotent per email). |
| `GET /jobs/:id` | Job status / result. |
| `GET /jobs/:id/stream` | Job status transitions as Server-Sent Events. |
| `POST /jobs/:id/cancel` | Cancel a job. |
| `POST /reports` | Start an `extract → transform → load` workflow. |
| `GET /workflows/:id` | Workflow status / accumulated context. |
| `GET /workflows/:id/diagram` | Mermaid DAG diagram. |

## Talk to the engine directly

The Express app on `:3000` is just a client. You can also hit the **QueueFlow
engine** itself — it listens on `--api-port` (default `:8000`, or whatever you
passed as `API_PORT`). Every `/api/v1/*` route needs a bearer token (any
non-empty token authenticates on the dev server); the probes and docs don't.

```bash
ENGINE=http://localhost:8000          # = http://localhost:$API_PORT

# no token needed:
curl -s $ENGINE/health
open  $ENGINE/docs                     # interactive Swagger UI
open  $ENGINE/openapi.json             # raw OpenAPI 3.1 spec

# token required:
curl -s $ENGINE/api/v1/tasks -H 'authorization: Bearer dev'   # registered handlers
curl -s $ENGINE/api/v1/stats -H 'authorization: Bearer dev'   # engine counters
curl -s $ENGINE/api/v1/jobs  -H 'authorization: Bearer dev'   # list jobs
```

Full engine surface (all under `/api/v1`, bearer required):

| Path | Group |
| --- | --- |
| `POST /jobs` · `POST /jobs/batch` · `GET /jobs` · `GET /jobs/{id}` · `GET /jobs/{id}/events` (SSE) · `POST /jobs/{id}/cancel` | jobs |
| `POST /queues/{queue}/lease` · `POST /jobs/{id}/heartbeat` · `POST /jobs/{id}/complete` · `POST /jobs/{id}/fail` | worker (remote worker protocol) |
| `POST /workflows` · `GET /workflows` · `GET /workflows/{id}` · `POST /workflows/{id}/cancel` · `GET /workflows/{id}/diagram` | workflows |
| `GET /tasks` · `GET /stats` | introspection |
| `GET /health` · `GET /ready` · `GET /docs` · `GET /openapi.json` | probes / docs (no token) |

**Not sure which port the engine is on?** Check the running process:

```bash
pgrep -fl "queueflow serve"    # prints the exact --api-port it was started with
```

## Tear down

```bash
# If you started the stack with the Makefile:
make down                       # default ports
make down API_PORT=8055 PG_PORT=5440   # ...or the overrides you used to start it
```

`make down` kills the background server (via `.server.pid`), removes the
Postgres container, and deletes `.server.log`. Stop a foreground `make app` /
`npm run dev` with `Ctrl-C`.

If you brought things up by hand instead:

```bash
# stop the server: Ctrl-C its terminal, or kill the process
pkill -f "queueflow serve"

# remove the Postgres container (and its data)
docker rm -f qf-pg
```

Verify everything is gone:

```bash
pgrep -fl "queueflow serve" || echo "server: stopped"
docker ps --filter name=qf-pg --format '{{.Names}}' | grep -q qf-pg \
  && echo "postgres: still up" || echo "postgres: removed"
```

## Troubleshooting

**`ECONNREFUSED` / `ConnectionError: Network error calling POST /api/v1/jobs`** —
the app can't reach the engine. Almost always a port mismatch: the app is aimed
at `QUEUEFLOW_URL` (default `http://localhost:8000`) but the server is running on
a different port (or isn't running at all).

```bash
pgrep -fl "queueflow serve"                 # where is the engine actually running?
curl -s localhost:8000/health               # is anything answering there?
```

Then point the app at the right port, e.g. `make app API_PORT=8055`, or set
`QUEUEFLOW_URL` in `.env`.

**`port is already allocated` when starting Postgres** — another container/process
holds it. Pick a free one: `make demo PG_PORT=5440 …` (remember to reuse that
`PG_PORT` for `make down`).

**`.ONESHELL` / make syntax errors** — the `Makefile` is written for the GNU Make
3.81 that ships with macOS; no special version is required.

## The vendored SDK (`@queueflow/sdk`)

This example talks to QueueFlow through [`@queueflow/sdk`](./vendor/queueflow-sdk-nodejs),
vendored under [`vendor/`](./vendor/queueflow-sdk-nodejs) so the repo builds without
any external package. It's a typed, zero-runtime-dependency ESM client (uses the
built-in `fetch`, Node ≥ 18). The shape used here:

```ts
import { QueueFlow, wf } from "@queueflow/sdk";

const qf = new QueueFlow({
  baseUrl: "http://localhost:8000",
  token: process.env.QUEUEFLOW_TOKEN ?? "dev",
});

// Enqueue a job (idempotently, optionally scheduled) and wait for the result.
const job = await qf.jobs.create({
  task: "echo",
  payload: { hello: "world" },
  idempotencyKey: "hello-once",      // retries return the original job
  // runAt: new Date(Date.now() + 60_000),  // don't run before this instant
});
const done = await qf.jobs.waitFor(job.id);

// ...or follow it live over SSE instead of polling.
for await (const j of qf.jobs.watch(job.id)) console.log(j.status);

// Run handlers *in this process* via the remote worker protocol: lease,
// heartbeat while running, report complete/fail. Retries, dead-lettering,
// and workflow advancement stay server-side.
const stop = new AbortController();
await qf.worker.run("app", {
  send_welcome_email: async (job) => ({ delivered: true }),
}, { signal: stop.signal });

// Declare and run a DAG workflow.
const workflow = await qf.workflows.create(
  wf("etl")
    .step("extract", "echo")
    .step("transform", "echo", { after: ["extract"] })
    .step("load", "echo", { after: ["transform"], onFailure: "halt" }),
);
const finished = await qf.workflows.waitFor(workflow.id);
```

| Namespace | Methods |
| --- | --- |
| `qf.jobs` | `create` · `enqueue` · `createBatch` · `get` · `list` · `cancel` · `waitFor` · `watch` (SSE) |
| `qf.worker` | `run` · `lease` · `heartbeat` · `complete` · `fail` |
| `qf.workflows` | `create` · `get` · `list` · `cancel` · `diagram` · `waitFor` |
| `qf.system` | `stats` · `tasks` |
| top-level | `qf.health()` · `qf.ready()` |

Job creation accepts `idempotencyKey` (sent as `Idempotency-Key`; replays
return the original job) and `runAt` (create now, run later). List calls accept
`includeTotal: true` to get the exact `total` — it's opt-in because the count
costs an extra query. `wf(name).step(name, task, { after, onFailure
}).context({...})` builds a DAG; `.build()` runs locally first, so duplicate
names, dangling deps, and cycles throw early. Errors extend `QueueFlowError` —
`ApiError` subclasses cover HTTP status (`BadRequestError` 400,
`UnauthorizedError` 401, `ForbiddenError` 403, `NotFoundError` 404);
network/abort failures throw `ConnectionError`, and an exhausted `waitFor`
throws `TimeoutError`. Full reference:
[`vendor/queueflow-sdk-nodejs/README.md`](./vendor/queueflow-sdk-nodejs/README.md).

## Files

- [`src/queueflow.ts`](./src/queueflow.ts) — the shared SDK client + queue/task names.
- [`src/worker.ts`](./src/worker.ts) — the TypeScript task handlers + worker loop (remote worker protocol).
- [`src/server.ts`](./src/server.ts) — the Express routes.
- [`src/index.ts`](./src/index.ts) — startup (HTTP server + in-process worker, graceful shutdown).
- [`scripts/smoke.ts`](./scripts/smoke.ts) — end-to-end SDK smoke test.
- [`vendor/queueflow-sdk-nodejs/`](./vendor/queueflow-sdk-nodejs) — vendored copy of `@queueflow/sdk`.

## License

[MIT](./LICENSE) — same as QueueFlow and its SDKs. Copy and adapt this example freely.
