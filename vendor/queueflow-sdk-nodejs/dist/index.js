// core/src/runtime.ts
var BASE_PATH = "http://localhost:8000".replace(/\/+$/, "");
var Configuration = class {
  constructor(configuration = {}) {
    this.configuration = configuration;
  }
  configuration;
  set config(configuration) {
    this.configuration = configuration;
  }
  get basePath() {
    return this.configuration.basePath != null ? this.configuration.basePath : BASE_PATH;
  }
  get fetchApi() {
    return this.configuration.fetchApi;
  }
  get middleware() {
    return this.configuration.middleware || [];
  }
  get queryParamsStringify() {
    return this.configuration.queryParamsStringify || querystring;
  }
  get username() {
    return this.configuration.username;
  }
  get password() {
    return this.configuration.password;
  }
  get apiKey() {
    const apiKey = this.configuration.apiKey;
    if (apiKey) {
      return typeof apiKey === "function" ? apiKey : () => apiKey;
    }
    return void 0;
  }
  get accessToken() {
    const accessToken = this.configuration.accessToken;
    if (accessToken) {
      return typeof accessToken === "function" ? accessToken : async () => accessToken;
    }
    return void 0;
  }
  get headers() {
    return this.configuration.headers;
  }
  get credentials() {
    return this.configuration.credentials;
  }
};
var DefaultConfig = new Configuration();
var BaseAPI = class _BaseAPI {
  constructor(configuration = DefaultConfig) {
    this.configuration = configuration;
    this.middleware = configuration.middleware;
  }
  configuration;
  static jsonRegex = new RegExp("^(:?application/json|[^;/ 	]+/[^;/ 	]+[+]json)[ 	]*(:?;.*)?$", "i");
  middleware;
  withMiddleware(...middlewares) {
    const next = this.clone();
    next.middleware = next.middleware.concat(...middlewares);
    return next;
  }
  withPreMiddleware(...preMiddlewares) {
    const middlewares = preMiddlewares.map((pre) => ({ pre }));
    return this.withMiddleware(...middlewares);
  }
  withPostMiddleware(...postMiddlewares) {
    const middlewares = postMiddlewares.map((post) => ({ post }));
    return this.withMiddleware(...middlewares);
  }
  /**
   * Check if the given MIME is a JSON MIME.
   * JSON MIME examples:
   *   application/json
   *   application/json; charset=UTF8
   *   APPLICATION/JSON
   *   application/vnd.company+json
   * @param mime - MIME (Multipurpose Internet Mail Extensions)
   * @return True if the given MIME is JSON, false otherwise.
   */
  isJsonMime(mime) {
    if (!mime) {
      return false;
    }
    return _BaseAPI.jsonRegex.test(mime);
  }
  async request(context, initOverrides) {
    const { url, init } = await this.createFetchParams(context, initOverrides);
    const response = await this.fetchApi(url, init);
    if (response && (response.status >= 200 && response.status < 300)) {
      return response;
    }
    throw new ResponseError(response, "Response returned an error code");
  }
  async createFetchParams(context, initOverrides) {
    let url = this.configuration.basePath + context.path;
    if (context.query !== void 0 && Object.keys(context.query).length !== 0) {
      url += "?" + this.configuration.queryParamsStringify(context.query);
    }
    const headers = Object.assign({}, this.configuration.headers, context.headers);
    Object.keys(headers).forEach((key) => headers[key] === void 0 ? delete headers[key] : {});
    const initOverrideFn = typeof initOverrides === "function" ? initOverrides : async () => initOverrides;
    const initParams = {
      method: context.method,
      headers,
      body: context.body,
      credentials: this.configuration.credentials
    };
    const overriddenInit = {
      ...initParams,
      ...await initOverrideFn({
        init: initParams,
        context
      })
    };
    let body;
    if (isFormData(overriddenInit.body) || overriddenInit.body instanceof URLSearchParams || isBlob(overriddenInit.body)) {
      body = overriddenInit.body;
    } else if (this.isJsonMime(headers["Content-Type"])) {
      body = JSON.stringify(overriddenInit.body);
    } else {
      body = overriddenInit.body;
    }
    const init = {
      ...overriddenInit,
      body
    };
    return { url, init };
  }
  fetchApi = async (url, init) => {
    let fetchParams = { url, init };
    for (const middleware of this.middleware) {
      if (middleware.pre) {
        fetchParams = await middleware.pre({
          fetch: this.fetchApi,
          ...fetchParams
        }) || fetchParams;
      }
    }
    let response = void 0;
    try {
      response = await (this.configuration.fetchApi || fetch)(fetchParams.url, fetchParams.init);
    } catch (e) {
      for (const middleware of this.middleware) {
        if (middleware.onError) {
          response = await middleware.onError({
            fetch: this.fetchApi,
            url: fetchParams.url,
            init: fetchParams.init,
            error: e,
            response: response ? response.clone() : void 0
          }) || response;
        }
      }
      if (response === void 0) {
        if (e instanceof Error) {
          throw new FetchError(e, "The request failed and the interceptors did not return an alternative response");
        } else {
          throw e;
        }
      }
    }
    for (const middleware of this.middleware) {
      if (middleware.post) {
        response = await middleware.post({
          fetch: this.fetchApi,
          url: fetchParams.url,
          init: fetchParams.init,
          response: response.clone()
        }) || response;
      }
    }
    return response;
  };
  /**
   * Create a shallow clone of `this` by constructing a new instance
   * and then shallow cloning data members.
   */
  clone() {
    const constructor = this.constructor;
    const next = new constructor(this.configuration);
    next.middleware = this.middleware.slice();
    return next;
  }
};
function isBlob(value) {
  return typeof Blob !== "undefined" && value instanceof Blob;
}
function isFormData(value) {
  return typeof FormData !== "undefined" && value instanceof FormData;
}
var ResponseError = class extends Error {
  constructor(response, msg) {
    super(msg);
    this.response = response;
  }
  response;
  name = "ResponseError";
};
var FetchError = class extends Error {
  constructor(cause, msg) {
    super(msg);
    this.cause = cause;
  }
  cause;
  name = "FetchError";
};
var RequiredError = class extends Error {
  constructor(field, msg) {
    super(msg);
    this.field = field;
  }
  field;
  name = "RequiredError";
};
function querystring(params, prefix = "") {
  return Object.keys(params).map((key) => querystringSingleKey(key, params[key], prefix)).filter((part) => part.length > 0).join("&");
}
function querystringSingleKey(key, value, keyPrefix = "") {
  const fullKey = keyPrefix + (keyPrefix.length ? `[${key}]` : key);
  if (value instanceof Array) {
    const multiValue = value.map((singleValue) => encodeURIComponent(String(singleValue))).join(`&${encodeURIComponent(fullKey)}=`);
    return `${encodeURIComponent(fullKey)}=${multiValue}`;
  }
  if (value instanceof Set) {
    const valueAsArray = Array.from(value);
    return querystringSingleKey(key, valueAsArray, keyPrefix);
  }
  if (value instanceof Date) {
    return `${encodeURIComponent(fullKey)}=${encodeURIComponent(value.toISOString())}`;
  }
  if (value instanceof Object) {
    return querystring(value, fullKey);
  }
  return `${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`;
}
var JSONApiResponse = class {
  constructor(raw, transformer = (jsonValue) => jsonValue) {
    this.raw = raw;
    this.transformer = transformer;
  }
  raw;
  transformer;
  async value() {
    return this.transformer(await this.raw.json());
  }
};
var VoidApiResponse = class {
  constructor(raw) {
    this.raw = raw;
  }
  raw;
  async value() {
    return void 0;
  }
};
var TextApiResponse = class {
  constructor(raw) {
    this.raw = raw;
  }
  raw;
  async value() {
    return await this.raw.text();
  }
};

// core/src/models/BackoffStrategy.ts
function BackoffStrategyFromJSON(json) {
  return BackoffStrategyFromJSONTyped(json);
}
function BackoffStrategyFromJSONTyped(json, ignoreDiscriminator) {
  return json;
}
function BackoffStrategyToJSON(value) {
  return value;
}

// core/src/models/CompleteJobRequest.ts
function CompleteJobRequestToJSON(json) {
  return CompleteJobRequestToJSONTyped(json, false);
}
function CompleteJobRequestToJSONTyped(value, ignoreDiscriminator = false) {
  if (value == null) {
    return value;
  }
  return {
    "lease_token": value["lease_token"],
    "result": value["result"]
  };
}

