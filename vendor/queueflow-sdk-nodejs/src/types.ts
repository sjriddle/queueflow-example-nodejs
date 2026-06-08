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
  total: number;
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
