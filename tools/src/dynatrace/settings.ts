/**
 * Dynatrace Settings 2.0 API client (Platform, via the classic env-api proxy).
 *
 * Endpoint (auth: Platform Token via `Authorization: Bearer ...`):
 *   GET /platform/classic/environment-api/v2/settings/objects?schemaIds=<id>
 *
 * Used to pull Davis anomaly detectors (`builtin:davis.anomaly-detectors`),
 * whose `value.analyzer.input[]` carries the DQL query we rewrite. Other
 * settings schemas (metric events, etc.) share the same shape.
 *
 * Required scope: `settings:objects:read`.
 *
 * Portable to the Dynatrace App: pure `fetch`, no deps.
 */

export interface SettingsClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string; url: string }) => void;
}

export interface SettingsObject {
  objectId: string;
  schemaId?: string;
  summary?: string;
  value: Record<string, unknown>;
  [k: string]: unknown;
}

interface SettingsListResponse {
  totalCount?: number;
  pageSize?: number;
  nextPageKey?: string | null;
  items?: SettingsObject[];
}

export class SettingsApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`Settings API ${status} ${url}: ${body.slice(0, 500)}`);
    this.name = 'SettingsApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class SettingsClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly onRetry?: SettingsClientOptions['onRetry'];

  constructor(opts: SettingsClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.onRetry = opts.onRetry;
  }

  private async request(params: Record<string, string | undefined>): Promise<string> {
    const url = new URL(`${this.baseUrl}/platform/classic/environment-api/v2/settings/objects`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.ok) return text;
        if ((res.status === 429 || (res.status >= 502 && res.status <= 504)) && attempt < this.maxRetries) {
          const retryAfter = res.headers.get('retry-after');
          const explicit = retryAfter ? parseFloat(retryAfter) * 1000 : NaN;
          const delay = Number.isFinite(explicit)
            ? explicit
            : Math.min(8000, this.retryBaseMs * 2 ** attempt) + Math.random() * 250;
          this.onRetry?.({ attempt: attempt + 1, delayMs: delay, reason: `HTTP ${res.status}`, url: url.toString() });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        throw new SettingsApiError(res.status, url.toString(), text);
      } catch (err) {
        lastErr = err;
        if (err instanceof SettingsApiError) throw err;
        if (attempt < this.maxRetries) {
          const delay = Math.min(8000, this.retryBaseMs * 2 ** attempt) + Math.random() * 250;
          this.onRetry?.({ attempt: attempt + 1, delayMs: delay, reason: (err as Error)?.message ?? 'network', url: url.toString() });
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  /** Fetch all objects for a schema, following nextPageKey. */
  async listAllObjects(opts: {
    schemaId: string;
    pageSize?: number;
    fields?: string;
    onPage?: (received: number, total: number | undefined) => void;
  }): Promise<SettingsObject[]> {
    const all: SettingsObject[] = [];
    let pageKey: string | undefined;
    let total: number | undefined;
    do {
      // When paging, the API wants ONLY nextPageKey (other params are rejected).
      const params: Record<string, string | undefined> = pageKey
        ? { nextPageKey: pageKey }
        : {
            schemaIds: opts.schemaId,
            pageSize: String(opts.pageSize ?? 500),
            fields: opts.fields ?? 'objectId,schemaId,summary,value',
          };
      const parsed = JSON.parse(await this.request(params)) as SettingsListResponse;
      if (parsed.items) all.push(...parsed.items);
      total = parsed.totalCount;
      pageKey = parsed.nextPageKey ?? undefined;
      opts.onPage?.(all.length, total);
    } while (pageKey);
    return all;
  }
}