// core/src/models/JobConfigRequest.ts
function JobConfigRequestToJSON(json) {
  return JobConfigRequestToJSONTyped(json, false);
}
function JobConfigRequestToJSONTyped(value, ignoreDiscriminator = false) {
  if (value == null) {
    return value;
  }
  return {
    "jitter_factor": value["jitter_factor"],
    "max_retries": value["max_retries"],
    "priority": value["priority"],
    "queue": value["queue"],
    "retry_backoff": BackoffStrategyToJSON(value["retry_backoff"]),
    "retry_delay_secs": value["retry_delay_secs"],
    "retry_max_delay_secs": value["retry_max_delay_secs"],
    "timeout": value["timeout"]
  };
}

// core/src/models/CreateJobRequest.ts
function CreateJobRequestToJSON(json) {
  return CreateJobRequestToJSONTyped(json, false);
}
function CreateJobRequestToJSONTyped(value, ignoreDiscriminator = false) {
  if (value == null) {
    return value;
  }
  return {
    "config": JobConfigRequestToJSON(value["config"]),
    "payload": value["payload"],
    "run_at": value["run_at"] == null ? void 0 : value["run_at"].toISOString(),
    "task_name": value["task_name"]
  };
}

// core/src/models/CreateBatchJobsRequest.ts
function CreateBatchJobsRequestToJSON(json) {
  return CreateBatchJobsRequestToJSONTyped(json, false);
}
function CreateBatchJobsRequestToJSONTyped(value, ignoreDiscriminator = false) {
  if (value == null) {
    return value;
  }
  return {
    "jobs": value["jobs"].map(CreateJobRequestToJSON)
  };
}

// core/src/models/CreateBatchJobsResponse.ts
function CreateBatchJobsResponseFromJSON(json) {
  return CreateBatchJobsResponseFromJSONTyped(json);
}
function CreateBatchJobsResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "count": json["count"],
    "job_ids": json["job_ids"]
  };
}

// core/src/models/JobConfig.ts
function JobConfigFromJSON(json) {
  return JobConfigFromJSONTyped(json);
}
function JobConfigFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "jitter_factor": json["jitter_factor"] == null ? void 0 : json["jitter_factor"],
    "max_retries": json["max_retries"] == null ? void 0 : json["max_retries"],
    "priority": json["priority"] == null ? void 0 : json["priority"],
    "retry_backoff": json["retry_backoff"] == null ? void 0 : BackoffStrategyFromJSON(json["retry_backoff"]),
    "retry_delay_secs": json["retry_delay_secs"] == null ? void 0 : json["retry_delay_secs"],
    "retry_max_delay_secs": json["retry_max_delay_secs"] == null ? void 0 : json["retry_max_delay_secs"],
    "timeout_secs": json["timeout_secs"] == null ? void 0 : json["timeout_secs"]
  };
}
function JobConfigToJSON(json) {
  return JobConfigToJSONTyped(json, false);
}
function JobConfigToJSONTyped(value, ignoreDiscriminator = false) {
  if (value == null) {
    return value;
  }
  return {
    "jitter_factor": value["jitter_factor"],
    "max_retries": value["max_retries"],
    "priority": value["priority"],
    "retry_backoff": BackoffStrategyToJSON(value["retry_backoff"]),
    "retry_delay_secs": value["retry_delay_secs"],
    "retry_max_delay_secs": value["retry_max_delay_secs"],
    "timeout_secs": value["timeout_secs"]
  };
}

// core/src/models/CreateCronRequest.ts
function CreateCronRequestToJSON(json) {
  return CreateCronRequestToJSONTyped(json, false);
}
function CreateCronRequestToJSONTyped(value, ignoreDiscriminator = false) {
  if (value == null) {
    return value;
  }
  return {
    "config": JobConfigToJSON(value["config"]),
    "cron_expr": value["cron_expr"],
    "name": value["name"],
    "payload": value["payload"],
    "queue": value["queue"],
    "task_name": value["task_name"]
  };
}

// core/src/models/CreateCronResponse.ts
function CreateCronResponseFromJSON(json) {
  return CreateCronResponseFromJSONTyped(json);
}
function CreateCronResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "cron_id": json["cron_id"]
  };
}

// core/src/models/CreateJobResponse.ts
function CreateJobResponseFromJSON(json) {
  return CreateJobResponseFromJSONTyped(json);
}
function CreateJobResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "job_id": json["job_id"]
  };
}

// core/src/models/OnSuccess.ts
function OnSuccessFromJSON(json) {
  return OnSuccessFromJSONTyped(json);
}
function OnSuccessFromJSONTyped(json, ignoreDiscriminator) {
  return json;
}
function OnSuccessToJSON(value) {
  return value;
}

// core/src/models/OnFailure.ts
function OnFailureFromJSON(json) {
  return OnFailureFromJSONTyped(json);
}
function OnFailureFromJSONTyped(json, ignoreDiscriminator) {
  return json;
}
function OnFailureToJSON(value) {
  return value;
}

// core/src/models/WorkflowStep.ts
function WorkflowStepFromJSON(json) {
  return WorkflowStepFromJSONTyped(json);
}
function WorkflowStepFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "config": json["config"] == null ? void 0 : JobConfigFromJSON(json["config"]),
    "depends_on": json["depends_on"] == null ? void 0 : json["depends_on"],
    "metadata": json["metadata"] == null ? void 0 : json["metadata"],
    "name": json["name"],
    "on_failure": json["on_failure"] == null ? void 0 : OnFailureFromJSON(json["on_failure"]),
    "on_success": json["on_success"] == null ? void 0 : OnSuccessFromJSON(json["on_success"]),
    "payload": json["payload"] == null ? void 0 : json["payload"],
    "task_name": json["task_name"]
  };
}
function WorkflowStepToJSON(json) {
  return WorkflowStepToJSONTyped(json, false);
}
function WorkflowStepToJSONTyped(value, ignoreDiscriminator = false) {
  if (value == null) {
    return value;
  }
  return {
    "config": JobConfigToJSON(value["config"]),
    "depends_on": value["depends_on"],
    "metadata": value["metadata"],
    "name": value["name"],
    "on_failure": OnFailureToJSON(value["on_failure"]),
    "on_success": OnSuccessToJSON(value["on_success"]),
    "payload": value["payload"],
    "task_name": value["task_name"]
  };
}

// core/src/models/CreateWorkflowRequest.ts
function CreateWorkflowRequestToJSON(json) {
  return CreateWorkflowRequestToJSONTyped(json, false);
}
function CreateWorkflowRequestToJSONTyped(value, ignoreDiscriminator = false) {
  if (value == null) {
    return value;
  }
  return {
    "context": value["context"],
    "metadata": value["metadata"],
    "name": value["name"],
    "steps": value["steps"].map(WorkflowStepToJSON)
  };
}

// core/src/models/CreateWorkflowResponse.ts
function CreateWorkflowResponseFromJSON(json) {
  return CreateWorkflowResponseFromJSONTyped(json);
}
function CreateWorkflowResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "workflow_id": json["workflow_id"]
  };
}

// core/src/models/CronSchedule.ts
function CronScheduleFromJSON(json) {
  return CronScheduleFromJSONTyped(json);
}
function CronScheduleFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "config": json["config"] == null ? void 0 : JobConfigFromJSON(json["config"]),
    "created_at": new Date(json["created_at"]),
    "cron_expr": json["cron_expr"],
    "enabled": json["enabled"],
    "id": json["id"],
    "last_enqueued_at": json["last_enqueued_at"] == null ? void 0 : new Date(json["last_enqueued_at"]),
    "name": json["name"],
    "next_run_at": new Date(json["next_run_at"]),
    "payload": json["payload"] == null ? void 0 : json["payload"],
    "queue_name": json["queue_name"] == null ? void 0 : json["queue_name"],
    "task_name": json["task_name"],
    "tenant_id": json["tenant_id"] == null ? void 0 : json["tenant_id"]
  };
}

// core/src/models/DeadLetter.ts
function DeadLetterFromJSON(json) {
  return DeadLetterFromJSONTyped(json);
}
function DeadLetterFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "created_at": new Date(json["created_at"]),
    "error_message": json["error_message"] == null ? void 0 : json["error_message"],
    "id": json["id"],
    "job_id": json["job_id"],
    "queue_name": json["queue_name"] == null ? void 0 : json["queue_name"],
    "reason": json["reason"],
    "replay_job_id": json["replay_job_id"] == null ? void 0 : json["replay_job_id"],
    "replayed_at": json["replayed_at"] == null ? void 0 : new Date(json["replayed_at"]),
    "task_name": json["task_name"] == null ? void 0 : json["task_name"],
    "tenant_id": json["tenant_id"] == null ? void 0 : json["tenant_id"]
  };
}

// core/src/models/FailJobRequest.ts
function FailJobRequestToJSON(json) {
  return FailJobRequestToJSONTyped(json, false);
}
function FailJobRequestToJSONTyped(value, ignoreDiscriminator = false) {
  if (value == null) {
    return value;
  }
  return {
    "error": value["error"],
    "lease_token": value["lease_token"],
    "retryable": value["retryable"]
  };
}

