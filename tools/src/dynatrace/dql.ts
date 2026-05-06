/**
 * Dynatrace Grail Storage Query API client (DQL).
 *
 * Endpoints:
 *   POST /platform/storage/query/v1/query:execute  — submit a DQL query.
 *                                                    Returns a full result if
 *                                                    fast, otherwise a
 *                                                    requestToken for polling.
 *   POST /platform/storage/query/v1/query:poll     — poll for results.
 *   POST /platform/storage/query/v1/query:cancel   — cancel a running query.
 *
 * Auth: Platform Token via `Authorization: Bearer <token>`.
 * Required scopes (typical):
 *   storage:metrics:read       — for `fetch metric.series` / `timeseries`
 *   storage:bizevents:read     — only if querying bizevents
 *   environment:roles:viewer   — sometimes required for env access
 *
 * Base URL must be the AppEngine host:
 *   https://<env-id>.apps.dynatrace.com
 *
 * The classic `live.dynatrace.com` host does NOT serve `/platform/...` routes.
 *
 * Designed to be portable into the Dynatrace App: pure `fetch`, no deps.
 */

export interface DqlClientOptions {
  baseUrl: string;
  token: string;
  /** Per-request HTTP timeout in ms. Default 60s. */
  timeoutMs?: number;
  /** Total polling budget in ms before giving up. Default 120s. */
  pollBudgetMs?: number;
  /** Polling interval in ms. Default 1000. */
  pollIntervalMs?: number;
  /** Retry attempts for transient HTTP errors. Default 3. */
  maxRetries?: number;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string; url: string }) => void;
}

export type DqlState =
  | 'NOT_STARTED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export interface DqlNotification {
  severity?: 'INFO' | 'WARNING' | 'ERROR' | string;
  message: string;
  notificationType?: string;
}

export interface DqlExecuteRequest {
  query: string;
  defaultTimeframeStart?: string;
  defaultTimeframeEnd?: string;
  /** Bytes scanned ceiling. Default 5_000_000_000 (5 GB). */
  scanLimitGBytes?: number;
  /** Max records returned. Default 1000. */
  maxResultRecords?: number;
  /** Server-side fetch timeout. Default 60. */
  fetchTimeoutSeconds?: number;
  /** Initial wait window (ms) before async fall-through. Default 1000. */
  requestTimeoutMilliseconds?: number;
  /** Locale; affects formatting of some result fields. */
  locale?: string;
}

export interface DqlResultMetadata {
  scannedBytes?: number;
  scannedRecords?: number;
  resourceConsumption?: { totalCpuConsumed?: number };
  /** Round-trip diagnostics from server. */
  notifications?: DqlNotification[];
  [k: string]: unknown;
}

export interface DqlResult {
  records: Record<string, unknown>[];
  types?: Array<{ indexRange?: number[]; mappings?: Record<string, { type: string }> }>;
  metadata?: DqlResultMetadata;
}

export interface DqlExecuteResponse {
  state: DqlState;
  progress?: number;
  /** Present only when state ∈ {NOT_STARTED, RUNNING}. */
  requestToken?: string;
  /** Present when state = SUCCEEDED. */
  result?: DqlResult;
  /** Server-side notifications (failures, info). */
  notifications?: DqlNotification[];
  [k: string]: unknown;
}

export class DqlError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  readonly notifications?: DqlNotification[];
  constructor(status: number, url: string, body: string, notifications?: DqlNotification[]) {
    const headline = notifications?.find((n) => n.severity === 'ERROR')?.message;
    super(
      `DQL ${status} ${url}` +
        (headline ? `: ${headline}` : `: ${body.slice(0, 500)}`)
    );
    this.name = 'DqlError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.notifications = notifications;
  }
}

export class DqlTimeoutError extends Error {
  readonly requestToken: string;
  readonly waitedMs: number;
  constructor(requestToken: string, waitedMs: number) {
    super(`DQL polling timed out after ${waitedMs}ms (requestToken=${requestToken})`);
    this.name = 'DqlTimeoutError';
    this.requestToken = requestToken;
    this.waitedMs = waitedMs;
  }
}

