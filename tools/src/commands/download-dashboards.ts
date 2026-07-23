/**
 * download-dashboards — pull every dashboard from a tenant for offline
 * analysis / conversion.
 *
 * Two sources, per dt-migration / cloud-migration-helper docs:
 *   - **New dashboards** live in the Document Service. We list documents
 *     with `type == 'dashboard'` and download each one's content.
 *   - **Classic dashboards** live in Environment Config v1. We list and
 *     fetch each by ID.
 *
 * Outputs:
 *   tools/out/dashboards/new/<id>.json         — full new-dashboard JSON
 *   tools/out/dashboards/classic/<id>.json     — full classic-dashboard JSON
 *   tools/out/dashboards/manifest.json         — index with metadata + status
 *
 * If the token is missing scopes, this command surfaces 401/403 errors
 * clearly (per side) so the user can mint a token with the right scopes.
 * It still saves whatever it could fetch.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ClassicDashboardsApiError,
  ClassicDashboardsClient,
  type ClassicDashboardListItem,
} from '../dynatrace/classic-dashboards.ts';
import { DocumentApiError, DocumentClient, type Document } from '../dynatrace/document.ts';
import { DqlClient } from '../dynatrace/dql.ts';
import { OUT_DIR } from '../lib/paths.ts';
import { APP_ID, fetchUsedDocumentIds, type UsageInfo } from '../lib/asset-usage.ts';

export interface DownloadDashboardsArgs {
  baseUrl: string;
  token: string;
  outDir?: string;
  /** Skip new (Document Service) dashboards. */
  skipNew?: boolean;
  /** Skip classic (Config v1) dashboards. */
  skipClassic?: boolean;
  /** Limit how many of each kind to download (for testing). */
  limit?: number;
  /**
   * Only download NEW dashboards opened in the last N days (usage-scoped via
   * dt.system.events). Classic dashboards aren't documents, so this filter
   * doesn't apply to them.
   */
  usedWithinDays?: number;
}

interface NewEntry {
  kind: 'new';
  id: string;
  name: string;
  type?: string;
  owner?: string;
  filePath: string;
  /** Bytes of the raw content. */
  size?: number;
  status: 'ok' | 'error';
  error?: string;
  lastAccessed?: string;
  accessCount?: number;
}

interface ClassicEntry {
  kind: 'classic';
  id: string;
  name: string;
  owner?: string;
  filePath: string;
  size?: number;
  status: 'ok' | 'error';
  error?: string;
}

type Entry = NewEntry | ClassicEntry;

interface Manifest {
  generated: string;
  baseUrl: string;
  newDashboards: { fetched: number; errors: number; sourceError?: string };
  classicDashboards: { fetched: number; errors: number; sourceError?: string };
  entries: Entry[];
}

const MAX_FILENAME_LEN = 80;

/** Make a filename-safe slug from a dashboard name. */
function safeFilenameSlug(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_FILENAME_LEN);
}