// core/src/models/HealthStatus.ts
function HealthStatusFromJSON(json) {
  return HealthStatusFromJSONTyped(json);
}
function HealthStatusFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "status": json["status"],
    "timestamp": new Date(json["timestamp"]),
    "version": json["version"]
  };
}

// core/src/models/HeartbeatRequest.ts
function HeartbeatRequestToJSON(json) {
  return HeartbeatRequestToJSONTyped(json, false);
}
function HeartbeatRequestToJSONTyped(value, ignoreDiscriminator = false) {
  if (value == null) {
    return value;
  }
  return {
    "extend_secs": value["extend_secs"],
    "lease_token": value["lease_token"]
  };
}

// core/src/models/JobStatus.ts
function JobStatusFromJSON(json) {
  return JobStatusFromJSONTyped(json);
}
function JobStatusFromJSONTyped(json, ignoreDiscriminator) {
  return json;
}

// core/src/models/HeartbeatResponse.ts
function HeartbeatResponseFromJSON(json) {
  return HeartbeatResponseFromJSONTyped(json);
}
function HeartbeatResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "status": JobStatusFromJSON(json["status"])
  };
}

// core/src/models/Job.ts
function JobFromJSON(json) {
  return JobFromJSONTyped(json);
}
function JobFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "completed_at": json["completed_at"] == null ? void 0 : new Date(json["completed_at"]),
    "config": JobConfigFromJSON(json["config"]),
    "created_at": new Date(json["created_at"]),
    "delivery_count": json["delivery_count"] == null ? void 0 : json["delivery_count"],
    "error_message": json["error_message"] == null ? void 0 : json["error_message"],
    "id": json["id"],
    "idempotency_key": json["idempotency_key"] == null ? void 0 : json["idempotency_key"],
    "metadata": json["metadata"] == null ? void 0 : json["metadata"],
    "next_retry_at": json["next_retry_at"] == null ? void 0 : new Date(json["next_retry_at"]),
    "payload": json["payload"] == null ? void 0 : json["payload"],
    "queue_name": json["queue_name"],
    "result": json["result"] == null ? void 0 : json["result"],
    "retry_count": json["retry_count"],
    "scheduled_at": new Date(json["scheduled_at"]),
    "started_at": json["started_at"] == null ? void 0 : new Date(json["started_at"]),
    "status": JobStatusFromJSON(json["status"]),
    "task_name": json["task_name"],
    "tenant_id": json["tenant_id"] == null ? void 0 : json["tenant_id"],
    "workflow_id": json["workflow_id"] == null ? void 0 : json["workflow_id"],
    "workflow_step_id": json["workflow_step_id"] == null ? void 0 : json["workflow_step_id"]
  };
}

// core/src/models/LeaseJobsRequest.ts
function LeaseJobsRequestToJSON(json) {
  return LeaseJobsRequestToJSONTyped(json, false);
}
function LeaseJobsRequestToJSONTyped(value, ignoreDiscriminator = false) {
  if (value == null) {
    return value;
  }
  return {
    "lease_secs": value["lease_secs"],
    "max_jobs": value["max_jobs"],
    "wait_secs": value["wait_secs"]
  };
}

// core/src/models/LeasedJob.ts
function LeasedJobFromJSON(json) {
  return LeasedJobFromJSONTyped(json);
}
function LeasedJobFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "job": JobFromJSON(json["job"]),
    "lease_token": json["lease_token"]
  };
}

// core/src/models/LeaseJobsResponse.ts
function LeaseJobsResponseFromJSON(json) {
  return LeaseJobsResponseFromJSONTyped(json);
}
function LeaseJobsResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "jobs": json["jobs"].map(LeasedJobFromJSON)
  };
}

// core/src/models/ListCronsResponse.ts
function ListCronsResponseFromJSON(json) {
  return ListCronsResponseFromJSONTyped(json);
}
function ListCronsResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "crons": json["crons"].map(CronScheduleFromJSON),
    "has_more": json["has_more"],
    "limit": json["limit"],
    "next_cursor": json["next_cursor"] == null ? void 0 : json["next_cursor"],
    "offset": json["offset"],
    "total": json["total"] == null ? void 0 : json["total"]
  };
}

// core/src/models/ListDeadLettersResponse.ts
function ListDeadLettersResponseFromJSON(json) {
  return ListDeadLettersResponseFromJSONTyped(json);
}
function ListDeadLettersResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "dead_letters": json["dead_letters"].map(DeadLetterFromJSON),
    "has_more": json["has_more"],
    "limit": json["limit"],
    "next_cursor": json["next_cursor"] == null ? void 0 : json["next_cursor"],
    "offset": json["offset"],
    "total": json["total"] == null ? void 0 : json["total"]
  };
}

// core/src/models/ListJobsResponse.ts
function ListJobsResponseFromJSON(json) {
  return ListJobsResponseFromJSONTyped(json);
}
function ListJobsResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "has_more": json["has_more"],
    "jobs": json["jobs"].map(JobFromJSON),
    "limit": json["limit"],
    "next_cursor": json["next_cursor"] == null ? void 0 : json["next_cursor"],
    "offset": json["offset"],
    "total": json["total"] == null ? void 0 : json["total"]
  };
}

// core/src/models/WorkflowStatus.ts
function WorkflowStatusFromJSON(json) {
  return WorkflowStatusFromJSONTyped(json);
}
function WorkflowStatusFromJSONTyped(json, ignoreDiscriminator) {
  return json;
}

// core/src/models/Workflow.ts
function WorkflowFromJSON(json) {
  return WorkflowFromJSONTyped(json);
}
function WorkflowFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "completed_at": json["completed_at"] == null ? void 0 : new Date(json["completed_at"]),
    "context": json["context"] == null ? void 0 : json["context"],
    "created_at": new Date(json["created_at"]),
    "id": json["id"],
    "metadata": json["metadata"] == null ? void 0 : json["metadata"],
    "name": json["name"],
    "started_at": json["started_at"] == null ? void 0 : new Date(json["started_at"]),
    "status": WorkflowStatusFromJSON(json["status"]),
    "steps": json["steps"].map(WorkflowStepFromJSON),
    "tenant_id": json["tenant_id"] == null ? void 0 : json["tenant_id"]
  };
}

// core/src/models/ListWorkflowsResponse.ts
function ListWorkflowsResponseFromJSON(json) {
  return ListWorkflowsResponseFromJSONTyped(json);
}
function ListWorkflowsResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "has_more": json["has_more"],
    "limit": json["limit"],
    "next_cursor": json["next_cursor"] == null ? void 0 : json["next_cursor"],
    "offset": json["offset"],
    "total": json["total"] == null ? void 0 : json["total"],
    "workflows": json["workflows"].map(WorkflowFromJSON)
  };
}

// core/src/models/ReadyStatus.ts
function ReadyStatusFromJSON(json) {
  return ReadyStatusFromJSONTyped(json);
}
function ReadyStatusFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "status": json["status"]
  };
}

// core/src/models/ReplayDeadLetterResponse.ts
function ReplayDeadLetterResponseFromJSON(json) {
  return ReplayDeadLetterResponseFromJSONTyped(json);
}
function ReplayDeadLetterResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "job_id": json["job_id"]
  };
}

// core/src/models/StatsSnapshot.ts
function StatsSnapshotFromJSON(json) {
  return StatsSnapshotFromJSONTyped(json);
}
function StatsSnapshotFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "jobs_completed": json["jobs_completed"],
    "jobs_created": json["jobs_created"],
    "jobs_dead_lettered": json["jobs_dead_lettered"],
    "jobs_failed": json["jobs_failed"],
    "jobs_retried": json["jobs_retried"],
    "workflows_completed": json["workflows_completed"],
    "workflows_created": json["workflows_created"],
    "workflows_failed": json["workflows_failed"]
  };
}

// core/src/models/StepStatus.ts
function StepStatusFromJSON(json) {
  return StepStatusFromJSONTyped(json);
}
function StepStatusFromJSONTyped(json, ignoreDiscriminator) {
  return json;
}

// core/src/models/TasksResponse.ts
function TasksResponseFromJSON(json) {
  return TasksResponseFromJSONTyped(json);
}
function TasksResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "tasks": json["tasks"]
  };
}

// core/src/models/WorkflowDiagramResponse.ts
function WorkflowDiagramResponseFromJSON(json) {
  return WorkflowDiagramResponseFromJSONTyped(json);
}
function WorkflowDiagramResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "diagram": json["diagram"],
    "format": json["format"]
  };
}

