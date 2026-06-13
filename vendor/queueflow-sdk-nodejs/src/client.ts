/** The ergonomic QueueFlow client and its resource groups. */

import { Http, type HttpOptions } from "./http.js";
import { TimeoutError } from "./errors.js";
import { WorkflowBuilder } from "./workflow.js";
import {
  TERMINAL_JOB_STATUSES,
  TERMINAL_WORKFLOW_STATUSES,
  type CreateBatchJobsResponse,
  type CreateJobRequest,
  type CreateJobResponse,
  type CreateWorkflowRequest,
  type CreateWorkflowResponse,
  type HealthStatus,
  type HeartbeatResponse,
  type Job,
  type JobConfigRequest,
  type JobStatus,
  type JsonObject,
  type LeasedJob,
  type LeaseJobsResponse,
  type ListJobsResponse,
  type ListWorkflowsResponse,
  type ReadyStatus,
  type StatsSnapshot,
  type TasksResponse,
  type Workflow,
  type WorkflowDiagramResponse,
} from "./types.js";

/** Options for constructing a {@link QueueFlow} client. */
export type QueueFlowOptions = HttpOptions;

/** Ergonomic, camelCase input for enqueuing a job. */
export interface CreateJobInput {
  /** Registered task handler to invoke (e.g. `echo`, `sleep`). */
  task: string;
  /** JSON payload handed to the task handler. */
  payload?: JsonObject;
  /** Higher is dequeued first. */
  priority?: number;
  /** Max retry attempts before dead-lettering. */
  maxRetries?: number;
  /** Per-attempt timeout, in seconds. */
  timeout?: number;
  /** Override the destination queue. */
  queue?: string;
  /**
   * Makes the create idempotent per tenant (sent as `Idempotency-Key`):
   * retrying with the same key returns the original job, never a duplicate.
   */
  idempotencyKey?: string;
  /**
   * Don't run before this instant. The job is created immediately but stays
   * invisible to workers until then.
   */
  runAt?: Date | string;
}

/** Filters for the list endpoints. */
export interface ListOptions {
  status?: string;
  queue?: string;
  limit?: number;
  offset?: number;
  /** `"created_at ASC"` or `"created_at DESC"` (default DESC). */
  orderBy?: "created_at ASC" | "created_at DESC";
  /** Include the exact `total` (an extra count query server-side). */
  includeTotal?: boolean;
}

/** Options for the `waitFor` pollers. */
export interface WaitOptions {
  /** Give up after this many ms (default 60_000). Throws {@link TimeoutError}. */
  timeoutMs?: number;
  /** Delay between polls in ms (default 500). */
  intervalMs?: number;
  /** Abort the wait early. */
  signal?: AbortSignal;
}

function toJobConfigRequest(input: CreateJobInput): JobConfigRequest | undefined {
  const config: JobConfigRequest = {};
  if (input.priority !== undefined) config.priority = input.priority;
  if (input.maxRetries !== undefined) config.max_retries = input.maxRetries;
  if (input.timeout !== undefined) config.timeout = input.timeout;
  if (input.queue !== undefined) config.queue = input.queue;
  return Object.keys(config).length ? config : undefined;
}

function toCreateJobRequest(input: CreateJobInput): CreateJobRequest {
  const req: CreateJobRequest = { task_name: input.task };
  if (input.payload) req.payload = input.payload;
  const config = toJobConfigRequest(input);
  if (config) req.config = config;
  if (input.runAt !== undefined) {
    req.run_at =
      input.runAt instanceof Date ? input.runAt.toISOString() : input.runAt;
  }
  return req;
}

function listQuery(
  opts: ListOptions = {},
): Record<string, string | number | boolean | undefined> {
  return {
    status: opts.status,
    queue: opts.queue,
    limit: opts.limit,
    offset: opts.offset,
    order_by: opts.orderBy,
    include_total: opts.includeTotal ? true : undefined,
  };
}

function idempotencyHeaders(
  input: CreateJobInput,
): Record<string, string> | undefined {
  return input.idempotencyKey
    ? { "idempotency-key": input.idempotencyKey }
    : undefined;
}

