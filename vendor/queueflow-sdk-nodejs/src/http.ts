/** Minimal fetch-based transport: auth, JSON, typed errors, retries. */

import { ApiError, ConnectionError, errorForStatus } from "./errors.js";
import type { ErrorBody as _ErrorBody } from "./types.js";

/** A `fetch`-compatible function. Defaults to the global `fetch` (Node 18+). */
export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface HttpOptions {
  /** Base URL of the QueueFlow server, e.g. `http://localhost:8000`. */
  baseUrl: string;
  /** Bearer token. Any non-empty token authenticates against the dev server. */
  token: string;
  /** Per-request timeout in milliseconds (default 30_000). */
  timeoutMs?: number;
  /** Times to retry idempotent requests on network / 5xx errors (default 2). */
  maxRetries?: number;
  /** Extra headers attached to every request. */
  headers?: Record<string, string>;
  /** Inject a custom fetch (tests, proxies, polyfills). */
  fetch?: FetchLike;
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Override the default timeout for this call. */
  timeoutMs?: number;
  /** Whether this call is safe to retry. Defaults to true for GET. */
  idempotent?: boolean;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([502, 503, 504]);

export class Http {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(opts: HttpOptions) {
    if (!opts.baseUrl) throw new Error("QueueFlow: `baseUrl` is required");
    if (!opts.token) throw new Error("QueueFlow: `token` is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.headers = opts.headers ?? {};
    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) {
      throw new Error(
        "QueueFlow: no global `fetch` found. Use Node >=18 or pass `fetch` in the client options.",
      );
    }
    this.fetchImpl = f;
  }

  get<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, { idempotent: true, ...opts });
  }

  post<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return this.request<T>("POST", path, opts);
  }

  /** POST that expects 204 No Content. */
  async postNoContent(path: string, opts: RequestOptions = {}): Promise<void> {
    await this.request<void>("POST", path, { ...opts, expectNoContent: true });
  }

  private async request<T>(
    method: string,
    path: string,
    opts: RequestOptions & { expectNoContent?: boolean },
  ): Promise<T> {
    const url = this.buildUrl(path, opts.query);
    const idempotent = opts.idempotent ?? method === "GET";
    const attempts = idempotent ? this.maxRetries + 1 : 1;

    let lastErr: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.once<T>(method, url, path, opts);
      } catch (err) {
        lastErr = err;
        const retryable =
          err instanceof ConnectionError ||
          (err instanceof ApiError && RETRYABLE_STATUS.has(err.status));
        if (!retryable || attempt === attempts - 1) throw err;
        await delay(backoffMs(attempt));
      }
    }
    throw lastErr;
  }

  private async once<T>(
    method: string,
    url: string,
    path: string,
    opts: RequestOptions & { expectNoContent?: boolean },
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener("abort", () => controller.abort(), {
        once: true,
      });
    }

    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      accept: "application/json",
      ...this.headers,
    };
    const init: RequestInit = { method, headers, signal: controller.signal };
    if (opts.body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, init);
    } catch (err) {
      const aborted =
        (err as { name?: string })?.name === "AbortError" ||
        controller.signal.aborted;
      throw new ConnectionError(
        aborted
          ? `Request to ${method} ${path} timed out after ${timeoutMs}ms`
          : `Network error calling ${method} ${path}`,
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      throw await this.toApiError(res, method, path);
    }

    if (opts.expectNoContent || res.status === 204) {
      return undefined as T;
    }

    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (err) {
      throw new ApiError({
        status: res.status,
        message: `Failed to parse JSON from ${method} ${path}`,
        body: text,
        request: { method, path },
      });
    }
  }

  private async toApiError(
    res: Response,
    method: string,
    path: string,
  ): Promise<ApiError> {
    let body: unknown;
    let message = `${res.status} ${res.statusText}`;
    try {
      const text = await res.text();
      if (text) {
        body = JSON.parse(text);
        const errBody = body as Partial<_ErrorBody>;
        if (errBody && typeof errBody.error === "string") {
          message = errBody.error;
        }
      }
    } catch {
      // Non-JSON error body; keep the status-line message.
    }
    return errorForStatus({
      status: res.status,
      message,
      body,
      request: { method, path },
    });
  }

  private buildUrl(
    path: string,
    query?: RequestOptions["query"],
  ): string {
    const url = new URL(this.baseUrl + path);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with a little jitter: ~100ms, 200ms, 400ms… capped 2s. */
function backoffMs(attempt: number): number {
  const base = Math.min(2_000, 100 * 2 ** attempt);
  return base + Math.floor(Math.random() * 100);
}
