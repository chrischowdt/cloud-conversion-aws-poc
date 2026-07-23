/**
 * asset-usage — which documents (dashboards / notebooks) were actually *used*
 * (opened) in the last N days, from platform audit events.
 *
 * Signal: `dt.system.events` AUDIT_EVENT GETs issued by the Dashboards /
 * Notebooks apps against the Document Service. Each open produces a
 * `GET /platform/document/v1/documents/<id>/content` audit record; we parse the
 * documentId out of `resource` and count opens per document. This is *usage*
 * (opened), not modification — the right lens for narrowing a migration to the
 * assets people still look at.
 *
 * Requires the token to have access to `dt.system.events` (Grail). If the query
 * fails (missing scope / no audit data), callers should fall back to "no
 * filter" rather than dropping everything.
 */

import { DqlClient } from '../dynatrace/dql.ts';

/** app.id values that own the two document kinds. */
export const APP_ID = {
  dashboards: 'dynatrace.dashboards',
  notebooks: 'dynatrace.notebooks',
} as const;

export interface UsageInfo {
  /** ISO timestamp of the most recent open in the window. */
  lastAccessed: string;
  /** Number of open (GET content) events in the window. */
  accessCount: number;
}

/**
 * Map of documentId → usage for documents opened via `appId` in the last
 * `days` days. One row per document.
 */
export async function fetchUsedDocumentIds(
  client: DqlClient,
  appId: string,
  days: number
): Promise<Map<string, UsageInfo>> {
  const query =
    `fetch dt.system.events, from: now()-${days}d\n` +
    `| filter event.kind == "AUDIT_EVENT" and dt.app.id == "${appId}" and event.type == "GET"\n` +
    `| filter contains(resource, "/platform/document/v1/documents/")\n` +
    `| parse resource, "LD '/documents/' LD:documentId '/'"\n` +
    `| filter isNotNull(documentId)\n` +
    `| summarize lastAccessed = max(timestamp), accessCount = count(), by: {documentId}`;

  const res = await client.query({ query, maxResultRecords: 100_000, fetchTimeoutSeconds: 120 });
  const map = new Map<string, UsageInfo>();
  for (const r of res.records) {
    const id = r['documentId'];
    if (typeof id !== 'string' || !id) continue;
    map.set(id, {
      lastAccessed: String(r['lastAccessed'] ?? ''),
      accessCount: Number(r['accessCount']) || 0,
    });
  }
  return map;
}