/** Job lifecycle: enqueue, fetch, list, cancel, and wait for completion. */
export class JobsResource {
  constructor(private readonly http: Http) {}

  /** Enqueue a job and return its freshly-created record. */
  async create(input: CreateJobInput): Promise<Job> {
    return this.get(await this.enqueue(input));
  }

  /** Enqueue without a follow-up fetch; returns just the new job id. */
  async enqueue(input: CreateJobInput): Promise<string> {
    const { job_id } = await this.http.post<CreateJobResponse>("/api/v1/jobs", {
      body: toCreateJobRequest(input),
      headers: idempotencyHeaders(input),
      // A keyed create is replay-safe server-side, so it may be retried.
      idempotent: input.idempotencyKey !== undefined,
    });
    return job_id;
  }

  /** Enqueue up to 1000 jobs in one call. */
  createBatch(inputs: CreateJobInput[]): Promise<CreateBatchJobsResponse> {
    return this.http.post<CreateBatchJobsResponse>("/api/v1/jobs/batch", {
      body: { jobs: inputs.map(toCreateJobRequest) },
    });
  }

  get(id: string): Promise<Job> {
    return this.http.get<Job>(`/api/v1/jobs/${encodeURIComponent(id)}`);
  }

  list(opts: ListOptions = {}): Promise<ListJobsResponse> {
    return this.http.get<ListJobsResponse>("/api/v1/jobs", {
      query: listQuery(opts),
    });
  }

  cancel(id: string): Promise<void> {
    return this.http.postNoContent(
      `/api/v1/jobs/${encodeURIComponent(id)}/cancel`,
    );
  }

  /** Poll until the job reaches a terminal state (completed/failed/cancelled). */
  waitFor(id: string, opts: WaitOptions = {}): Promise<Job> {
    return poll(
      () => this.get(id),
      (job) => TERMINAL_JOB_STATUSES.has(job.status),
      id,
      "job",
      opts,
    );
  }

  /**
   * Stream a job's status changes as they happen (Server-Sent Events from
   * `GET /api/v1/jobs/{id}/events`). Yields the full job on every status
   * transition and returns once the job is terminal.
   *
   * ```ts
   * for await (const job of qf.jobs.watch(id)) console.log(job.status);
   * ```
   */
  async *watch(id: string, opts: { signal?: AbortSignal } = {}): AsyncGenerator<Job> {
    const stream = this.http.sse(
      `/api/v1/jobs/${encodeURIComponent(id)}/events`,
      opts,
    );
    for await (const event of stream) {
      if (event.event !== "status" || !event.data) continue;
      const job = JSON.parse(event.data) as Job;
      yield job;
      if (TERMINAL_JOB_STATUSES.has(job.status)) return;
    }
  }
}

/**
 * The remote worker protocol: lease jobs, heartbeat while running, report
 * completion/failure. This is how handlers written in TypeScript execute
 * QueueFlow jobs without living in the Rust server binary; retries, the
 * dead-letter queue, and workflow advancement all stay server-side.
 */
export class WorkerResource {
  constructor(private readonly http: Http) {}

  /**
   * Lease up to `maxJobs` jobs from `queue` for `leaseSecs`, long-polling up
   * to `waitSecs` when the queue is empty. Returns `[]` if nothing arrived.
   */
  lease(
    queue: string,
    opts: { maxJobs?: number; leaseSecs?: number; waitSecs?: number } = {},
  ): Promise<LeasedJob[]> {
    return this.http
      .post<LeaseJobsResponse>(
        `/api/v1/queues/${encodeURIComponent(queue)}/lease`,
        {
          body: {
            max_jobs: opts.maxJobs,
            lease_secs: opts.leaseSecs,
            wait_secs: opts.waitSecs,
          },
          // Leasing is replay-safe: a lost response only delays redelivery.
          idempotent: true,
          // Long polls must outlive the default request timeout.
          timeoutMs: ((opts.waitSecs ?? 0) + 35) * 1_000,
        },
      )
      .then((res) => res.jobs);
  }