// core/src/models/WorkflowStepState.ts
function WorkflowStepStateFromJSON(json) {
  return WorkflowStepStateFromJSONTyped(json);
}
function WorkflowStepStateFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "job_id": json["job_id"] == null ? void 0 : json["job_id"],
    "name": json["name"],
    "status": StepStatusFromJSON(json["status"])
  };
}

// core/src/models/WorkflowStepStatesResponse.ts
function WorkflowStepStatesResponseFromJSON(json) {
  return WorkflowStepStatesResponseFromJSONTyped(json);
}
function WorkflowStepStatesResponseFromJSONTyped(json, ignoreDiscriminator) {
  if (json == null) {
    return json;
  }
  return {
    "steps": json["steps"].map(WorkflowStepStateFromJSON)
  };
}

// core/src/apis/JobsApi.ts
var JobsApi = class extends BaseAPI {
  /**
   */
  async cancelJobRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling cancelJob().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/jobs/{id}/cancel`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "POST",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new VoidApiResponse(response);
  }
  /**
   */
  async cancelJob(requestParameters, initOverrides) {
    await this.cancelJobRaw(requestParameters, initOverrides);
  }
  /**
   */
  async createBatchJobsRaw(requestParameters, initOverrides) {
    if (requestParameters["createBatchJobsRequest"] == null) {
      throw new RequiredError(
        "createBatchJobsRequest",
        'Required parameter "createBatchJobsRequest" was null or undefined when calling createBatchJobs().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    headerParameters["Content-Type"] = "application/json";
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/jobs/batch`,
      method: "POST",
      headers: headerParameters,
      query: queryParameters,
      body: CreateBatchJobsRequestToJSON(requestParameters["createBatchJobsRequest"])
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => CreateBatchJobsResponseFromJSON(jsonValue));
  }
  /**
   */
  async createBatchJobs(requestParameters, initOverrides) {
    const response = await this.createBatchJobsRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   */
  async createJobRaw(requestParameters, initOverrides) {
    if (requestParameters["createJobRequest"] == null) {
      throw new RequiredError(
        "createJobRequest",
        'Required parameter "createJobRequest" was null or undefined when calling createJob().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    headerParameters["Content-Type"] = "application/json";
    if (requestParameters["idempotencyKey"] != null) {
      headerParameters["Idempotency-Key"] = String(requestParameters["idempotencyKey"]);
    }
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/jobs`,
      method: "POST",
      headers: headerParameters,
      query: queryParameters,
      body: CreateJobRequestToJSON(requestParameters["createJobRequest"])
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => CreateJobResponseFromJSON(jsonValue));
  }
  /**
   */
  async createJob(requestParameters, initOverrides) {
    const response = await this.createJobRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   */
  async getJobRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling getJob().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/jobs/{id}`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => JobFromJSON(jsonValue));
  }
  /**
   */
  async getJob(requestParameters, initOverrides) {
    const response = await this.getJobRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   */
  async listJobsRaw(requestParameters, initOverrides) {
    const queryParameters = {};
    if (requestParameters["status"] != null) {
      queryParameters["status"] = requestParameters["status"];
    }
    if (requestParameters["queue"] != null) {
      queryParameters["queue"] = requestParameters["queue"];
    }
    if (requestParameters["limit"] != null) {
      queryParameters["limit"] = requestParameters["limit"];
    }
    if (requestParameters["offset"] != null) {
      queryParameters["offset"] = requestParameters["offset"];
    }
    if (requestParameters["orderBy"] != null) {
      queryParameters["order_by"] = requestParameters["orderBy"];
    }
    if (requestParameters["includeTotal"] != null) {
      queryParameters["include_total"] = requestParameters["includeTotal"];
    }
    if (requestParameters["cursor"] != null) {
      queryParameters["cursor"] = requestParameters["cursor"];
    }
    if (requestParameters["createdAfter"] != null) {
      queryParameters["created_after"] = requestParameters["createdAfter"].toISOString();
    }
    if (requestParameters["createdBefore"] != null) {
      queryParameters["created_before"] = requestParameters["createdBefore"].toISOString();
    }
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/jobs`,
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => ListJobsResponseFromJSON(jsonValue));
  }
  /**
   */
  async listJobs(requestParameters = {}, initOverrides) {
    const response = await this.listJobsRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   * Stream a job\'s status transitions as Server-Sent Events until it reaches a terminal state. Lets clients await completion without polling the REST endpoint themselves.
   */
  async streamJobEventsRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling streamJobEvents().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/jobs/{id}/events`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    if (this.isJsonMime(response.headers.get("content-type"))) {
      return new JSONApiResponse(response);
    } else {
      return new TextApiResponse(response);
    }
  }
  /**
   * Stream a job\'s status transitions as Server-Sent Events until it reaches a terminal state. Lets clients await completion without polling the REST endpoint themselves.
   */
  async streamJobEvents(requestParameters, initOverrides) {
    const response = await this.streamJobEventsRaw(requestParameters, initOverrides);
    return await response.value();
  }
};

// core/src/apis/WorkflowsApi.ts
var WorkflowsApi = class extends BaseAPI {
  /**
   */
  async cancelWorkflowRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling cancelWorkflow().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/workflows/{id}/cancel`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "POST",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new VoidApiResponse(response);
  }
  /**
   */
  async cancelWorkflow(requestParameters, initOverrides) {
    await this.cancelWorkflowRaw(requestParameters, initOverrides);
  }
  /**
   */
  async createWorkflowRaw(requestParameters, initOverrides) {
    if (requestParameters["createWorkflowRequest"] == null) {
      throw new RequiredError(
        "createWorkflowRequest",
        'Required parameter "createWorkflowRequest" was null or undefined when calling createWorkflow().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    headerParameters["Content-Type"] = "application/json";
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/workflows`,
      method: "POST",
      headers: headerParameters,
      query: queryParameters,
      body: CreateWorkflowRequestToJSON(requestParameters["createWorkflowRequest"])
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => CreateWorkflowResponseFromJSON(jsonValue));
  }
  /**
   */
  async createWorkflow(requestParameters, initOverrides) {
    const response = await this.createWorkflowRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   */
  async getWorkflowRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling getWorkflow().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/workflows/{id}`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => WorkflowFromJSON(jsonValue));
  }
  /**
   */
  async getWorkflow(requestParameters, initOverrides) {
    const response = await this.getWorkflowRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   */
  async getWorkflowDiagramRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling getWorkflowDiagram().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/workflows/{id}/diagram`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => WorkflowDiagramResponseFromJSON(jsonValue));
  }
  /**
   */
  async getWorkflowDiagram(requestParameters, initOverrides) {
    const response = await this.getWorkflowDiagramRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   */
  async getWorkflowStepStatesRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling getWorkflowStepStates().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/workflows/{id}/steps`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => WorkflowStepStatesResponseFromJSON(jsonValue));
  }
  /**
   */
  async getWorkflowStepStates(requestParameters, initOverrides) {
    const response = await this.getWorkflowStepStatesRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   */
  async listWorkflowsRaw(requestParameters, initOverrides) {
    const queryParameters = {};
    if (requestParameters["status"] != null) {
      queryParameters["status"] = requestParameters["status"];
    }
    if (requestParameters["queue"] != null) {
      queryParameters["queue"] = requestParameters["queue"];
    }
    if (requestParameters["limit"] != null) {
      queryParameters["limit"] = requestParameters["limit"];
    }
    if (requestParameters["offset"] != null) {
      queryParameters["offset"] = requestParameters["offset"];
    }
    if (requestParameters["orderBy"] != null) {
      queryParameters["order_by"] = requestParameters["orderBy"];
    }
    if (requestParameters["includeTotal"] != null) {
      queryParameters["include_total"] = requestParameters["includeTotal"];
    }
    if (requestParameters["cursor"] != null) {
      queryParameters["cursor"] = requestParameters["cursor"];
    }
    if (requestParameters["createdAfter"] != null) {
      queryParameters["created_after"] = requestParameters["createdAfter"].toISOString();
    }
    if (requestParameters["createdBefore"] != null) {
      queryParameters["created_before"] = requestParameters["createdBefore"].toISOString();
    }
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/workflows`,
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => ListWorkflowsResponseFromJSON(jsonValue));
  }
  /**
   */
  async listWorkflows(requestParameters = {}, initOverrides) {
    const response = await this.listWorkflowsRaw(requestParameters, initOverrides);
    return await response.value();
  }
};

