/**
 * refresh-alert-tracker — build a tracker of AWS anomaly detectors, using the
 * SAME column schema as the asset tracker so the rows can be pasted straight in.
 *
 * Kept as a separate command (and by default a separate file) because alerts
 * do not move through the placement pipeline: a Davis anomaly detector is a
 * Settings 2.0 object, not a document. You cannot stage an inert copy of one —
 * a second enabled detector is a second live alert — and publishing is a PUT
 * that changes a live alert immediately. So the tracker carries STATUS while
 * the review itself happens somewhere a reviewer can actually run the query.
 *
 * Why the risk profile differs from dashboards: a mis-converted dashboard shows
 * an empty tile; a mis-converted detector is an alert that never fires, which
 * nobody notices until an incident is missed. 1,362 of the 1,606 detectors on
 * nic55601 are enabled.
 *
 * Read-only: reads the detector scan output, writes one xlsx.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { assetConfidence, rollupBuckets, type QueryDetailLike } from '../lib/asset-confidence.ts';
import { upsertRows, type TrackerRow } from '../lib/tracker-xlsx.ts';

export interface RefreshAlertTrackerArgs {
  outDir: string;
  /** Defaults to <tenant>/alert-tracker.xlsx — deliberately NOT the asset tracker. */
  trackerPath?: string;
  /** Tenant base URL, for the deep link. Falls back to the download manifest. */
  baseUrl?: string;
}

interface DetectorScanResult {
  id: string;
  name: string;
  details?: QueryDetailLike[];
}

/**
 * Work out which team owns a detector, preferring evidence from INSIDE the
 * query over the title.
 *
 * The title prefix is convenient but incomplete, and it is a label rather than
 * a fact. The query is what the alert actually does. Measured across the 990
 * AWS detectors on nic55601:
 *
 *   430 have both a title prefix and an applicationci in the query — 425 agree
 *       (98.8%), so where the title has a code it is trustworthy
 *    16 have an applicationci but NO title prefix (title-only grouping lost them)
 *    43 more are identifiable from the AWS resource name (`cwe-logging-dev`)
 *   138 have no owner signal at all — overwhelmingly platform defaults, which
 *       carry `[Standard]` or `[AWS]` in the title and belong to nobody
 *
 * Order matters: applicationci first because it is what the alert filters on.
 */
const CI_TAG_RE = /\b(?:aws\.tags\.)?applicationci\b[^"']{0,20}["']([A-Za-z0-9_-]{2,10})["']/gi;
const CI_SELECTOR_RE = /\[AWS\]ApplicationCI:([A-Za-z0-9_-]{2,10})/gi;
const TITLE_PREFIX_RE = /^([A-Za-z]{2,4})[\s:_-]/;
/** A 3-letter app code leading an AWS resource name (`cwe-logging-dev`). */
const RESOURCE_NAME_RE = /\b([a-z]{3})-[a-z0-9]+(?:-[a-z0-9]+)+\b/g;

export interface OwnerGuess {
  team: string;
  /** Where the answer came from, so a wrong grouping is traceable. */
  source: 'applicationci' | 'title' | 'resource-name' | 'platform-default' | 'unknown';
}

