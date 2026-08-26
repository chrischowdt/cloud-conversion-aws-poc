/**
 * migrate-refresh — (re)build the shared migration tracker (.xlsx) from what's
 * already on disk. READ-ONLY: no tenant calls, no dtctl, no document writes.
 * This is the entry point of the placement pipeline and is safe to run anytime.
 *
 * Joins, per AWS-referencing asset (by document id):
 *   - scan results  (dashboard-scan/ + notebook-scan/ results.jsonl) → buckets
 *   - download manifest (dashboards/ + notebooks/ manifest.json)      → owner, usage
 *   - compare JSON  (dashboard-compare/*.compare.json)               → parity
 * → asset-confidence → { confidence, lane } → upserts tracker rows (preserving
 * any human decision/notes and existing workflow status).
 *
 * Output: <tenant>/migration-tracker.xlsx  (override with --tracker)
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  assetConfidence,
  parityVerdict,
  rollupBuckets,
  type ParityCounts,
  type QueryDetailLike,
} from '../lib/asset-confidence.ts';
import { upsertRows, readExistingIds, pruneReviewCopyRows, pruneRowsNotInScope, type AssetType, type TrackerRow } from '../lib/tracker-xlsx.ts';
import { REVIEW_PREFIX } from '../lib/doc-apply.ts';

export interface MigrateRefreshArgs {
  outDir: string;
  trackerPath?: string;
}

interface ScanResult {
  id: string;
  name: string;
  file: string;
  details?: QueryDetailLike[];
}
interface ManifestEntry {
  id: string;
  owner?: string;
  accessCount?: number;
  lastAccessed?: string;
}

async function readJsonl<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

async function readManifest(path: string): Promise<Map<string, ManifestEntry>> {
  const map = new Map<string, ManifestEntry>();
  if (!existsSync(path)) return map;
  const m = JSON.parse(await readFile(path, 'utf8')) as { entries?: ManifestEntry[] };
  for (const e of m.entries ?? []) if (e.id) map.set(e.id, e);
  return map;
}

async function readCompareParity(dir: string): Promise<Map<string, ParityCounts>> {
  const map = new Map<string, ParityCounts>();
  if (!existsSync(dir)) return map;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.compare.json'));
  for (const f of files) {
    try {
      const j = JSON.parse(await readFile(join(dir, f), 'utf8')) as {
        id?: string | null;
        parityCounts?: ParityCounts;
      };
      if (j.id) map.set(j.id, j.parityCounts ?? {});
    } catch {
      /* skip malformed */
    }
  }
  return map;
}

export async function runMigrateRefresh(args: MigrateRefreshArgs): Promise<void> {
  const base = args.outDir;
  const trackerPath = args.trackerPath ?? join(base, 'migration-tracker.xlsx');

  const dashScan = await readJsonl<ScanResult>(join(base, 'dashboard-scan', 'results.jsonl'));
  const nbScan = await readJsonl<ScanResult>(join(base, 'notebook-scan', 'results.jsonl'));
  if (dashScan.length === 0 && nbScan.length === 0) {
    throw new Error(
      `No scan results under ${base}. Run \`cct scan-dashboards\` and/or \`cct scan-notebooks\` first.`
    );
  }

  const dashManifest = await readManifest(join(base, 'dashboards', 'manifest.json'));
  const nbManifest = await readManifest(join(base, 'notebooks', 'manifest.json'));
  const parityById = await readCompareParity(join(base, 'dashboard-compare'));
  const existing = await readExistingIds(trackerPath);

  const rows: TrackerRow[] = [];
  const laneTally: Record<string, number> = {};
  let skippedCopies = 0;
  const build = (results: ScanResult[], type: AssetType, manifest: Map<string, ManifestEntry>) => {
    for (const r of results) {
      // Skip the review COPIES this pipeline created. They are real documents in
      // the tenant, so `download-*` picks them up and they would otherwise land
      // here as fresh candidates — inviting a review copy OF a review copy, and
      // padding the queue with assets nobody needs to migrate. The originals are
      // already tracked under their own ids.
      if (r.name?.startsWith(REVIEW_PREFIX)) {
        skippedCopies++;
        continue;
      }
      const scan = rollupBuckets(r.details ?? []);
      const parity = type === 'dashboard' ? parityById.get(r.id) : undefined;
      const conf = assetConfidence(scan, parity);
      laneTally[conf.lane] = (laneTally[conf.lane] ?? 0) + 1;
      const mf = manifest.get(r.id);
      const acc = mf?.accessCount ?? 0;
      const priority = conf.level === 'blocked' ? 'low' : acc >= 100 ? 'high' : acc >= 10 ? 'medium' : 'low';
      const row: TrackerRow = {
        asset_id: r.id,
        asset_type: type,
        name: r.name,
        owner: mf?.owner,
        access_count: mf?.accessCount,
        last_accessed: mf?.lastAccessed,
        scan_clean: scan.clean,
        scan_soft: scan.soft,
        scan_blocked: scan.blocked,
        parity: parityVerdict(parity),
        confidence: conf.level,
        lane: conf.lane,
        priority,
        reasons: conf.reasons.join('; '),
      };
      // Only set status for brand-new assets — never reset workflow progress.
      if (!existing.has(r.id)) row.status = conf.level === 'blocked' ? 'blocked' : 'candidate';
      rows.push(row);
    }
  };
  build(dashScan, 'dashboard', dashManifest);
  build(nbScan, 'notebook', nbManifest);

  // Drop any of our own review copies a PREVIOUS refresh enrolled as candidates.
  // They are not assets to migrate (the originals are tracked under their own
  // ids), and leaving them invites staging a review copy OF a review copy.
  const pruned = await pruneReviewCopyRows(trackerPath, REVIEW_PREFIX);

  // Drop rows for assets no longer in scope. Narrowing the download (e.g.
  // --used-within-days) changes what we scan, but upsertRows only adds and
  // updates — without this the sheet would only ever grow. Human input and
  // in-flight work are never pruned, whatever the scope says.
  const scope = new Set(rows.map((r) => r.asset_id));
  const outOfScope = await pruneRowsNotInScope(trackerPath, scope);

  const { updated, added } = await upsertRows(trackerPath, rows);

  console.log(`Refreshed migration tracker: ${trackerPath}`);
  console.log(`  assets: ${rows.length} (scanned: dashboards ${dashScan.length}, notebooks ${nbScan.length})`);
  console.log(`  rows: ${added} added, ${updated} updated`);
  if (outOfScope.removed) console.log(`  removed ${outOfScope.removed} row(s) no longer in scope`);
  if (outOfScope.keptHuman) console.log(`  kept ${outOfScope.keptHuman} out-of-scope row(s) carrying human input`);
  if (outOfScope.keptInFlight) console.log(`  kept ${outOfScope.keptInFlight} out-of-scope row(s) with work in flight`);
  if (pruned.removed) console.log(`  removed ${pruned.removed} stale review-copy row(s) a previous refresh had enrolled`);
  for (const n of pruned.keptWithHumanInput) console.log(`  ! kept review-copy row with human input: ${n}`);
  if (skippedCopies) {
    console.log(`  skipped ${skippedCopies} "${REVIEW_PREFIX.trim()}" review copies (not migration candidates)`);
  }
  console.log(
    `  lanes: fast ${laneTally['fast'] ?? 0}, review ${laneTally['review'] ?? 0}, blocked ${laneTally['blocked'] ?? 0}`
  );
  if (!parityById.size) {
    console.log('  (no compare-dashboard parity found — run compare-dashboard to unlock the fast lane)');
  }
}