// core/src/apis/WorkerApi.ts
var WorkerApi = class extends BaseAPI {
  /**
   */
  async completeJobRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling completeJob().'
      );
    }
    if (requestParameters["completeJobRequest"] == null) {
      throw new RequiredError(
        "completeJobRequest",
        'Required parameter "completeJobRequest" was null or undefined when calling completeJob().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    headerParameters["Content-Type"] = "application/json";
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/jobs/{id}/complete`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "POST",
      headers: headerParameters,
      query: queryParameters,
      body: CompleteJobRequestToJSON(requestParameters["completeJobRequest"])
    }, initOverrides);
    return new VoidApiResponse(response);
  }
  /**
   */
  async completeJob(requestParameters, initOverrides) {
    await this.completeJobRaw(requestParameters, initOverrides);
  }
  /**
   */
  async failJobRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling failJob().'
      );
    }
    if (requestParameters["failJobRequest"] == null) {
      throw new RequiredError(
        "failJobRequest",
        'Required parameter "failJobRequest" was null or undefined when calling failJob().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    headerParameters["Content-Type"] = "application/json";
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/jobs/{id}/fail`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "POST",
      headers: headerParameters,
      query: queryParameters,
      body: FailJobRequestToJSON(requestParameters["failJobRequest"])
    }, initOverrides);
    return new VoidApiResponse(response);
  }
  /**
   */
  async failJob(requestParameters, initOverrides) {
    await this.failJobRaw(requestParameters, initOverrides);
  }
  /**
   */
  async heartbeatJobRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling heartbeatJob().'
      );
    }
    if (requestParameters["heartbeatRequest"] == null) {
      throw new RequiredError(
        "heartbeatRequest",
        'Required parameter "heartbeatRequest" was null or undefined when calling heartbeatJob().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    headerParameters["Content-Type"] = "application/json";
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/jobs/{id}/heartbeat`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "POST",
      headers: headerParameters,
      query: queryParameters,
      body: HeartbeatRequestToJSON(requestParameters["heartbeatRequest"])
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => HeartbeatResponseFromJSON(jsonValue));
  }
  /**
   */
  async heartbeatJob(requestParameters, initOverrides) {
    const response = await this.heartbeatJobRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   */
  async leaseJobsRaw(requestParameters, initOverrides) {
    if (requestParameters["queue"] == null) {
      throw new RequiredError(
        "queue",
        'Required parameter "queue" was null or undefined when calling leaseJobs().'
      );
    }
    if (requestParameters["leaseJobsRequest"] == null) {
      throw new RequiredError(
        "leaseJobsRequest",
        'Required parameter "leaseJobsRequest" was null or undefined when calling leaseJobs().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    headerParameters["Content-Type"] = "application/json";
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/queues/{queue}/lease`.replace(`{${"queue"}}`, encodeURIComponent(String(requestParameters["queue"]))),
      method: "POST",
      headers: headerParameters,
      query: queryParameters,
      body: LeaseJobsRequestToJSON(requestParameters["leaseJobsRequest"])
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => LeaseJobsResponseFromJSON(jsonValue));
  }
  /**
   */
  async leaseJobs(requestParameters, initOverrides) {
    const response = await this.leaseJobsRaw(requestParameters, initOverrides);
    return await response.value();
  }
};

// core/src/apis/SystemApi.ts
var SystemApi = class extends BaseAPI {
  /**
   */
  async getStatsRaw(initOverrides) {
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/stats`,
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => StatsSnapshotFromJSON(jsonValue));
  }
  /**
   */
  async getStats(initOverrides) {
    const response = await this.getStatsRaw(initOverrides);
    return await response.value();
  }
  /**
   */
  async listTasksRaw(initOverrides) {
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/tasks`,
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => TasksResponseFromJSON(jsonValue));
  }
  /**
   */
  async listTasks(initOverrides) {
    const response = await this.listTasksRaw(initOverrides);
    return await response.value();
  }
};

// core/src/apis/CronApi.ts
var CronApi = class extends BaseAPI {
  /**
   */
  async createCronRaw(requestParameters, initOverrides) {
    if (requestParameters["createCronRequest"] == null) {
      throw new RequiredError(
        "createCronRequest",
        'Required parameter "createCronRequest" was null or undefined when calling createCron().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    headerParameters["Content-Type"] = "application/json";
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/cron`,
      method: "POST",
      headers: headerParameters,
      query: queryParameters,
      body: CreateCronRequestToJSON(requestParameters["createCronRequest"])
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => CreateCronResponseFromJSON(jsonValue));
  }
  /**
   */
  async createCron(requestParameters, initOverrides) {
    const response = await this.createCronRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   */
  async deleteCronRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling deleteCron().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/cron/{id}`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "DELETE",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new VoidApiResponse(response);
  }
  /**
   */
  async deleteCron(requestParameters, initOverrides) {
    await this.deleteCronRaw(requestParameters, initOverrides);
  }
  /**
   */
  async getCronRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling getCron().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/cron/{id}`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => CronScheduleFromJSON(jsonValue));
  }
  /**
   */
  async getCron(requestParameters, initOverrides) {
    const response = await this.getCronRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   */
  async listCronsRaw(requestParameters, initOverrides) {
    const queryParameters = {};
    if (requestParameters["status"] != null) {
      queryParameters["status"] = requestParameters["status"];
    }
    if (requestParameters["queue"] != null) {
      queryParameters["queue"] = requestParameters["queue"];
    }
    if (requestParameters["limit"] != null) {
      queryParameters["limit"] = requestParameters["limit"];
    }
    if (requestParameters["offset"] != null) {
      queryParameters["offset"] = requestParameters["offset"];
    }
    if (requestParameters["orderBy"] != null) {
      queryParameters["order_by"] = requestParameters["orderBy"];
    }
    if (requestParameters["includeTotal"] != null) {
      queryParameters["include_total"] = requestParameters["includeTotal"];
    }
    if (requestParameters["cursor"] != null) {
      queryParameters["cursor"] = requestParameters["cursor"];
    }
    if (requestParameters["createdAfter"] != null) {
      queryParameters["created_after"] = requestParameters["createdAfter"].toISOString();
    }
    if (requestParameters["createdBefore"] != null) {
      queryParameters["created_before"] = requestParameters["createdBefore"].toISOString();
    }
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/cron`,
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => ListCronsResponseFromJSON(jsonValue));
  }
  /**
   */
  async listCrons(requestParameters = {}, initOverrides) {
    const response = await this.listCronsRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   */
  async pauseCronRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling pauseCron().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/cron/{id}/pause`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "POST",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new VoidApiResponse(response);
  }
  /**
   */
  async pauseCron(requestParameters, initOverrides) {
    await this.pauseCronRaw(requestParameters, initOverrides);
  }
  /**
   */
  async resumeCronRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling resumeCron().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/cron/{id}/resume`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "POST",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new VoidApiResponse(response);
  }
  /**
   */
  async resumeCron(requestParameters, initOverrides) {
    await this.resumeCronRaw(requestParameters, initOverrides);
  }
};

// core/src/apis/DlqApi.ts
var DlqApi = class extends BaseAPI {
  /**
   */
  async getDeadLetterRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling getDeadLetter().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/dlq/{id}`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => DeadLetterFromJSON(jsonValue));
  }
  /**
   */
  async getDeadLetter(requestParameters, initOverrides) {
    const response = await this.getDeadLetterRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   */
  async listDeadLettersRaw(requestParameters, initOverrides) {
    const queryParameters = {};
    if (requestParameters["status"] != null) {
      queryParameters["status"] = requestParameters["status"];
    }
    if (requestParameters["queue"] != null) {
      queryParameters["queue"] = requestParameters["queue"];
    }
    if (requestParameters["limit"] != null) {
      queryParameters["limit"] = requestParameters["limit"];
    }
    if (requestParameters["offset"] != null) {
      queryParameters["offset"] = requestParameters["offset"];
    }
    if (requestParameters["orderBy"] != null) {
      queryParameters["order_by"] = requestParameters["orderBy"];
    }
    if (requestParameters["includeTotal"] != null) {
      queryParameters["include_total"] = requestParameters["includeTotal"];
    }
    if (requestParameters["cursor"] != null) {
      queryParameters["cursor"] = requestParameters["cursor"];
    }
    if (requestParameters["createdAfter"] != null) {
      queryParameters["created_after"] = requestParameters["createdAfter"].toISOString();
    }
    if (requestParameters["createdBefore"] != null) {
      queryParameters["created_before"] = requestParameters["createdBefore"].toISOString();
    }
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/dlq`,
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => ListDeadLettersResponseFromJSON(jsonValue));
  }
  /**
   */
  async listDeadLetters(requestParameters = {}, initOverrides) {
    const response = await this.listDeadLettersRaw(requestParameters, initOverrides);
    return await response.value();
  }
  /**
   */
  async replayDeadLetterRaw(requestParameters, initOverrides) {
    if (requestParameters["id"] == null) {
      throw new RequiredError(
        "id",
        'Required parameter "id" was null or undefined when calling replayDeadLetter().'
      );
    }
    const queryParameters = {};
    const headerParameters = {};
    if (this.configuration && this.configuration.accessToken) {
      const token = this.configuration.accessToken;
      const tokenString = await token("bearerAuth", []);
      if (tokenString) {
        headerParameters["Authorization"] = `Bearer ${tokenString}`;
      }
    }
    const response = await this.request({
      path: `/api/v1/dlq/{id}/replay`.replace(`{${"id"}}`, encodeURIComponent(String(requestParameters["id"]))),
      method: "POST",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => ReplayDeadLetterResponseFromJSON(jsonValue));
  }
  /**
   */
  async replayDeadLetter(requestParameters, initOverrides) {
    const response = await this.replayDeadLetterRaw(requestParameters, initOverrides);
    return await response.value();
  }
};