export async function runDownloadDashboards(args: DownloadDashboardsArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  const dashDir = join(outDir, 'dashboards');
  const newDir = join(dashDir, 'new');
  const classicDir = join(dashDir, 'classic');
  // Fresh dump: clear the dir for each side we're about to (re)download so the
  // output reflects exactly this run — no stale/deleted or out-of-scope files.
  if (!args.skipNew) await rm(newDir, { recursive: true, force: true });
  if (!args.skipClassic) await rm(classicDir, { recursive: true, force: true });
  await mkdir(newDir, { recursive: true });
  await mkdir(classicDir, { recursive: true });

  const entries: Entry[] = [];
  const manifest: Manifest = {
    generated: new Date().toISOString(),
    baseUrl: args.baseUrl,
    newDashboards: { fetched: 0, errors: 0 },
    classicDashboards: { fetched: 0, errors: 0 },
    entries,
  };

  // ─── New dashboards ──────────────────────────────────────────
  if (!args.skipNew) {
    console.log('Listing new dashboards (Document Service)...');
    const docClient = new DocumentClient({
      baseUrl: args.baseUrl,
      token: args.token,
      onRetry: (info) =>
        console.log(`  retry ${info.attempt}: ${info.reason} (waiting ${info.delayMs.toFixed(0)}ms)`),
    });
    let listed: Document[] = [];
    try {
      listed = await docClient.listAllDocuments({
        filter: "type == 'dashboard'",
        pageSize: 100,
        onPage: (got, total) => console.log(`  ${got}/${total ?? '?'}`),
      });
    } catch (e) {
      const err = e instanceof DocumentApiError ? e : null;
      const msg =
        err?.status === 401 || err?.status === 403
          ? `Token rejected by Document API (HTTP ${err.status}). Ensure the platform token has scope ` +
            `'document:documents:read' (or 'document:documents:admin' to read other users' dashboards).`
          : (e as Error).message;
      console.log(`  new dashboards: list FAILED — ${msg}`);
      manifest.newDashboards.sourceError = msg;
    }

    // Usage scoping: keep only new dashboards opened in the last N days.
    let usage: Map<string, UsageInfo> | undefined;
    if (args.usedWithinDays && listed.length) {
      console.log(`  scoping to dashboards opened in the last ${args.usedWithinDays}d...`);
      try {
        const dql = new DqlClient({ baseUrl: args.baseUrl, token: args.token });
        usage = await fetchUsedDocumentIds(dql, APP_ID.dashboards, args.usedWithinDays);
        const before = listed.length;
        listed = listed.filter((d) => usage!.has(d.id));
        console.log(`  ${listed.length}/${before} new dashboards used in window (${usage.size} used docs seen)`);
      } catch (e) {
        console.log(`  usage query FAILED (${(e as Error).message}); downloading all new dashboards unscoped.`);
      }
    }

    const newQueue = args.limit ? listed.slice(0, args.limit) : listed;
    console.log(`  downloading ${newQueue.length} new dashboards...`);
    for (let i = 0; i < newQueue.length; i++) {
      const doc = newQueue[i]!;
      const slug = safeFilenameSlug(doc.name || doc.id);
      const fileName = `${doc.id}__${slug || 'dashboard'}.json`;
      const filePath = join(newDir, fileName);
      try {
        const content = await docClient.getContent(doc.id);
        const payload = JSON.stringify(
          {
            metadata: doc,
            content: content.parsed,
            contentType: content.contentType,
          },
          null,
          2
        );
        await writeFile(filePath, payload);
        entries.push({
          kind: 'new',
          id: doc.id,
          name: doc.name,
          type: doc.type,
          owner: doc.owner,
          filePath,
          size: payload.length,
          status: 'ok',
          lastAccessed: usage?.get(doc.id)?.lastAccessed,
          accessCount: usage?.get(doc.id)?.accessCount,
        });
        manifest.newDashboards.fetched++;
        if ((i + 1) % 25 === 0 || i === newQueue.length - 1) {
          console.log(`  ${i + 1}/${newQueue.length}`);
        }
      } catch (e) {
        const err = e instanceof DocumentApiError ? e : null;
        const msg = err ? `HTTP ${err.status}: ${err.body.slice(0, 200)}` : (e as Error).message;
        entries.push({
          kind: 'new',
          id: doc.id,
          name: doc.name,
          type: doc.type,
          owner: doc.owner,
          filePath,
          status: 'error',
          error: msg,
        });
        manifest.newDashboards.errors++;
      }
    }
    console.log(
      `  new dashboards: ${manifest.newDashboards.fetched} fetched, ${manifest.newDashboards.errors} errors`
    );
  }

  // ─── Classic dashboards ──────────────────────────────────────
  if (!args.skipClassic) {
    console.log('Listing classic dashboards (Config API v1)...');
    const classicClient = new ClassicDashboardsClient({ baseUrl: args.baseUrl, token: args.token });
    let listed: ClassicDashboardListItem[] = [];
    try {
      listed = await classicClient.listDashboards();
    } catch (e) {
      const err = e instanceof ClassicDashboardsApiError ? e : null;
      const msg =
        err?.status === 401 || err?.status === 403
          ? `Token rejected by Config v1 API (HTTP ${err.status}). The classic Dashboards API requires an ` +
            `Environment API token with 'ReadConfig' scope (Api-Token auth, not Bearer). If your platform ` +
            `token doesn't work here, mint a separate API token for classic resources.`
          : err?.status === 404
            ? `Classic Dashboards endpoint returned 404 (${err.url}). Some tenants disable the classic ` +
              `Config v1 API entirely or only expose it on the live.dynatrace.com host. Try the alternate URL ` +
              `(replace .apps.dynatrace.com with .live.dynatrace.com) if you need classic dashboards.`
            : (e as Error).message;
      console.log(`  classic dashboards: list FAILED — ${msg}`);
      manifest.classicDashboards.sourceError = msg;
    }

    const classicQueue = args.limit ? listed.slice(0, args.limit) : listed;
    console.log(`  downloading ${classicQueue.length} classic dashboards...`);
    for (let i = 0; i < classicQueue.length; i++) {
      const dash = classicQueue[i]!;
      const slug = safeFilenameSlug(dash.name || dash.id);
      const fileName = `${dash.id}__${slug || 'dashboard'}.json`;
      const filePath = join(classicDir, fileName);
      try {
        const full = await classicClient.getDashboard(dash.id);
        const payload = JSON.stringify(full, null, 2);
        await writeFile(filePath, payload);
        entries.push({
          kind: 'classic',
          id: dash.id,
          name: dash.name,
          owner: dash.owner,
          filePath,
          size: payload.length,
          status: 'ok',
        });
        manifest.classicDashboards.fetched++;
        if ((i + 1) % 25 === 0 || i === classicQueue.length - 1) {
          console.log(`  ${i + 1}/${classicQueue.length}`);
        }
      } catch (e) {
        const err = e instanceof ClassicDashboardsApiError ? e : null;
        const msg = err ? `HTTP ${err.status}: ${err.body.slice(0, 200)}` : (e as Error).message;
        entries.push({
          kind: 'classic',
          id: dash.id,
          name: dash.name,
          owner: dash.owner,
          filePath,
          status: 'error',
          error: msg,
        });
        manifest.classicDashboards.errors++;
      }
    }
    console.log(
      `  classic dashboards: ${manifest.classicDashboards.fetched} fetched, ${manifest.classicDashboards.errors} errors`
    );
  }

  const manifestPath = join(dashDir, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  console.log('');
  console.log(
    `Total: ${manifest.newDashboards.fetched} new + ${manifest.classicDashboards.fetched} classic dashboards saved.`
  );
  if (manifest.newDashboards.sourceError) {
    console.log(`  new-side list error: ${manifest.newDashboards.sourceError}`);
  }
  if (manifest.classicDashboards.sourceError) {
    console.log(`  classic-side list error: ${manifest.classicDashboards.sourceError}`);
  }
  console.log(`Manifest: ${manifestPath}`);
}