  /**
   * Extend a lease so a still-running job is not reaped. Returns the job's
   * current status: `running` means the lease was extended; anything else
   * (e.g. `cancelled` mid-run) means it was not, and the worker should stop
   * working on the job.
   */
  heartbeat(lease: LeasedJob, extendSecs: number): Promise<JobStatus> {
    return this.http
      .post<HeartbeatResponse>(
        `/api/v1/jobs/${encodeURIComponent(lease.job.id)}/heartbeat`,
        {
          body: {
            lease_token: lease.lease_token,
            extend_secs: extendSecs,
          },
          idempotent: true,
        },
      )
      .then((res) => res.status);
  }

  /** Report success. Replaying against a finished job is a server-side no-op. */
  complete(lease: LeasedJob, result: JsonObject = {}): Promise<void> {
    return this.http.postNoContent(
      `/api/v1/jobs/${encodeURIComponent(lease.job.id)}/complete`,
      {
        body: { lease_token: lease.lease_token, result },
        idempotent: true,
      },
    );
  }

  /** Report failure; the server applies the job's retry/dead-letter policy. */
  fail(
    lease: LeasedJob,
    error: string,
    opts: { retryable?: boolean } = {},
  ): Promise<void> {
    return this.http.postNoContent(
      `/api/v1/jobs/${encodeURIComponent(lease.job.id)}/fail`,
      {
        body: {
          lease_token: lease.lease_token,
          error,
          retryable: opts.retryable ?? true,
        },
        idempotent: true,
      },
    );
  }

  /**
   * Run a worker loop: lease, dispatch to `handlers` by task name, heartbeat
   * while the handler runs, and report the outcome. Resolves when `signal`
   * aborts. Handlers should be idempotent (delivery is at-least-once).
   *
   * ```ts
   * await qf.worker.run("default", {
   *   "resize-image": async (job) => ({ resized: true }),
   * }, { signal: controller.signal });
   * ```
   */
  async run(
    queue: string,
    handlers: Record<string, (job: Job) => Promise<JsonObject>>,
    opts: { leaseSecs?: number; waitSecs?: number; signal?: AbortSignal } = {},
  ): Promise<void> {
    const leaseSecs = opts.leaseSecs ?? 30;
    const waitSecs = opts.waitSecs ?? 20;
    while (!opts.signal?.aborted) {
      let leases: LeasedJob[];
      try {
        leases = await this.lease(queue, { maxJobs: 1, leaseSecs, waitSecs });
      } catch {
        await sleep(1_000, opts.signal);
        continue;
      }
      for (const lease of leases) {
        await this.runOne(lease, handlers, leaseSecs);
      }
    }
  }

  private async runOne(
    lease: LeasedJob,
    handlers: Record<string, (job: Job) => Promise<JsonObject>>,
    leaseSecs: number,
  ): Promise<void> {
    const handler = handlers[lease.job.task_name];
    if (!handler) {
      await this.fail(lease, `no remote handler for task '${lease.job.task_name}'`, {
        retryable: false,
      });
      return;
    }
    // Heartbeat at half the lease interval while the handler runs. The
    // heartbeat doubles as a cancellation channel: a non-running status (or a
    // 409 lost-lease) means the server owns the outcome, so stop reporting.
    let leaseLost = false;
    const ticker = setInterval(() => {
      void this.heartbeat(lease, leaseSecs)
        .then((status) => {
          if (status !== "running") leaseLost = true;
        })
        .catch((err: unknown) => {
          if ((err as { status?: number }).status === 409) leaseLost = true;
        });
    }, Math.max(1, leaseSecs / 2) * 1_000);
    try {
      const result = await handler(lease.job);
      if (!leaseLost) await this.complete(lease, result);
    } catch (err) {
      if (!leaseLost) {
        await this.fail(lease, err instanceof Error ? err.message : String(err)).catch(
          () => {},
        );
      }
    } finally {
      clearInterval(ticker);
    }
  }
}