export function deriveOwner(name: string, queryText: string): OwnerGuess {
  const title = String(name ?? '');
  const text = `${title}
${queryText ?? ''}`;

  const ci = new Set<string>();
  for (const m of text.matchAll(CI_TAG_RE)) ci.add(m[1]!.toLowerCase());
  for (const m of text.matchAll(CI_SELECTOR_RE)) ci.add(m[1]!.toLowerCase());
  // A single unambiguous applicationci is the strongest signal there is.
  if (ci.size === 1) return { team: [...ci][0]!.toUpperCase(), source: 'applicationci' };

  const t = TITLE_PREFIX_RE.exec(title.trim());
  if (t) return { team: t[1]!.toUpperCase(), source: 'title' };

  // Several applicationci values and no title code: pick none rather than guess.
  if (ci.size > 1) return { team: '', source: 'unknown' };

  const counts = new Map<string, number>();
  for (const m of text.toLowerCase().matchAll(RESOURCE_NAME_RE)) {
    counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (best) return { team: best[0].toUpperCase(), source: 'resource-name' };

  // Dynatrace-shipped templates carry these markers and belong to no team.
  if (/\[Standard\]|\[AWS\]/i.test(title)) return { team: '', source: 'platform-default' };
  return { team: '', source: 'unknown' };
}

/** Deep link to the detector's settings object. */
function detectorUrl(baseUrl: string | undefined, id: string): string | undefined {
  if (!baseUrl) return undefined;
  return `${baseUrl.replace(/\/+$/, '')}/ui/apps/dynatrace.davis.anomaly.detectors/detectors/${encodeURIComponent(id)}`;
}

export async function runRefreshAlertTracker(args: RefreshAlertTrackerArgs): Promise<void> {
  const base = args.outDir;
  const scanPath = join(base, 'anomaly-detector-scan', 'results.jsonl');
  if (!existsSync(scanPath)) {
    throw new Error(`No detector scan at ${scanPath}. Run \`cct scan-anomaly-detectors\` first.`);
  }
  const trackerPath = args.trackerPath ?? join(base, 'alert-tracker.xlsx');

  let baseUrl = args.baseUrl;
  if (!baseUrl) {
    const mf = join(base, 'dashboards', 'manifest.json');
    if (existsSync(mf)) {
      try {
        baseUrl = (JSON.parse(await readFile(mf, 'utf8')) as { baseUrl?: string }).baseUrl;
      } catch { /* link is optional */ }
    }
  }

  const results = (await readFile(scanPath, 'utf8'))
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DetectorScanResult);

  const rows: TrackerRow[] = [];
  const laneTally: Record<string, number> = {};
  const teamTally: Record<string, number> = {};
  const sourceTally: Record<string, number> = {};

  for (const r of results) {
    const scan = rollupBuckets(r.details ?? []);
    // No compare-dashboard equivalent for detectors yet, so parity is unknown —
    // which is exactly why nothing here should reach the fast lane.
    const conf = assetConfidence(scan, undefined);
    laneTally[conf.lane] = (laneTally[conf.lane] ?? 0) + 1;
    // Ownership comes from the query first, the title second — see deriveOwner.
    const queryText = (r.details ?? [])
      .map((d) => String((d as { original?: string }).original ?? ''))
      .join('\n');
    const owner = deriveOwner(r.name, queryText);
    const team = owner.team;
    teamTally[team || `(${owner.source})`] = (teamTally[team || `(${owner.source})`] ?? 0) + 1;
    sourceTally[owner.source] = (sourceTally[owner.source] ?? 0) + 1;

    rows.push({
      asset_id: r.id,
      asset_type: 'anomaly-detector',
      name: r.name,
      asset_url: detectorUrl(baseUrl, r.id),
      // Detectors carry no document owner, so `owner` holds the team code the
      // review batches are built from. `owner_email` records HOW it was derived,
      // so a mis-grouped alert can be traced rather than silently trusted.
      owner: team || undefined,
      owner_email: owner.source,
      scan_clean: scan.clean,
      scan_soft: scan.soft,
      scan_blocked: scan.blocked,
      confidence: conf.level,
      lane: conf.lane,
      priority: conf.level === 'blocked' ? 'low' : 'medium',
      status: conf.level === 'blocked' ? 'blocked' : 'candidate',
      reasons: conf.reasons.join('; '),
    });
  }

  const { added, updated } = await upsertRows(trackerPath, rows, 'migration');

  console.log(`Alert tracker: ${trackerPath}`);
  console.log(`  AWS detectors: ${rows.length} (${added} added, ${updated} updated)`);
  console.log(`  lanes: review ${laneTally['review'] ?? 0}, blocked ${laneTally['blocked'] ?? 0}, fast ${laneTally['fast'] ?? 0}`);
  const teams = Object.entries(teamTally).sort((a, b) => b[1] - a[1]);
  console.log(`  teams: ${teams.length} distinct code(s); largest ${teams.slice(0, 3).map(([t, n]) => `${t}=${n}`).join(', ')}`);
  console.log(`  owner derived from: ${Object.entries(sourceTally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}`).join(', ')}`);
  console.log('  Columns match the asset tracker, so these rows paste straight in.');
}
