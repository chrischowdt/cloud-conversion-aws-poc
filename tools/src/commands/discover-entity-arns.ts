/**
 * discover-entity-arns — resolve every classic entity id found in the downloaded
 * assets to the ARN of the resource it named, and cache the result per tenant.
 *
 *   `entity-arns.json`  →  consumed by the rewriter's Pass 1.52 (entity-id-pins.ts)
 *
 * Why a discovery step rather than a lookup at rewrite time: the rewriter is
 * offline and pure, and a classic entity can disappear later (the resource is
 * deleted, the classic integration is switched off). Once an id has resolved to
 * an ARN the answer is kept — a later run that can no longer find the entity
 * does NOT erase it.
 *
 * Read-only against the tenant (Grail DQL on `dt.entity.*`). Needs only
 * `storage:entities:read`, which `discover` already requires.
 */

import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { DqlClient, DqlError } from '../dynatrace/dql.ts';
import { classicTypeOfId, collectClassicIds, type EntityArnEntry } from '../lib/entity-arns.ts';
import { looksLikeDql } from '../lib/asset-scan.ts';

export interface DiscoverEntityArnsArgs {
  baseUrl: string;
  token: string;
  outDir: string;
  /** Sub-directories of outDir to scan for ids. Defaults to the downloaded originals. */
  sources?: string[];
  /** How far back to look for the classic entity. Dormant entities still exist. Default 30 days. */
  lookbackDays?: number;
}

const DEFAULT_SOURCES = ['dashboards', 'notebooks', 'anomaly-detectors'];
const CHUNK = 50;

/** JSON keys under which an asset keeps DQL. Notebooks also keep RESULTS, which we must not read. */
const QUERY_KEYS = new Set(['query', 'dqlQuery', 'input', 'value']);

/**
 * Collect only the strings that are QUERIES. Reading whole files is wrong: a
 * notebook stores the results of its past runs, so a 1.9 GB notebooks directory
 * is mostly result rows full of entity ids that no query pins — which would mean
 * thousands of pointless lookups.
 */
function collectQueryStrings(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const x of node) collectQueryStrings(x, out);
    return;
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (typeof v === 'string') {
        if (QUERY_KEYS.has(k) && looksLikeDql(v)) out.push(v);
      } else collectQueryStrings(v, out);
    }
  }
}

async function listJson(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith('.json')).map((e) => join(e.parentPath ?? dir, e.name));
}

