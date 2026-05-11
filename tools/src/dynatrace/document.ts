/**
 * Dynatrace Document Service API client (Platform).
 *
 * Endpoints (auth: Platform Token via `Authorization: Bearer ...`):
 *   GET  /platform/document/v1/documents          — list documents (paginated)
 *   GET  /platform/document/v1/documents/{id}     — metadata for one document
 *   GET  /platform/document/v1/documents/{id}/content — raw content body
 *
 * Required scopes:
 *   document:documents:read           — read your own documents
 *   document:documents:admin          — read everyone's (with adminAccess=true)
 *
 * Per dt-migration / cloud-migration-helper docs, dashboards (the new kind)
 * and notebooks live here as documents with `type: "dashboard"` /
 * `type: "notebook"`. Classic dashboards live in Environment Config v1.
 *
 * Designed to be portable to the Dynatrace App: pure `fetch`, no deps.
 */

export interface DocumentClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  onRetry?: (info: { attempt: number; delayMs: number; reason: string; url: string }) => void;
}

export interface Document {
  id: string;
  name: string;
  type?: string;
  owner?: string;
  modificationInfo?: { lastModifiedTime?: string; lastModifiedBy?: string };
  version?: number;
  isPrivate?: boolean;
  externalId?: string | null;
  /** Free-form additional fields surfaced by the API. */
  [k: string]: unknown;
}

export interface DocumentListResponse {
  totalCount?: number;
  count?: number;
  nextPageKey?: string | null;
  documents?: Document[];
}

export class DocumentApiError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`Document API ${status} ${url}: ${body.slice(0, 500)}`);
    this.name = 'DocumentApiError';
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export class DocumentClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly onRetry?: DocumentClientOptions['onRetry'];

  constructor(opts: DocumentClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.onRetry = opts.onRetry;
  }

  private async request(
    method: 'GET',
    path: string,
    queryParams?: Record<string, string | undefined>,
    accept = 'application/json'
  ): Promise<{ status: number; text: string; contentType: string | null }> {
    const url = new URL(`${this.baseUrl}/platform/document/v1${path}`);
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
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: accept,
          },
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.ok) {
          return { status: res.status, text, contentType: res.headers.get('content-type') };
        }
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
        throw new DocumentApiError(res.status, url.toString(), text);
      } catch (err) {
        lastErr = err;
        if (err instanceof DocumentApiError) throw err;
        if (attempt < this.maxRetries) {
          const delay = Math.min(8000, this.retryBaseMs * 2 ** attempt) + Math.random() * 250;
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
   * List documents matching a filter expression. The filter is a
   * Dynatrace document-search expression — the most useful form here is
   * `type == 'dashboard'` (or `type == 'notebook'`).
   *
   * Uses adminAccess=true by default — falls back to non-admin if the
   * token doesn't have admin scope.
   */
  async listDocuments(opts: {
    filter?: string;
    pageSize?: number;
    pageKey?: string;
    adminAccess?: boolean;
  } = {}): Promise<DocumentListResponse> {
    const params: Record<string, string | undefined> = {
      'page-size': opts.pageSize ? String(opts.pageSize) : '100',
    };
    if (opts.filter) params.filter = opts.filter;
    if (opts.pageKey) params['page-key'] = opts.pageKey;
    if (opts.adminAccess !== false) params['admin-access'] = 'true';
    const res = await this.request('GET', '/documents', params);
    return JSON.parse(res.text) as DocumentListResponse;
  }

  /**
   * Auto-paginate listDocuments. Stops when the API returns no nextPageKey.
   */
  async listAllDocuments(opts: {
    filter: string;
    pageSize?: number;
    adminAccess?: boolean;
    onPage?: (received: number, total: number | undefined) => void;
  }): Promise<Document[]> {
    const all: Document[] = [];
    let pageKey: string | undefined;
    let totalCount: number | undefined;
    do {
      const page = await this.listDocuments({
        filter: opts.filter,
        pageSize: opts.pageSize ?? 100,
        pageKey,
        adminAccess: opts.adminAccess,
      });
      if (page.documents) all.push(...page.documents);
      totalCount = page.totalCount;
      pageKey = page.nextPageKey ?? undefined;
      opts.onPage?.(all.length, totalCount);
    } while (pageKey);
    return all;
  }

  /** Get document metadata (no content). */
  async getMetadata(id: string, adminAccess = true): Promise<Document> {
    const res = await this.request(
      'GET',
      `/documents/${encodeURIComponent(id)}`,
      adminAccess ? { 'admin-access': 'true' } : undefined
    );
    return JSON.parse(res.text) as Document;
  }

  /**
   * Download the document body. Returns the parsed JSON when content-type is
   * JSON, otherwise returns the raw text. Dashboards and notebooks come back
   * as JSON.
   *
   * `adminAccess=true` is passed by default so a token with admin scope can
   * read other users' dashboards. The content endpoint, like the list
   * endpoint, refuses to return data without it when the document isn't owned
   * by the calling user.
   */
  async getContent(
    id: string,
    adminAccess = true
  ): Promise<{ raw: string; parsed: unknown; contentType: string | null }> {
    const res = await this.request(
      'GET',
      `/documents/${encodeURIComponent(id)}/content`,
      adminAccess ? { 'admin-access': 'true' } : undefined
    );
    let parsed: unknown = res.text;
    if (res.contentType?.includes('json')) {
      try {
        parsed = JSON.parse(res.text);
      } catch {
        /* leave raw */
      }
    }
    return { raw: res.text, parsed, contentType: res.contentType };
  }
}
