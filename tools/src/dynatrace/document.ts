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

/** An SSO user or group (a share recipient). */
export interface SsoEntity {
  id: string;
  type: string;
}

/** Everything that decides who can see a document. */
export interface SharingState {
  owner: string;
  isPrivate: boolean;
  isReshareable: boolean;
  direct: Array<{ shareId: string; access: 'read' | 'read-write'; recipients: SsoEntity[] }>;
  environment: Array<{ shareId: string; access: 'read' | 'read-write' }>;
}

/** A share's access array (`['read','write']`) as the create-share value (`'read-write'`). */
export function shareAccess(access: string[] | undefined): 'read' | 'read-write' {
  return (access ?? []).includes('write') ? 'read-write' : 'read';
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
    // `/metadata`, not the bare document path: `GET /documents/{id}` answers with
    // the multipart metadata+content body, which is not JSON. This method had no
    // callers until the notebook publish path, so the mistake was never hit.
    const res = await this.request(
      'GET',
      `/documents/${encodeURIComponent(id)}/metadata`,
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

  /**
   * Full document (metadata + parsed content) from the multipart representation
   * at `GET /documents/{id}`. With adminAccess it reads documents owned by
   * others (needs `document:documents:admin`). Used to capture the current
   * version (optimistic lock / drift) + a pre-cutover content snapshot.
   */
  async getDocumentFull(
    id: string,
    adminAccess = true
  ): Promise<{ metadata: Document; content: unknown; contentRaw: string }> {
    const res = await this.request(
      'GET',
      `/documents/${encodeURIComponent(id)}`,
      adminAccess ? { 'admin-access': 'true' } : undefined,
      '*/*'
    );
    const boundary = /boundary=(.+)$/.exec(res.contentType ?? '')?.[1];
    if (!boundary) throw new DocumentApiError(res.status, id, `expected multipart, got ${res.contentType}`);
    const parts = res.text.split('--' + boundary);
    const partBody = (name: string): string | null => {
      const p = parts.find((x) => x.includes(`name="${name}"`));
      if (!p) return null;
      const sep = p.indexOf('\r\n\r\n');
      const i = sep >= 0 ? sep + 4 : p.indexOf('\n\n') + 2;
      return p.slice(i).replace(/\r\n--\s*$/, '').trim();
    };
    const metaRaw = partBody('metadata');
    const contentRaw = partBody('content') ?? '';
    const metadata = metaRaw ? (JSON.parse(metaRaw) as Document) : ({} as Document);
    let content: unknown = contentRaw;
    try {
      content = JSON.parse(contentRaw);
    } catch {
      /* leave raw */
    }
    return { metadata, content, contentRaw };
  }

  /**
   * Update a document's content in place (multipart PATCH). With adminAccess +
   * `document:documents:{write,admin}` this updates documents owned by ANYONE —
   * the write path our cutover needs (dtctl can't do admin writes). Passes the
   * current version for optimistic locking; omit `version` to force.
   */
  async updateContent(
    id: string,
    opts: { name: string; type: string; content: unknown; version?: number; adminAccess?: boolean }
  ): Promise<{ id: string; version?: number }> {
    const contentStr = typeof opts.content === 'string' ? opts.content : JSON.stringify(opts.content);
    const fd = new FormData();
    // The name must be a plain form FIELD. It used to go in a JSON `metadata`
    // part, which the PATCH silently ignores — harmless while every caller passed
    // the name the document already had, but a notebook published as new was left
    // called "[MIGRATION REVIEW] …". Verified on nic55601: the field renames, and
    // a PATCH carrying only the field leaves content untouched.
    fd.append('name', opts.name);
    fd.append('content', new Blob([contentStr], { type: 'application/json' }), 'content.json');
    const query: Record<string, string> = {};
    if (opts.adminAccess !== false) query['admin-access'] = 'true';
    if (opts.version !== undefined) query['optimistic-locking-version'] = String(opts.version);
    const text = await this.writeMultipart('PATCH', `/documents/${encodeURIComponent(id)}`, query, fd);
    try {
      const j = JSON.parse(text) as { id?: string; version?: number };
      return { id: j.id ?? id, version: j.version };
    } catch {
      return { id };
    }
  }

  /**
   * Create a new document. `POST /documents?name=&type=` with a `content` part.
   * Returns the created id (+ version). Created private + owned by the token
   * principal; share it separately for team review.
   */
  async createDocument(opts: {
    name: string;
    type: string;
    content: unknown;
    isPrivate?: boolean;
  }): Promise<{ id: string; version?: number }> {
    const contentStr = typeof opts.content === 'string' ? opts.content : JSON.stringify(opts.content);
    const fd = new FormData();
    fd.append('content', new Blob([contentStr], { type: 'application/json' }), 'content.json');
    const query: Record<string, string> = { name: opts.name, type: opts.type };
    if (opts.isPrivate === false) query['isPrivate'] = 'false';
    const text = await this.writeMultipart('POST', '/documents', query, fd);
    const j = JSON.parse(text) as { id: string; version?: number };
    return { id: j.id, version: j.version };
  }

  /**
   * Share a document with everyone in the environment. `POST /environment-shares
   * {documentId, access}`. Default `read-write` (editable by anyone). Needs
   * `document:environment-shares:write`. A 409 (already shared) is treated as OK.
   *
   * `notify` maps to the `send-notification` query param (API default: true). We
   * default it to FALSE — bulk-staging migration copies shouldn't email the team.
   */
  async shareEnvironment(id: string, access: 'read' | 'read-write' = 'read-write', notify = false): Promise<void> {
    const url = `${this.baseUrl}/platform/document/v1/environment-shares?send-notification=${notify}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: id, access }),
    });
    if (res.ok || res.status === 409) return;
    throw new DocumentApiError(res.status, url, await res.text());
  }

  /**
   * Share a document with a specific group (or user) via a direct share.
   * `POST /direct-shares {documentId, access, recipients:[{id,type}]}`. Default
   * `read-write`. Needs `document:direct-shares:write`. 409 (already shared) is OK.
   *
   * `notify` maps to the `send-notification` query param (API default: true). We
   * default it to FALSE so bulk staging doesn't spam the review team with emails.
   */
  async shareWithGroup(
    id: string,
    groupId: string,
    access: 'read' | 'read-write' = 'read-write',
    notify = false
  ): Promise<void> {
    const url = `${this.baseUrl}/platform/document/v1/direct-shares?send-notification=${notify}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: id, access, recipients: [{ id: groupId, type: 'group' }] }),
    });
    if (res.ok || res.status === 409) return;
    throw new DocumentApiError(res.status, url, await res.text());
  }

  /**
   * Share a document with ONE user (direct share, recipient type `user`). Used to
   * give the original owner access to a notebook we published on their behalf.
   * 409 (already shared) is OK. `notify` defaults to false, as above.
   */
  async shareWithUser(
    id: string,
    userId: string,
    access: 'read' | 'read-write' = 'read-write',
    notify = false
  ): Promise<void> {
    const url = `${this.baseUrl}/platform/document/v1/direct-shares?send-notification=${notify}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId: id, access, recipients: [{ id: userId, type: 'user' }] }),
    });
    if (res.ok || res.status === 409) return;
    throw new DocumentApiError(res.status, url, await res.text());
  }

  // ─── ownership + full sharing state (endpoints per @dynatrace-sdk/client-document 1.30) ───

  /** JSON request against the Document API with Bearer auth; no retry (these are writes or cheap reads). */
  private async json(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    query: Record<string, string> = {},
    body?: unknown,
    okStatuses: number[] = [200, 201, 204]
  ): Promise<any> {
    const url = new URL(`${this.baseUrl}/platform/document/v1${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!okStatuses.includes(res.status)) throw new DocumentApiError(res.status, url.toString(), text);
    return text ? JSON.parse(text) : undefined;
  }

  /**
   * Everything that decides who can see a document: the public flag, whether
   * sharees may re-share, every direct share with its user/group recipients, and
   * every environment share. Read with admin-access so it works for any owner.
   */
  async getSharingState(id: string): Promise<SharingState> {
    const meta = await this.json('GET', `/documents/${encodeURIComponent(id)}/metadata`, { 'admin-access': 'true' });
    const filter = `documentId=='${id}'`;
    const pages = async (kind: 'direct-shares' | 'environment-shares') => {
      const all: Array<{ id: string; access: string[] }> = [];
      let pageKey: string | undefined;
      do {
        const q: Record<string, string> = pageKey ? { 'page-key': pageKey } : { filter, 'admin-access': 'true' };
        const j = await this.json('GET', `/${kind}`, q);
        all.push(...(j?.[kind] ?? []));
        pageKey = j?.nextPageKey ?? undefined;
      } while (pageKey);
      return all;
    };
    const direct: SharingState['direct'] = [];
    for (const s of await pages('direct-shares')) {
      const recipients: SsoEntity[] = [];
      let pageKey: string | undefined;
      do {
        const q: Record<string, string> = pageKey ? { 'page-key': pageKey } : { 'admin-access': 'true' };
        const j = await this.json('GET', `/direct-shares/${encodeURIComponent(s.id)}/recipients`, q);
        recipients.push(...((j?.recipients ?? []) as SsoEntity[]).map((r) => ({ id: r.id, type: r.type })));
        pageKey = j?.nextPageKey ?? undefined;
      } while (pageKey);
      direct.push({ shareId: s.id, access: shareAccess(s.access), recipients });
    }
    const environment = (await pages('environment-shares')).map((s) => ({ shareId: s.id, access: shareAccess(s.access) }));
    return {
      owner: String(meta?.owner ?? ''),
      isPrivate: !!meta?.isPrivate,
      isReshareable: meta?.isReshareable !== false,
      direct,
      environment,
    };
  }

  /** Set the public / re-share flags (owner-only per the API). Multipart PATCH fields, version-locked. */
  async setSharingFlags(id: string, flags: { isPrivate: boolean; isReshareable: boolean }, version: number): Promise<void> {
    const fd = new FormData();
    fd.append('isPrivate', String(flags.isPrivate));
    fd.append('isReshareable', String(flags.isReshareable));
    await this.writeMultipart('PATCH', `/documents/${encodeURIComponent(id)}`, {
      'admin-access': 'true',
      'optimistic-locking-version': String(version),
    }, fd);
  }

  /** Create a direct share with several recipients at once. No email by default. */
  async createDirectShare(id: string, access: 'read' | 'read-write', recipients: SsoEntity[], notify = false): Promise<void> {
    await this.json('POST', '/direct-shares', { 'send-notification': String(notify) }, { documentId: id, access, recipients }, [200, 201, 409]);
  }

  /** Delete a direct share (revokes all its recipients). 404 is OK. */
  async deleteDirectShare(shareId: string): Promise<void> {
    await this.json('DELETE', `/direct-shares/${encodeURIComponent(shareId)}`, { 'admin-access': 'true' }, undefined, [204, 404]);
  }

  /**
   * Transfer ownership. Per the API the previous owner LOSES access; this tool
   * keeps working on the document only through admin-access. No email by default.
   */
  async transferOwner(id: string, newOwnerId: string, notify = false): Promise<void> {
    await this.json(
      'POST',
      `/documents/${encodeURIComponent(id)}:transfer-owner`,
      { 'admin-access': 'true', 'send-notification': String(notify) },
      { newOwnerId },
      [204]
    );
  }

  /** List the shares of one kind (`direct-shares` | `environment-shares`) for a document. */
  async listShares(
    kind: 'direct-shares' | 'environment-shares',
    documentId: string
  ): Promise<Array<{ id: string; access: string[] }>> {
    const url = new URL(`${this.baseUrl}/platform/document/v1/${kind}`);
    url.searchParams.set('filter', `documentId=='${documentId}'`);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new DocumentApiError(res.status, url.toString(), await res.text());
    const j = JSON.parse(await res.text()) as Record<string, Array<{ id: string; access: string[] }>>;
    return j[kind] ?? [];
  }

  /** Remove an environment-wide share by its share id (no-op on 404). */
  async deleteEnvironmentShare(shareId: string): Promise<void> {
    const url = `${this.baseUrl}/platform/document/v1/environment-shares/${encodeURIComponent(shareId)}`;
    const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${this.token}` } });
    if (res.ok || res.status === 404) return;
    throw new DocumentApiError(res.status, url, await res.text());
  }

  /** Delete (trash) a document. Requires the current version. */
  async deleteDocument(id: string, version: number, adminAccess = true): Promise<void> {
    const query: Record<string, string> = { 'optimistic-locking-version': String(version) };
    if (adminAccess) query['admin-access'] = 'true';
    await this.writeMultipart('DELETE', `/documents/${encodeURIComponent(id)}`, query);
  }

  /** Multipart/bodyless write (POST/PATCH/DELETE) with Bearer auth + read retry policy. */
  private async writeMultipart(
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    query: Record<string, string>,
    body?: FormData
  ): Promise<string> {
    const url = new URL(`${this.baseUrl}/platform/document/v1${path}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const res = await fetch(url, {
          method,
          headers: { Authorization: `Bearer ${this.token}` },
          ...(body ? { body } : {}),
          signal: controller.signal,
        });
        const text = await res.text();
        if (res.ok) return text;
        if ((res.status === 429 || (res.status >= 502 && res.status <= 504)) && attempt < this.maxRetries) {
          const delay = Math.min(8000, this.retryBaseMs * 2 ** attempt) + Math.random() * 250;
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
}