export async function runDiscoverEntityArns(args: DiscoverEntityArnsArgs): Promise<void> {
  const outPath = join(args.outDir, 'entity-arns.json');
  await mkdir(args.outDir, { recursive: true });

  // ── 1. every classic-looking id in the downloaded originals ───────────────
  const ids = new Set<string>();
  let files = 0;
  let unparsable = 0;
  for (const sub of args.sources ?? DEFAULT_SOURCES) {
    const list = await listJson(join(args.outDir, sub));
    console.log(`Scanning ${list.length} file(s) in ${sub}/ …`);
    for (const f of list) {
      files++;
      try {
        const queries: string[] = [];
        collectQueryStrings(JSON.parse(await readFile(f, 'utf8')), queries);
        for (const q of queries) for (const id of collectClassicIds(q)) ids.add(id);
      } catch {
        unparsable++;
      }
      if (files % 250 === 0) console.log(`  … ${files} files, ${ids.size} id(s) so far`);
    }
  }
  console.log(`Scanned ${files} file(s)${unparsable ? ` (${unparsable} unparsable, skipped)` : ''}: ${ids.size} distinct classic-looking entity id(s) in QUERIES.`);
  if (ids.size === 0) {
    console.log('Nothing to resolve. (Download the assets first: download-dashboards / download-notebooks / download-anomaly-detectors.)');
    return;
  }

  // Keep what an earlier run already resolved: a deleted entity must not erase a known ARN.
  const previous: Record<string, EntityArnEntry> = {};
  if (existsSync(outPath)) {
    try {
      Object.assign(previous, (JSON.parse(await readFile(outPath, 'utf8')) as { entities?: Record<string, EntityArnEntry> }).entities ?? {});
    } catch { /* a corrupt cache is simply rebuilt */ }
  }

  // ── 2. ask the tenant, one entity type at a time ──────────────────────────
  const dql = new DqlClient({ baseUrl: args.baseUrl, token: args.token });
  const now = Date.now();
  const window = {
    defaultTimeframeStart: new Date(now - (args.lookbackDays ?? 30) * 86_400_000).toISOString(),
    defaultTimeframeEnd: new Date(now).toISOString(),
  };

  const byType = new Map<string, string[]>();
  for (const id of ids) {
    const t = classicTypeOfId(id);
    (byType.get(t) ?? byType.set(t, []).get(t)!).push(id);
  }

  const entities: Record<string, EntityArnEntry> = {};
  const unqueryable: string[] = [];

  console.log(`Looking up ${byType.size} classic entity type(s): ${[...byType].map(([t, v]) => `${t}=${v.length}`).join(', ')}`);
  for (const [type, typeIds] of byType) {
    for (let i = 0; i < typeIds.length; i += CHUNK) {
      const chunk = typeIds.slice(i, i + CHUNK);
      const list = chunk.map((x) => `"${x}"`).join(', ');
      const base = `fetch \`dt.entity.${type}\`\n| filter in(id, array(${list}))\n`;
      let rows: Array<Record<string, unknown>> | null = null;
      let hasArn = true;
      try {
        rows = (await dql.query({ query: `${base}| fields id, entity.name, arn`, ...window, maxResultRecords: 1000 })).records;
      } catch (e) {
        const body = e instanceof DqlError ? e.body : String((e as Error).message);
        if (/FIELD_DOES_NOT_EXIST|arn/i.test(body) && !/ENTITY_TYPE|does not exist as an entity|INVALID_ENTITY/i.test(body)) {
          // This entity type has no `arn` attribute at all — still tells us the entity exists.
          try {
            rows = (await dql.query({ query: `${base}| fields id, entity.name`, ...window, maxResultRecords: 1000 })).records;
            hasArn = false;
          } catch { rows = null; }
        }
      }
      if (rows === null) {
        unqueryable.push(type);
        for (const id of chunk) entities[id] = { arn: null, name: null, type, missing: 'type-unqueryable' };
        continue;
      }
      const found = new Map(rows.map((r) => [String(r['id']), r]));
      for (const id of chunk) {
        const r = found.get(id);
        if (!r) entities[id] = { arn: null, name: null, type, missing: 'not-found' };
        else if (!hasArn || !r['arn']) entities[id] = { arn: null, name: r['entity.name'] ? String(r['entity.name']) : null, type, missing: 'no-arn' };
        else entities[id] = { arn: String(r['arn']), name: r['entity.name'] ? String(r['entity.name']) : null, type };
      }
    }
  }

  // ── 3. merge with what we already knew ────────────────────────────────────
  let kept = 0;
  for (const [id, e] of Object.entries(entities)) {
    const old = previous[id];
    if (!e.arn && old?.arn) { entities[id] = old; kept++; }
  }

  const resolved = Object.values(entities).filter((e) => e.arn).length;
  await writeFile(
    outPath,
    JSON.stringify({ generated: new Date().toISOString(), baseUrl: args.baseUrl, lookbackDays: args.lookbackDays ?? 30, count: ids.size, resolved, entities }, null, 2)
  );

  const reasons = new Map<string, number>();
  for (const e of Object.values(entities)) if (!e.arn) reasons.set(e.missing ?? '?', (reasons.get(e.missing ?? '?') ?? 0) + 1);
  console.log(`\nResolved ${resolved} of ${ids.size} id(s) to an ARN → ${outPath}`);
  if (kept) console.log(`  kept ${kept} ARN(s) from a previous run for entities the tenant no longer reports`);
  if (reasons.size) console.log(`  unresolved: ${[...reasons].map(([k, n]) => `${k}=${n}`).join(', ')}`);
  const perType = [...byType].map(([t, v]) => `${t}=${v.length}`).sort();
  console.log(`  by classic type: ${perType.slice(0, 12).join(', ')}${perType.length > 12 ? ', …' : ''}`);
  if (unqueryable.length) console.log(`  types that are not dt.entity.* types (ignored): ${[...new Set(unqueryable)].slice(0, 8).join(', ')}`);
}
