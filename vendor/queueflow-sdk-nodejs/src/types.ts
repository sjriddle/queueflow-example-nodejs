/**
 * Wire types for the QueueFlow REST API.
 *
 * These mirror the server's JSON shapes exactly (snake_case), so a value
 * returned by the API can be used directly. The ergonomic, camelCase option
 * objects accepted by the client live in {@link ./client.ts} and are translated
 * to these shapes before they hit the wire.
 *
 * Generated reference: `spec/openapi.yaml` in the queueflow-core repo.
 */

/** Arbitrary JSON object passed to / returned from a task handler. */
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

/** Lifecycle state of a single job. */
export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "retrying"
  | "cancelled";

/** Lifecycle state of a workflow instance. */
export type WorkflowStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "partially_failed"
  | "cancelled";

/** How retry delays grow between attempts. */
export type BackoffStrategy = "fixed" | "linear" | "exponential";

/** What to do with downstream steps when a step fails. */
export type OnFailure = "halt" | "skip" | "continue";

/** Reserved for future expansion; only `continue` is meaningful today. */
export type OnSuccess = "continue";

/** Per-job execution configuration as returned by the server. All durations are seconds. */
export interface JobConfig {
  max_retries: number;
  retry_delay_secs: number;
  timeout_secs: number;
  priority: number;
  retry_max_delay_secs: number;
  retry_backoff?: BackoffStrategy;
  /** Optional jitter in 0.0..=1.0 (e.g. 0.1 => +/-10% randomization). */
  jitter_factor?: number | null;
}

/** A single unit of work. */
export interface Job {
  id: string;
  queue_name: string;
  task_name: string;
  config: JobConfig;
  status: JobStatus;
  created_at: string;
  /**
   * When the job becomes claimable: `created_at` for immediate jobs, the
   * requested `run_at` for scheduled jobs, the next backoff instant while
   * retrying.
   */
  scheduled_at: string;
  /**
   * How many times this job has been claimed by a worker. Greater than
   * `retry_count + 1` means a lease expired without a report (worker crash).
   */
  delivery_count: number;
  retry_count: number;
  payload?: JsonObject;
  result?: JsonObject | null;
  metadata?: JsonObject;
  error_message?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  next_retry_at?: string | null;
  tenant_id?: string | null;
  workflow_id?: string | null;
  /** The owning workflow step's name (steps are addressed by name). */
  workflow_step_id?: string | null;
  /** Client-supplied key that made this job's creation idempotent. */
  idempotency_key?: string | null;
}

/** A job leased to a worker, with the token needed to report on it. */
export interface LeasedJob {
  job: Job;
  /**
   * Opaque, unguessable proof of lease ownership, regenerated on every claim;
   * pass back on heartbeat/complete/fail. A stale token (the lease expired
   * and the job was reclaimed) is rejected with a 409.
   */
  lease_token: string;
}

/** A node in a workflow DAG. Steps are addressed by their unique `name`. */
export interface WorkflowStep {
  name: string;
  task_name: string;
  depends_on?: string[];
  payload?: JsonObject;
  config?: JobConfig | null;
  metadata?: JsonObject;
  on_failure?: OnFailure;
  on_success?: OnSuccess;
}

/** A workflow instance and its steps. */
export interface Workflow {
  id: string;
  name: string;
  steps: WorkflowStep[];
  status: WorkflowStatus;
  created_at: string;
  /** Accumulated step results, keyed by step name. */
  context?: JsonObject;
  metadata?: JsonObject;
  started_at?: string | null;
  completed_at?: string | null;
  tenant_id?: string | null;
}

// --- Request bodies (wire shapes) -----------------------------------------

/** Optional per-job configuration overrides (wire shape). */
export interface JobConfigRequest {
  priority?: number;
  max_retries?: number;
  /** Per-attempt timeout, in seconds. */
  timeout?: number;
  /** Override the destination queue. */
  queue?: string;
}

export interface CreateJobRequest {
  task_name: string;
  payload?: JsonObject;
  config?: JobConfigRequest | null;
  /** Don't run before this instant (RFC 3339). */
  run_at?: string;
}

export interface CreateBatchJobsRequest {
  jobs: CreateJobRequest[];
}

export interface CreateWorkflowRequest {
  name: string;
  steps: WorkflowStep[];
  context?: JsonObject;
  metadata?: JsonObject;
}

// --- Response bodies -------------------------------------------------------

export interface CreateJobResponse {
  job_id: string;
}

export interface CreateBatchJobsResponse {
  job_ids: string[];
  count: number;
}

export interface CreateWorkflowResponse {
  workflow_id: string;
}

export interface Page<T> {
  /** Exact total; only present when the request set `include_total=true`. */
  total?: number;
  limit: number;
  offset: number;
  has_more: boolean;
}

export interface ListJobsResponse extends Page<Job> {
  jobs: Job[];
}

export interface ListWorkflowsResponse extends Page<Workflow> {
  workflows: Workflow[];
}

export interface WorkflowDiagramResponse {
  /** Diagram source format. Always `mermaid` today. */
  format: string;
  /** The diagram document (Mermaid `graph TD`). */
  diagram: string;
}

export interface TasksResponse {
  tasks: string[];
}

// --- Remote worker protocol --------------------------------------------------

export interface LeaseJobsRequest {
  /** Maximum jobs to lease in one call (1..=100, default 1). */
  max_jobs?: number;
  /** Lease duration in seconds (1..=3600, default 30). Heartbeat to extend. */
  lease_secs?: number;
  /** Long-poll wait when the queue is empty, in seconds (0..=30, default 0). */
  wait_secs?: number;
}

export interface LeaseJobsResponse {
  jobs: LeasedJob[];
}

export interface CompleteJobRequest {
  /** The lease token returned by the lease call. */
  lease_token: string;
  /** Handler result, recorded on the job and merged into workflow context. */
  result?: JsonObject;
}

export interface FailJobRequest {
  /** The lease token returned by the lease call. */
  lease_token: string;
  error: string;
  /** Whether the engine may retry (default true). */
  retryable?: boolean;
}

export interface HeartbeatRequest {
  /** The lease token returned by the lease call. */
  lease_token: string;
  /** New lease duration in seconds, measured from now (1..=3600). */
  extend_secs: number;
}

export interface HeartbeatResponse {
  /**
   * The job's current status. `running` means the lease was extended;
   * anything else (e.g. `cancelled`) means it was not, and the worker should
   * stop working on the job.
   */
  status: JobStatus;
}

export interface StatsSnapshot {
  jobs_created: number;
  jobs_completed: number;
  jobs_failed: number;
  jobs_retried: number;
  jobs_dead_lettered: number;
  workflows_created: number;
  workflows_completed: number;
  workflows_failed: number;
}

export interface HealthStatus {
  status: string;
  timestamp: string;
  version: string;
}

export interface ReadyStatus {
  status: string;
}

export interface ErrorBody {
  error: string;
  timestamp: string;
}

/** Terminal job states — `waitFor` resolves once a job reaches one of these. */
export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
] as const);

/** Terminal workflow states — `waitFor` resolves once a workflow reaches one. */
export const TERMINAL_WORKFLOW_STATUSES: ReadonlySet<WorkflowStatus> = new Set([
  "completed",
  "failed",
  "partially_failed",
  "cancelled",
] as const);