/** Workflow orchestration: create DAGs, fetch, list, cancel, diagram, wait. */
export class WorkflowsResource {
  constructor(private readonly http: Http) {}

  /** Create a workflow from a {@link WorkflowBuilder} or a raw request body. */
  async create(
    workflow: WorkflowBuilder | CreateWorkflowRequest,
  ): Promise<Workflow> {
    const body =
      workflow instanceof WorkflowBuilder ? workflow.build() : workflow;
    const { workflow_id } = await this.http.post<CreateWorkflowResponse>(
      "/api/v1/workflows",
      { body },
    );
    return this.get(workflow_id);
  }

  get(id: string): Promise<Workflow> {
    return this.http.get<Workflow>(
      `/api/v1/workflows/${encodeURIComponent(id)}`,
    );
  }

  list(opts: ListOptions = {}): Promise<ListWorkflowsResponse> {
    return this.http.get<ListWorkflowsResponse>("/api/v1/workflows", {
      query: listQuery(opts),
    });
  }

  cancel(id: string): Promise<void> {
    return this.http.postNoContent(
      `/api/v1/workflows/${encodeURIComponent(id)}/cancel`,
    );
  }

  /** Fetch the Mermaid (`graph TD`) diagram for a workflow's DAG. */
  diagram(id: string): Promise<WorkflowDiagramResponse> {
    return this.http.get<WorkflowDiagramResponse>(
      `/api/v1/workflows/${encodeURIComponent(id)}/diagram`,
    );
  }

  /** Poll until the workflow reaches a terminal state. */
  waitFor(id: string, opts: WaitOptions = {}): Promise<Workflow> {
    return poll(
      () => this.get(id),
      (w) => TERMINAL_WORKFLOW_STATUSES.has(w.status),
      id,
      "workflow",
      opts,
    );
  }
}

/** Engine introspection: counters and registered task handlers. */
export class SystemResource {
  constructor(private readonly http: Http) {}

  stats(): Promise<StatsSnapshot> {
    return this.http.get<StatsSnapshot>("/api/v1/stats");
  }

  /** Names of the task handlers registered on the server. */
  async tasks(): Promise<string[]> {
    const res = await this.http.get<TasksResponse>("/api/v1/tasks");
    return res.tasks;
  }
}

/**
 * The QueueFlow client.
 *
 * ```ts
 * const qf = new QueueFlow({ baseUrl: "http://localhost:8000", token: "dev" });
 * const job = await qf.jobs.create({ task: "echo", payload: { hi: 1 } });
 * const done = await qf.jobs.waitFor(job.id);
 * ```
 */
export class QueueFlow {
  /** The underlying transport — escape hatch for raw requests. */
  readonly http: Http;
  readonly jobs: JobsResource;
  readonly workflows: WorkflowsResource;
  readonly system: SystemResource;
  /** Remote worker protocol: lease / heartbeat / complete / fail / run. */
  readonly worker: WorkerResource;

  constructor(options: QueueFlowOptions) {
    this.http = new Http(options);
    this.jobs = new JobsResource(this.http);
    this.workflows = new WorkflowsResource(this.http);
    this.system = new SystemResource(this.http);
    this.worker = new WorkerResource(this.http);
  }

  /** Liveness probe (`GET /health`). */
  health(): Promise<HealthStatus> {
    return this.http.get<HealthStatus>("/health");
  }

  /** Readiness probe (`GET /ready`). */
  ready(): Promise<ReadyStatus> {
    return this.http.get<ReadyStatus>("/ready");
  }
}

async function poll<T>(
  fetchOne: () => Promise<T>,
  isTerminal: (value: T) => boolean,
  id: string,
  kind: string,
  opts: WaitOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (opts.signal?.aborted) {
      throw new TimeoutError(`waitFor(${kind} ${id}) aborted`, id);
    }
    const value = await fetchOne();
    if (isTerminal(value)) return value;
    if (Date.now() + intervalMs > deadline) {
      throw new TimeoutError(
        `${kind} ${id} did not reach a terminal state within ${timeoutMs}ms`,
        id,
      );
    }
    await sleep(intervalMs, opts.signal);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
