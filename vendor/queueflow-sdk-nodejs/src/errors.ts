/** Typed error hierarchy for the QueueFlow SDK. */

/** Base class for every error thrown by the SDK. */
export class QueueFlowError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = "QueueFlowError";
    if (options?.cause !== undefined) {
      // `cause` is supported natively in Node 16.9+, but assign defensively.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/** A non-2xx HTTP response from the API. */
export class ApiError extends QueueFlowError {
  /** HTTP status code. */
  readonly status: number;
  /** Server-provided error message, when present. */
  readonly body?: unknown;
  /** The request method + path that failed, for debugging. */
  readonly request: { method: string; path: string };

  constructor(args: {
    status: number;
    message: string;
    body?: unknown;
    request: { method: string; path: string };
  }) {
    super(args.message);
    this.name = "ApiError";
    this.status = args.status;
    this.body = args.body;
    this.request = args.request;
  }
}

/** 401 — missing or invalid bearer token. */
export class UnauthorizedError extends ApiError {
  constructor(args: ConstructorParameters<typeof ApiError>[0]) {
    super(args);
    this.name = "UnauthorizedError";
  }
}

/** 403 — authenticated, but the resource belongs to another tenant. */
export class ForbiddenError extends ApiError {
  constructor(args: ConstructorParameters<typeof ApiError>[0]) {
    super(args);
    this.name = "ForbiddenError";
  }
}

/** 404 — no such job/workflow. */
export class NotFoundError extends ApiError {
  constructor(args: ConstructorParameters<typeof ApiError>[0]) {
    super(args);
    this.name = "NotFoundError";
  }
}

/** 400 — invalid request (e.g. a workflow dependency cycle). */
export class BadRequestError extends ApiError {
  constructor(args: ConstructorParameters<typeof ApiError>[0]) {
    super(args);
    this.name = "BadRequestError";
  }
}

/** A network failure, DNS error, or aborted request (no HTTP response). */
export class ConnectionError extends QueueFlowError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConnectionError";
  }
}

/** A `waitFor` poll that exceeded its deadline. */
export class TimeoutError extends QueueFlowError {
  /** The id of the resource being polled. */
  readonly id: string;
  constructor(message: string, id: string) {
    super(message);
    this.name = "TimeoutError";
    this.id = id;
  }
}

/** Map an HTTP status to the most specific error subclass. */
export function errorForStatus(
  args: ConstructorParameters<typeof ApiError>[0],
): ApiError {
  switch (args.status) {
    case 400:
      return new BadRequestError(args);
    case 401:
      return new UnauthorizedError(args);
    case 403:
      return new ForbiddenError(args);
    case 404:
      return new NotFoundError(args);
    default:
      return new ApiError(args);
  }
}