// core/src/apis/HealthApi.ts
var HealthApi = class extends BaseAPI {
  /**
   */
  async getHealthRaw(initOverrides) {
    const queryParameters = {};
    const headerParameters = {};
    const response = await this.request({
      path: `/health`,
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => HealthStatusFromJSON(jsonValue));
  }
  /**
   */
  async getHealth(initOverrides) {
    const response = await this.getHealthRaw(initOverrides);
    return await response.value();
  }
  /**
   */
  async getReadyRaw(initOverrides) {
    const queryParameters = {};
    const headerParameters = {};
    const response = await this.request({
      path: `/ready`,
      method: "GET",
      headers: headerParameters,
      query: queryParameters
    }, initOverrides);
    return new JSONApiResponse(response, (jsonValue) => ReadyStatusFromJSON(jsonValue));
  }
  /**
   */
  async getReady(initOverrides) {
    const response = await this.getReadyRaw(initOverrides);
    return await response.value();
  }
};

// src/errors.ts
var QueueFlowError = class extends Error {
  constructor(message, options) {
    super(message);
    this.name = "QueueFlowError";
    if (options?.cause !== void 0) {
      this.cause = options.cause;
    }
  }
};
var ApiError = class extends QueueFlowError {
  /** HTTP status code. */
  status;
  /** Server-provided error body, when present. */
  body;
  /** The operation that failed, for debugging. */
  request;
  constructor(args) {
    super(args.message);
    this.name = "ApiError";
    this.status = args.status;
    this.body = args.body;
    this.request = args.request;
  }
};
var BadRequestError = class extends ApiError {
  constructor(a) {
    super(a);
    this.name = "BadRequestError";
  }
};
var UnauthorizedError = class extends ApiError {
  constructor(a) {
    super(a);
    this.name = "UnauthorizedError";
  }
};
var ForbiddenError = class extends ApiError {
  constructor(a) {
    super(a);
    this.name = "ForbiddenError";
  }
};
var NotFoundError = class extends ApiError {
  constructor(a) {
    super(a);
    this.name = "NotFoundError";
  }
};
var ConflictError = class extends ApiError {
  constructor(a) {
    super(a);
    this.name = "ConflictError";
  }
};
var ConnectionError = class extends QueueFlowError {
  constructor(message, options) {
    super(message, options);
    this.name = "ConnectionError";
  }
};
var TimeoutError = class extends QueueFlowError {
  /** The id of the resource being polled. */
  id;
  constructor(message, id) {
    super(message);
    this.name = "TimeoutError";
    this.id = id;
  }
};
var AbortError = class extends QueueFlowError {
  constructor(message) {
    super(message);
    this.name = "AbortError";
  }
};
var NonRetryableError = class extends QueueFlowError {
  retryable = false;
  constructor(message, options) {
    super(message, options);
    this.name = "NonRetryableError";
  }
};
function errorForStatus(args) {
  switch (args.status) {
    case 400:
      return new BadRequestError(args);
    case 401:
      return new UnauthorizedError(args);
    case 403:
      return new ForbiddenError(args);
    case 404:
      return new NotFoundError(args);
    case 409:
      return new ConflictError(args);
    default:
      return new ApiError(args);
  }
}
async function toQueueFlowError(err, label) {
  if (err instanceof ResponseError) {
    const res = err.response;
    let body;
    let message = `${res.status} ${res.statusText}`;
    try {
      const text = await res.text();
      if (text) {
        body = JSON.parse(text);
        const e = body;
        if (e && typeof e.error === "string") message = e.error;
      }
    } catch {
    }
    return errorForStatus({
      status: res.status,
      message,
      body,
      request: { method: label, path: "" }
    });
  }
  if (err instanceof FetchError) {
    return new ConnectionError(`Network error during ${label}`, {
      cause: err.cause
    });
  }
  if (err instanceof QueueFlowError) return err;
  return new QueueFlowError(`Unexpected error during ${label}`, { cause: err });
}

// src/workflow.ts
var WorkflowValidationError = class extends QueueFlowError {
  constructor(message) {
    super(message);
    this.name = "WorkflowValidationError";
  }
};
var WorkflowBuilder = class {
  constructor(name) {
    this.name = name;
    if (!name) throw new WorkflowValidationError("workflow name is required");
  }
  name;
  steps = [];
  _context;
  _metadata;
  /** Add a step that runs `taskName`, optionally gated on other steps. */
  step(name, taskName, options = {}) {
    const step = { name, task_name: taskName };
    if (options.after && options.after.length) step.depends_on = options.after;
    if (options.payload) step.payload = options.payload;
    if (options.config !== void 0) step.config = options.config;
    if (options.onFailure) step.on_failure = options.onFailure;
    if (options.onSuccess) step.on_success = options.onSuccess;
    if (options.metadata) step.metadata = options.metadata;
    this.steps.push(step);
    return this;
  }
  /** Seed the shared workflow context (merged into downstream `_context`). */
  context(context) {
    this._context = { ...this._context, ...context };
    return this;
  }
  metadata(metadata) {
    this._metadata = { ...this._metadata, ...metadata };
    return this;
  }
  /** Validate the DAG and produce the request body sent to the API. */
  build() {
    if (this.steps.length === 0) {
      throw new WorkflowValidationError(
        `workflow "${this.name}" has no steps`
      );
    }
    this.validate();
    const req = {
      name: this.name,
      steps: this.steps
    };
    if (this._context) req.context = this._context;
    if (this._metadata) req.metadata = this._metadata;
    return req;
  }
  validate() {
    const names = /* @__PURE__ */ new Set();
    for (const step of this.steps) {
      if (names.has(step.name)) {
        throw new WorkflowValidationError(
          `duplicate step name "${step.name}"`
        );
      }
      names.add(step.name);
    }
    for (const step of this.steps) {
      for (const dep of step.depends_on ?? []) {
        if (!names.has(dep)) {
          throw new WorkflowValidationError(
            `step "${step.name}" depends on unknown step "${dep}"`
          );
        }
      }
    }
    this.assertAcyclic();
  }
  /** Depth-first cycle detection over `depends_on` edges. */
  assertAcyclic() {
    const byName = new Map(this.steps.map((s) => [s.name, s]));
    const visiting = /* @__PURE__ */ new Set();
    const done = /* @__PURE__ */ new Set();
    const stack = [];
    const visit = (name) => {
      if (done.has(name)) return;
      if (visiting.has(name)) {
        const cycle = [...stack.slice(stack.indexOf(name)), name].join(" -> ");
        throw new WorkflowValidationError(`dependency cycle: ${cycle}`);
      }
      visiting.add(name);
      stack.push(name);
      for (const dep of byName.get(name)?.depends_on ?? []) visit(dep);
      stack.pop();
      visiting.delete(name);
      done.add(name);
    };
    for (const step of this.steps) visit(step.name);
  }
};
function wf(name) {
  return new WorkflowBuilder(name);
}

// src/client.ts
function toDate(v) {
  return v === void 0 ? void 0 : v instanceof Date ? v : new Date(v);
}
var TERMINAL_JOB_STATUSES = /* @__PURE__ */ new Set(["completed", "failed", "cancelled"]);
var TERMINAL_WORKFLOW_STATUSES = /* @__PURE__ */ new Set([
  "completed",
  "failed",
  "partially_failed",
  "cancelled"
]);
var RETRYABLE_STATUS = /* @__PURE__ */ new Set([502, 503, 504]);
var Transport = class {
  baseUrl;
  token;
  fetchImpl;
  config;
  /** Like `config`, but authenticated with the worker credential. */
  workerConfig;
  timeoutMs;
  retries;
  constructor(opts) {
    if (!opts.baseUrl) throw new Error("QueueFlow: `baseUrl` is required");
    if (!opts.token) throw new Error("QueueFlow: `token` is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 3e4;
    this.retries = opts.maxRetries ?? 2;
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error("QueueFlow: no global `fetch`; pass one in options.");
    this.fetchImpl = f;
    this.config = new Configuration({
      basePath: this.baseUrl,
      accessToken: this.token,
      fetchApi: this.fetchImpl
    });
    this.workerConfig = new Configuration({
      basePath: this.baseUrl,
      accessToken: opts.workerToken ?? this.token,
      fetchApi: this.fetchImpl
    });
  }
  initOverrides(timeoutMs) {
    const ms = timeoutMs ?? this.timeoutMs;
    return ms > 0 ? { signal: AbortSignal.timeout(ms) } : void 0;
  }
  /** Run a generated-core call with typed-error mapping and idempotent retry. */
  async call(label, fn, opts = {}) {
    const attempts = (opts.idempotent ? this.retries : 0) + 1;
    let last;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await fn(this.initOverrides(opts.timeoutMs));
      } catch (raw) {
        const err = await toQueueFlowError(raw, label);
        const retryable = err instanceof ConnectionError || err instanceof ApiError && RETRYABLE_STATUS.has(err.status);
        if (!retryable || attempt === attempts - 1) throw err;
        last = err;
        await sleep(backoffMs(attempt));
      }
    }
    throw last;
  }
};
var JobsResource = class {
  constructor(t) {
    this.t = t;
    this.api = new JobsApi(t.config);
  }
  t;
  api;
  /** Enqueue a job and return its freshly-created record. */
  async create(input) {
    return this.get(await this.enqueue(input));
  }
  /** Enqueue without a follow-up fetch; returns just the new job id. */
  async enqueue(input) {
    const res = await this.t.call(
      "createJob",
      (init) => this.api.createJob(
        { createJobRequest: toCreateJobRequest(input), idempotencyKey: input.idempotencyKey },
        init
      ),
      { idempotent: input.idempotencyKey !== void 0 }
    );
    return res.job_id;
  }
  /** Enqueue up to 1000 jobs in one call. */
  createBatch(inputs) {
    return this.t.call(
      "createBatchJobs",
      (init) => this.api.createBatchJobs(
        { createBatchJobsRequest: { jobs: inputs.map(toCreateJobRequest) } },
        init
      )
    );
  }
  get(id) {
    return this.t.call("getJob", (init) => this.api.getJob({ id }, init), {
      idempotent: true
    });
  }
  list(opts = {}) {
    return this.t.call(
      "listJobs",
      (init) => this.api.listJobs(
        {
          status: opts.status,
          queue: opts.queue,
          limit: opts.limit,
          offset: opts.offset,
          orderBy: opts.orderBy,
          includeTotal: opts.includeTotal,
          cursor: opts.cursor,
          createdAfter: toDate(opts.createdAfter),
          createdBefore: toDate(opts.createdBefore)
        },
        init
      ),
      { idempotent: true }
    );
  }
  cancel(id) {
    return this.t.call("cancelJob", (init) => this.api.cancelJob({ id }, init));
  }
  /** Poll until the job reaches a terminal state (completed/failed/cancelled). */
  waitFor(id, opts = {}) {
    return poll(() => this.get(id), (j) => TERMINAL_JOB_STATUSES.has(j.status), id, "job", opts);
  }
  /**
   * Stream a job's status changes (SSE from `/api/v1/jobs/{id}/events`). The
   * generated client returns this endpoint as an opaque `string`, so the stream
   * is hand-implemented here, but each event is decoded with the generated
   * `JobFromJSON` so the yielded shape matches `get()` exactly (dates included).
   */
  async *watch(id, opts = {}) {
    const url = `${this.t.baseUrl}/api/v1/jobs/${encodeURIComponent(id)}/events`;
    const res = await this.t.fetchImpl(url, {
      method: "GET",
      headers: { authorization: `Bearer ${this.t.token}`, accept: "text/event-stream" },
      signal: opts.signal
    });
    if (!res.ok || !res.body) {
      throw await toQueueFlowError(new ResponseError(res), "streamJobEvents");
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let event = "message";
    let data = [];
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (line === "") {
            if (data.length && event === "status") {
              const job = JobFromJSON(JSON.parse(data.join("\n")));
              yield job;
              if (TERMINAL_JOB_STATUSES.has(job.status)) return;
            }
            event = "message";
            data = [];
          } else if (line.startsWith("event:")) {
            event = line.slice(6).trim();
          } else if (line.startsWith("data:")) {
            let value2 = line.slice(5);
            if (value2.startsWith(" ")) value2 = value2.slice(1);
            data.push(value2);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
};
var WorkflowsResource = class {
  constructor(t) {
    this.t = t;
    this.api = new WorkflowsApi(t.config);
  }
  t;
  api;
  /** Create a workflow from a {@link WorkflowBuilder} or a raw request body. */
  async create(workflow) {
    const body = workflow instanceof WorkflowBuilder ? workflow.build() : workflow;
    const res = await this.t.call(
      "createWorkflow",
      (init) => this.api.createWorkflow({ createWorkflowRequest: body }, init)
    );
    return this.get(res.workflow_id);
  }
  get(id) {
    return this.t.call("getWorkflow", (init) => this.api.getWorkflow({ id }, init), {
      idempotent: true
    });
  }
  list(opts = {}) {
    return this.t.call(
      "listWorkflows",
      (init) => this.api.listWorkflows(
        {
          status: opts.status,
          queue: opts.queue,
          limit: opts.limit,
          offset: opts.offset,
          orderBy: opts.orderBy,
          includeTotal: opts.includeTotal,
          cursor: opts.cursor,
          createdAfter: toDate(opts.createdAfter),
          createdBefore: toDate(opts.createdBefore)
        },
        init
      ),
      { idempotent: true }
    );
  }
  cancel(id) {
    return this.t.call("cancelWorkflow", (init) => this.api.cancelWorkflow({ id }, init));
  }
  /** Fetch the Mermaid (`graph TD`) diagram for a workflow's DAG. */
  diagram(id) {
    return this.t.call(
      "getWorkflowDiagram",
      (init) => this.api.getWorkflowDiagram({ id }, init),
      { idempotent: true }
    );
  }
  /**
   * Runtime status of every step, in declaration order — the live progress
   * view (`get()` returns the step *definitions* only). Each entry carries
   * the step's status and, once scheduled, the id of the job executing it.
   */
  async steps(id) {
    const res = await this.t.call(
      "getWorkflowStepStates",
      (init) => this.api.getWorkflowStepStates({ id }, init),
      { idempotent: true }
    );
    return res.steps;
  }
  /** Poll until the workflow reaches a terminal state. */
  waitFor(id, opts = {}) {
    return poll(
      () => this.get(id),
      (w) => TERMINAL_WORKFLOW_STATUSES.has(w.status),
      id,
      "workflow",
      opts
    );
  }
};
var WorkerResource = class {
  constructor(t) {
    this.t = t;
    this.api = new WorkerApi(t.workerConfig);
  }
  t;
  api;
  /** Lease up to `maxJobs` jobs, long-polling up to `waitSecs` when empty. */
  async lease(queue, opts = {}) {
    const res = await this.t.call(
      "leaseJobs",
      (init) => this.api.leaseJobs(
        {
          queue,
          leaseJobsRequest: {
            max_jobs: opts.maxJobs,
            lease_secs: opts.leaseSecs,
            wait_secs: opts.waitSecs
          }
        },
        init
      ),
      // Leasing is replay-safe; a long poll must outlive the default timeout.
      { idempotent: true, timeoutMs: ((opts.waitSecs ?? 0) + 35) * 1e3 }
    );
    return res.jobs;
  }
  /** Extend a lease. Returns the job's current status (`running` = extended). */
  async heartbeat(lease, extendSecs) {
    const res = await this.t.call(
      "heartbeatJob",
      (init) => this.api.heartbeatJob(
        { id: lease.job.id, heartbeatRequest: { lease_token: lease.lease_token, extend_secs: extendSecs } },
        init
      ),
      { idempotent: true }
    );
    return res.status;
  }
  /** Report success. Replaying against a finished job is a server-side no-op. */
  complete(lease, result = {}) {
    return this.t.call(
      "completeJob",
      (init) => this.api.completeJob(
        { id: lease.job.id, completeJobRequest: { lease_token: lease.lease_token, result } },
        init
      ),
      { idempotent: true }
    );
  }
  /** Report failure; the server applies the job's retry/dead-letter policy. */
  fail(lease, error, opts = {}) {
    return this.t.call(
      "failJob",
      (init) => this.api.failJob(
        {
          id: lease.job.id,
          failJobRequest: { lease_token: lease.lease_token, error, retryable: opts.retryable ?? true }
        },
        init
      ),
      { idempotent: true }
    );
  }
  /**
   * Run a worker loop: lease, dispatch to `handlers` by task name, heartbeat
   * while the handler runs, and report the outcome. Resolves when `signal`
   * aborts; throws on 401/403 from the lease call (a wrong or missing worker
   * token cannot heal by retrying). Handlers should be idempotent (delivery
   * is at-least-once) and should honour `ctx.signal`, which aborts when the
   * job's lease is lost (cancelled mid-run or reclaimed) — from then on the
   * server owns the outcome and any further work is wasted.
   */
  async run(queue, handlers, opts = {}) {
    const leaseSecs = opts.leaseSecs ?? 30;
    const waitSecs = opts.waitSecs ?? 20;
    let failures = 0;
    while (!opts.signal?.aborted) {
      let leases;
      try {
        leases = await this.lease(queue, { maxJobs: 1, leaseSecs, waitSecs });
        failures = 0;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
          throw error;
        }
        failures += 1;
        if (opts.onError) {
          opts.onError(error);
        } else if (failures === 1 || failures % 30 === 0) {
          console.warn(
            `[queueflow] worker lease failed (${failures} consecutive): ${error.message}`
          );
        }
        await sleep(1e3, opts.signal);
        continue;
      }
      for (const lease of leases) {
        await this.runOne(lease, handlers, leaseSecs);
      }
    }
  }
  async runOne(lease, handlers, leaseSecs) {
    const handler = handlers[lease.job.task_name];
    if (!handler) {
      await this.fail(lease, `no remote handler for task '${lease.job.task_name}'`, {
        retryable: false
      }).catch(() => {
      });
      return;
    }
    const lost = new AbortController();
    const ticker = setInterval(() => {
      void this.heartbeat(lease, leaseSecs).then((status) => {
        if (status !== "running") lost.abort();
      }).catch((err) => {
        if (err.status === 409) lost.abort();
      });
    }, Math.max(1, leaseSecs / 2) * 1e3);
    let outcome;
    try {
      outcome = { ok: true, result: await handler(lease.job, { signal: lost.signal }) };
    } catch (err) {
      outcome = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        // NonRetryableError (or any error carrying `retryable: false`) sends
        // the job straight to the dead-letter queue.
        retryable: err?.retryable !== false
      };
    } finally {
      clearInterval(ticker);
    }
    if (lost.signal.aborted) return;
    const report = outcome.ok ? this.complete(lease, outcome.result) : this.fail(lease, outcome.error, { retryable: outcome.retryable });
    await report.catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[queueflow] failed to report job ${lease.job.id} outcome; the lease will expire and the server redelivers: ${msg}`
      );
    });
  }
};
var CronResource = class {
  constructor(t) {
    this.t = t;
    this.api = new CronApi(t.config);
  }
  t;
  api;
  /** Register a schedule and return its freshly-created record. */
  async create(input) {
    const res = await this.t.call(
      "createCron",
      (init) => this.api.createCron(
        {
          createCronRequest: {
            name: input.name,
            cron_expr: input.schedule,
            task_name: input.task,
            payload: input.payload,
            queue: input.queue
          }
        },
        init
      )
    );
    return this.get(res.cron_id);
  }
  list(opts = {}) {
    return this.t.call(
      "listCrons",
      (init) => this.api.listCrons(
        {
          limit: opts.limit,
          offset: opts.offset,
          orderBy: opts.orderBy,
          includeTotal: opts.includeTotal,
          cursor: opts.cursor,
          createdAfter: toDate(opts.createdAfter),
          createdBefore: toDate(opts.createdBefore)
        },
        init
      ),
      { idempotent: true }
    );
  }
  get(id) {
    return this.t.call("getCron", (init) => this.api.getCron({ id }, init), {
      idempotent: true
    });
  }
  /** Delete a schedule; already-enqueued jobs are unaffected. */
  delete(id) {
    return this.t.call("deleteCron", (init) => this.api.deleteCron({ id }, init), {
      idempotent: true
    });
  }
  /** Stop firings until {@link CronResource.resume}. */
  pause(id) {
    return this.t.call("pauseCron", (init) => this.api.pauseCron({ id }, init));
  }
  /** Resume firings at the next future occurrence (missed runs are skipped). */
  resume(id) {
    return this.t.call("resumeCron", (init) => this.api.resumeCron({ id }, init));
  }
};
var DlqResource = class {
  constructor(t) {
    this.t = t;
    this.api = new DlqApi(t.config);
  }
  t;
  api;
  list(opts = {}) {
    return this.t.call(
      "listDeadLetters",
      (init) => this.api.listDeadLetters(
        {
          queue: opts.queue,
          limit: opts.limit,
          offset: opts.offset,
          orderBy: opts.orderBy,
          includeTotal: opts.includeTotal,
          cursor: opts.cursor,
          createdAfter: toDate(opts.createdAfter),
          createdBefore: toDate(opts.createdBefore)
        },
        init
      ),
      { idempotent: true }
    );
  }
  get(id) {
    return this.t.call("getDeadLetter", (init) => this.api.getDeadLetter({ id }, init), {
      idempotent: true
    });
  }
  /**
   * Replay a dead-lettered job as a fresh, detached job; returns the new job
   * id. Each entry replays at most once (a second replay is a 409
   * {@link ConflictError}).
   */
  async replay(id) {
    const res = await this.t.call(
      "replayDeadLetter",
      (init) => this.api.replayDeadLetter({ id }, init)
    );
    return res.job_id;
  }
};
var SystemResource = class {
  constructor(t) {
    this.t = t;
    this.api = new SystemApi(t.config);
  }
  t;
  api;
  stats() {
    return this.t.call("getStats", (init) => this.api.getStats(init), { idempotent: true });
  }
  /** Names of the task handlers registered on the server. */
  async tasks() {
    const res = await this.t.call("listTasks", (init) => this.api.listTasks(init), {
      idempotent: true
    });
    return res.tasks;
  }
};
var QueueFlow = class {
  jobs;
  workflows;
  worker;
  cron;
  dlq;
  system;
  transport;
  health_;
  constructor(options) {
    const transport = new Transport(options);
    this.transport = transport;
    this.jobs = new JobsResource(transport);
    this.workflows = new WorkflowsResource(transport);
    this.worker = new WorkerResource(transport);
    this.cron = new CronResource(transport);
    this.dlq = new DlqResource(transport);
    this.system = new SystemResource(transport);
    this.health_ = new HealthApi(transport.config);
  }
  /** Liveness probe (`GET /health`). Same timeout/retry/error policy as every other call. */
  health() {
    return this.transport.call("getHealth", (init) => this.health_.getHealth(init), {
      idempotent: true
    });
  }
  /** Readiness probe (`GET /ready`). Same timeout/retry/error policy as every other call. */
  ready() {
    return this.transport.call("getReady", (init) => this.health_.getReady(init), {
      idempotent: true
    });
  }
};
function toJobConfigRequest(input) {
  const config = {};
  if (input.priority !== void 0) config.priority = input.priority;
  if (input.maxRetries !== void 0) config.max_retries = input.maxRetries;
  if (input.timeout !== void 0) config.timeout = input.timeout;
  if (input.queue !== void 0) config.queue = input.queue;
  if (input.retryBackoff !== void 0) config.retry_backoff = input.retryBackoff;
  if (input.retryDelaySecs !== void 0) config.retry_delay_secs = input.retryDelaySecs;
  if (input.retryMaxDelaySecs !== void 0) config.retry_max_delay_secs = input.retryMaxDelaySecs;
  if (input.jitterFactor !== void 0) config.jitter_factor = input.jitterFactor;
  return Object.keys(config).length ? config : void 0;
}
function toCreateJobRequest(input) {
  const req = { task_name: input.task };
  if (input.payload) req.payload = input.payload;
  const config = toJobConfigRequest(input);
  if (config) req.config = config;
  if (input.runAt !== void 0) {
    req.run_at = input.runAt instanceof Date ? input.runAt : new Date(input.runAt);
  }
  return req;
}
async function poll(fetchOne, isTerminal, id, kind, opts) {
  const timeoutMs = opts.timeoutMs ?? 6e4;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  for (; ; ) {
    if (opts.signal?.aborted) throw new AbortError(`waitFor(${kind} ${id}) aborted`);
    const value = await fetchOne();
    if (isTerminal(value)) return value;
    if (Date.now() + intervalMs > deadline) {
      throw new TimeoutError(
        `${kind} ${id} did not reach a terminal state within ${timeoutMs}ms`,
        id
      );
    }
    await sleep(intervalMs, opts.signal);
  }
}
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
function backoffMs(attempt) {
  return Math.min(2e3, 100 * 2 ** attempt) + Math.floor(Math.random() * 100);
}

export { AbortError, ApiError, BadRequestError, ConflictError, ConnectionError, CronResource, DlqResource, ForbiddenError, JobsResource, NonRetryableError, NotFoundError, QueueFlow, QueueFlowError, SystemResource, TimeoutError, UnauthorizedError, WorkerResource, WorkflowBuilder, WorkflowValidationError, WorkflowsResource, wf };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map