export class DqlClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly pollBudgetMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxRetries: number;
  private readonly onRetry?: DqlClientOptions['onRetry'];

  constructor(opts: DqlClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.pollBudgetMs = opts.pollBudgetMs ?? 120_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.onRetry = opts.onRetry;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    queryParams?: Record<string, string | undefined>
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}/platform/storage/query/v1${path}`);
    if (queryParams) {
      for (const [k, v] of Object.entries(queryParams)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const headers: Record<string, string> = {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        };
        if (method === 'POST' && body !== undefined) {
          headers['Content-Type'] = 'application/json';
        }
        const res = await fetch(url, {
          method,
          headers,
          body: method === 'POST' && body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.ok) return (text ? JSON.parse(text) : {}) as T;

        if ((res.status === 429 || (res.status >= 502 && res.status <= 504)) && attempt < this.maxRetries) {
          const retryAfter = res.headers.get('retry-after');
          const explicit = retryAfter ? parseFloat(retryAfter) * 1000 : NaN;
          const delay = Number.isFinite(explicit)
            ? explicit
            : Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
          this.onRetry?.({ attempt: attempt + 1, delayMs: delay, reason: `HTTP ${res.status}`, url: url.toString() });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        let parsed: { notifications?: DqlNotification[] } | undefined;
        try {
          parsed = text ? (JSON.parse(text) as { notifications?: DqlNotification[] }) : undefined;
        } catch {
          /* not JSON */
        }
        throw new DqlError(res.status, url.toString(), text, parsed?.notifications);
      } catch (err) {
        lastErr = err;
        if (err instanceof DqlError) throw err;
        if (attempt < this.maxRetries) {
          const delay = Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250;
          this.onRetry?.({
            attempt: attempt + 1,
            delayMs: delay,
            reason: (err as Error)?.message ?? 'network',
            url: url.toString(),
          });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /**
   * Submit a DQL query and resolve with the final result. Internally handles
   * the execute → poll lifecycle and gives up after `pollBudgetMs`.
   */
  async query(req: DqlExecuteRequest): Promise<DqlResult> {
    const initial = await this.request<DqlExecuteResponse>('POST', '/query:execute', {
      query: req.query,
      defaultTimeframeStart: req.defaultTimeframeStart,
      defaultTimeframeEnd: req.defaultTimeframeEnd,
      scanLimitGBytes: req.scanLimitGBytes,
      maxResultRecords: req.maxResultRecords,
      fetchTimeoutSeconds: req.fetchTimeoutSeconds,
      requestTimeoutMilliseconds: req.requestTimeoutMilliseconds,
      locale: req.locale,
    });

    if (initial.state === 'SUCCEEDED' && initial.result) return initial.result;
    if (initial.state === 'FAILED' || initial.state === 'CANCELLED') {
      throw new DqlError(200, '/query:execute', JSON.stringify(initial), initial.notifications);
    }

    const requestToken = initial.requestToken;
    if (!requestToken) {
      throw new DqlError(200, '/query:execute', JSON.stringify(initial), initial.notifications);
    }

    const start = Date.now();
    while (Date.now() - start < this.pollBudgetMs) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      const polled = await this.request<DqlExecuteResponse>('GET', '/query:poll', undefined, {
        'request-token': requestToken,
      });
      if (polled.state === 'SUCCEEDED' && polled.result) return polled.result;
      if (polled.state === 'FAILED' || polled.state === 'CANCELLED') {
        throw new DqlError(200, '/query:poll', JSON.stringify(polled), polled.notifications);
      }
      // RUNNING / NOT_STARTED — keep polling.
    }
    // Best-effort cancel.
    try {
      await this.request('POST', '/query:cancel', undefined, { 'request-token': requestToken });
    } catch {
      /* swallow */
    }
    throw new DqlTimeoutError(requestToken, Date.now() - start);
  }
}
