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
  type Job,
  type JobConfigRequest,
  type JsonObject,
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
}

/** Filters for the list endpoints. */
export interface ListOptions {
  status?: string;
  queue?: string;
  limit?: number;
  offset?: number;
  /** `"created_at ASC"` or `"created_at DESC"` (default DESC). */
  orderBy?: "created_at ASC" | "created_at DESC";
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
  return req;
}

function listQuery(opts: ListOptions = {}): Record<string, string | number | undefined> {
  return {
    status: opts.status,
    queue: opts.queue,
    limit: opts.limit,
    offset: opts.offset,
    order_by: opts.orderBy,
  };
}

/** Job lifecycle: enqueue, fetch, list, cancel, and wait for completion. */
export class JobsResource {
  constructor(private readonly http: Http) {}

  /** Enqueue a job and return its freshly-created record. */
  async create(input: CreateJobInput): Promise<Job> {
    const { job_id } = await this.http.post<CreateJobResponse>("/api/v1/jobs", {
      body: toCreateJobRequest(input),
    });
    return this.get(job_id);
  }

  /** Enqueue without a follow-up fetch; returns just the new job id. */
  async enqueue(input: CreateJobInput): Promise<string> {
    const { job_id } = await this.http.post<CreateJobResponse>("/api/v1/jobs", {
      body: toCreateJobRequest(input),
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

  constructor(options: QueueFlowOptions) {
    this.http = new Http(options);
    this.jobs = new JobsResource(this.http);
    this.workflows = new WorkflowsResource(this.http);
    this.system = new SystemResource(this.http);
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
