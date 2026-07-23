/**
 * download-notebooks — pull every notebook from a tenant for offline analysis.
 *
 * Notebooks live in the Document Service with `type == 'notebook'` (same API as
 * new dashboards). Each notebook's DQL lives in `content.sections[].state.input
 * .value`. We save the same wrapper shape as download-dashboards so the scanner
 * can reuse the { metadata, content } convention.
 *
 * Outputs:
 *   <tenant>/notebooks/<id>__<slug>.json   — { metadata, content, contentType }
 *   <tenant>/notebooks/manifest.json       — index with per-notebook status
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DocumentApiError, DocumentClient, type Document } from '../dynatrace/document.ts';
import { OUT_DIR } from '../lib/paths.ts';

export interface DownloadNotebooksArgs {
  baseUrl: string;
  token: string;
  outDir?: string;
  /** Limit how many to download (for testing). */
  limit?: number;
}

interface Entry {
  id: string;
  name: string;
  owner?: string;
  filePath: string;
  size?: number;
  status: 'ok' | 'error';
  error?: string;
}

const MAX_FILENAME_LEN = 80;
function safeFilenameSlug(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_FILENAME_LEN);
}

export async function runDownloadNotebooks(args: DownloadNotebooksArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  const nbDir = join(outDir, 'notebooks');
  await mkdir(nbDir, { recursive: true });

  const client = new DocumentClient({
    baseUrl: args.baseUrl,
    token: args.token,
    onRetry: (info) =>
      console.log(`  retry ${info.attempt}: ${info.reason} (waiting ${info.delayMs.toFixed(0)}ms)`),
  });

  console.log('Listing notebooks (Document Service)...');
  let listed: Document[] = [];
  let sourceError: string | undefined;
  try {
    listed = await client.listAllDocuments({
      filter: "type == 'notebook'",
      pageSize: 100,
      onPage: (got, total) => console.log(`  ${got}/${total ?? '?'}`),
    });
  } catch (e) {
    const err = e instanceof DocumentApiError ? e : null;
    sourceError =
      err?.status === 401 || err?.status === 403
        ? `Token rejected by Document API (HTTP ${err.status}). Needs scope 'document:documents:read' ` +
          `(or 'document:documents:admin' to read other users' notebooks).`
        : (e as Error).message;
    console.log(`  notebooks: list FAILED — ${sourceError}`);
  }

  const queue = args.limit ? listed.slice(0, args.limit) : listed;
  console.log(`  downloading ${queue.length} notebooks...`);
  const entries: Entry[] = [];
  let fetched = 0;
  let errors = 0;
  for (let i = 0; i < queue.length; i++) {
    const doc = queue[i]!;
    const slug = safeFilenameSlug(doc.name || doc.id);
    const filePath = join(nbDir, `${doc.id}__${slug || 'notebook'}.json`);
    try {
      const content = await client.getContent(doc.id);
      const payload = JSON.stringify(
        { metadata: doc, content: content.parsed, contentType: content.contentType },
        null,
        2
      );
      await writeFile(filePath, payload);
      entries.push({ id: doc.id, name: doc.name, owner: doc.owner, filePath, size: payload.length, status: 'ok' });
      fetched++;
      if ((i + 1) % 50 === 0 || i === queue.length - 1) console.log(`  ${i + 1}/${queue.length}`);
    } catch (e) {
      const err = e instanceof DocumentApiError ? e : null;
      const msg = err ? `HTTP ${err.status}: ${err.body.slice(0, 200)}` : (e as Error).message;
      entries.push({ id: doc.id, name: doc.name, owner: doc.owner, filePath, status: 'error', error: msg });
      errors++;
    }
  }

  const manifestPath = join(nbDir, 'manifest.json');
  await writeFile(
    manifestPath,
    JSON.stringify(
      { generated: new Date().toISOString(), baseUrl: args.baseUrl, fetched, errors, sourceError, entries },
      null,
      2
    )
  );
  console.log('');
  console.log(`Notebooks: ${fetched} fetched, ${errors} errors.`);
  if (sourceError) console.log(`  list error: ${sourceError}`);
  console.log(`Manifest: ${manifestPath}`);
}
