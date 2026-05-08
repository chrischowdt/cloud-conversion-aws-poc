/**
 * Classic Dashboards client (Environment Config API v1).
 *
 * Endpoints:
 *   GET /api/config/v1/dashboards          — list (id + metadata only)
 *   GET /api/config/v1/dashboards/{id}     — full dashboard JSON with tiles
 *
 * Auth: Environment API token (`Authorization: Api-Token <token>`).
 *
 * Note: These endpoints live on the **tenant** host
 * (https://<env-id>.live.dynatrace.com or .apps.dynatrace.com), and the
 * token format is the classic API token (`dt0c01.*`). Platform Tokens
 * (`dt0s16.*`) used as Bearer for Grail/Document services often work here
 * too via the Api-Token header — but require classic ReadConfig scope.
 *
 * If the token isn't valid for this API, the client surfaces a 401/403
 * with a hint to add `ReadConfig` scope or use a separate API token.
 */

export interface ClassicDashboardsClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface ClassicDashboardListItem {
  id: string;
  name: string;
  owner?: string;
  shared?: boolean;
  preset?: boolean;
  /** Free-form rest. */
  [k: string]: unknown;
}

export interface ClassicDashboardListResponse {
  dashboards: ClassicDashboardListItem[];
  /** Some Dynatrace tenants paginate; not always present. */
  nextPageKey?: string | null;
  totalCount?: number;
}

export class ClassicDashboardsApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`Classic Dashboards API ${status} ${url}: ${body.slice(0, 500)}`);
    this.name = 'ClassicDashboardsApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class ClassicDashboardsClient {
  private readonly baseUrl: string;
  /** Alternate URL to try if the primary returns 404 (e.g. apps→live host). */
  private readonly fallbackBaseUrl: string | null;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private fallbackInUse = false;

  constructor(opts: ClassicDashboardsClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    // Classic Config v1 endpoints are typically served from the
    // `*.live.dynatrace.com` host even on tenants that use AppEngine.
    // Auto-derive a fallback by swapping the host segment.
    this.fallbackBaseUrl = this.baseUrl.includes('.apps.dynatrace.com')
      ? this.baseUrl.replace('.apps.dynatrace.com', '.live.dynatrace.com')
      : null;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  private async get(path: string): Promise<{ status: number; text: string }> {
    // Try the primary URL first; on 404 swap to the fallback host (apps→live)
    // and remember the fallback worked so subsequent calls go straight to it.
    if (!this.fallbackInUse) {
      try {
        return await this.getFromHost(this.baseUrl, path);
      } catch (err) {
        if (
          err instanceof ClassicDashboardsApiError &&
          err.status === 404 &&
          this.fallbackBaseUrl
        ) {
          this.fallbackInUse = true;
          // fall through to retry on fallback
        } else {
          throw err;
        }
      }
    }
    if (!this.fallbackBaseUrl) {
      // No fallback available — re-issue against primary so the caller sees
      // the original error.
      return this.getFromHost(this.baseUrl, path);
    }
    return this.getFromHost(this.fallbackBaseUrl, path);
  }

  private async getFromHost(baseUrl: string, path: string): Promise<{ status: number; text: string }> {
    const url = `${baseUrl}${path}`;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            Authorization: `Api-Token ${this.token}`,
            Accept: 'application/json',
          },
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.ok) return { status: res.status, text };
        if ((res.status === 429 || (res.status >= 502 && res.status <= 504)) && attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250));
          continue;
        }
        throw new ClassicDashboardsApiError(res.status, url, text);
      } catch (err) {
        lastErr = err;
        if (err instanceof ClassicDashboardsApiError) throw err;
        if (attempt < this.maxRetries) {
          await new Promise((r) => setTimeout(r, Math.min(8000, 500 * 2 ** attempt) + Math.random() * 250));
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async listDashboards(): Promise<ClassicDashboardListItem[]> {
    const res = await this.get('/api/config/v1/dashboards');
    const body = JSON.parse(res.text) as ClassicDashboardListResponse;
    return body.dashboards ?? [];
  }

  async getDashboard(id: string): Promise<unknown> {
    const res = await this.get(`/api/config/v1/dashboards/${encodeURIComponent(id)}`);
    return JSON.parse(res.text);
  }
}
