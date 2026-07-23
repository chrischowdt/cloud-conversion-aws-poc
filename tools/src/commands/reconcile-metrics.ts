/**
 * reconcile-metrics — join the tenant's classic metric keys (from `discover`)
 * to their new-integration equivalents (via the mapping chain), then check each
 * against the live new-connection inventory (from `discover-metrics`). Emits a
 * spreadsheet (CSV) + a markdown summary showing, per classic key, whether the
 * new integration already collects it, needs it enabled, or has no standard
 * equivalent at all (the custom / Metric Streams case).
 *
 * OFFLINE: reads two files already written under the tenant out dir —
 *   tenant_keys.aws.json   (discover)         — classic keys + series counts
 *   live-metrics.json      (discover-metrics) — live new keys + series counts
 * Run both of those against the tenant first, ideally while classic + new run
 * side-by-side, so the inventory reflects the true current state.
 *
 * Outputs (under the tenant out dir):
 *   metric-reconciliation.csv   — one row per classic key with data
 *   metric-reconciliation.md    — summary + prioritized add-lists
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadRecipeIndex, lookupClassicKey } from '../lib/recipe-lookup.ts';
import type { LookupResult } from '../lib/recipe-lookup.ts';
import {
  REPO_ROOT,
  SKILL_DAC_AWS_METRICS,
  SKILL_MANUAL_AWS_METRICS,
  SKILL_PER_KEY_AWS_METRICS,
} from '../lib/paths.ts';
import { liveMetricsPathIfPresent } from '../lib/live-metrics.ts';
import { mdTable } from '../lib/markdown.ts';
import {
  buildInventoryIndex,
  buildServiceBridge,
  classifyRow,
  isActionable,
  serviceOf,
  type ClassicKey,
  type Recommendation,
  type ReconRow,
} from '../lib/metric-reconcile.ts';

export interface ReconcileMetricsArgs {
  /** Tenant out dir — where tenant_keys.aws.json and live-metrics.json live. */
  outDir: string;
  mappingPath?: string;
  /** Only reconcile classic keys with at least this many series. Default 1. */
  minSeries?: number;
  minOverrideSeries?: number;
  /**
   * Also emit the per-account reconciliation from `tenant_keys_by_account.aws.json`
   * (run `discover --by-account` first). Each account's classic keys are
   * reconciled against that account's own new inventory.
   */
  byAccount?: boolean;
}

interface TenantKeysFile {
  keys: Array<{ metricKey: string; classicSeries: number; newSeries: number }>;
}
interface LiveMetricsFile {
  metrics: Record<string, number>;
  generated?: string;
}
interface ByAccountFile {
  accountCount: number;
  accounts: Record<string, { classic: Record<string, number>; new: Record<string, number> }>;
}

/** Rank recommendations so the highest-value "add" rows sort to the top. */
const SORT_RANK: Record<Recommendation, number> = {
  'add-to-new': 0,
  'unmapped-add-metric': 1,
  'custom-or-metric-streams': 2,
  'collected-other-dim': 3,
  'unmapped-likely-collected': 4,
  collected: 5,
};

const CSV_HEADERS = [
  'classic_key',
  'classic_series',
  'mapped_new_key',
  'mapping_tier',
  'availability',
  'new_service',
  'in_new_inventory',
  'new_series',
  'recommendation',
  'evidence',
];

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsvRow(r: ReconRow): string {
  return [
    r.classicKey,
    r.classicSeries,
    r.mappedNewKey,
    r.mappingTier,
    r.availability,
    r.newService,
    r.inInventory,
    r.newSeries,
    r.recommendation,
    r.evidence,
  ]
    .map(csvCell)
    .join(',');
}

/** count rows per service, for a filtered subset. */
function perService(rows: ReconRow[]): Array<[string, number]> {
  const m = new Map<string, number>();
  for (const r of rows) {
    const svc = serviceOf(r.classicKey);
    m.set(svc, (m.get(svc) ?? 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

export async function runReconcileMetrics(args: ReconcileMetricsArgs): Promise<void> {
  const base = args.outDir;
  await mkdir(base, { recursive: true });
  const minSeries = args.minSeries ?? 1;

  const tenantKeysPath = join(base, 'tenant_keys.aws.json');
  const liveMetricsPath = liveMetricsPathIfPresent(base);
  if (!liveMetricsPath) {
    throw new Error(
      `No live-metrics.json under ${base}. Run \`cct discover-metrics\` for this tenant first ` +
        `so the reconciliation knows what the new integration currently collects.`
    );
  }

  let tenantKeysRaw: string;
  try {
    tenantKeysRaw = await readFile(tenantKeysPath, 'utf8');
  } catch {
    throw new Error(
      `No tenant_keys.aws.json under ${base}. Run \`cct discover\` for this tenant first.`
    );
  }
  const tenantKeys = JSON.parse(tenantKeysRaw) as TenantKeysFile;
  const live = JSON.parse(await readFile(liveMetricsPath, 'utf8')) as LiveMetricsFile;

  const mappingPath = args.mappingPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.with_recipes.json');
  const index = await loadRecipeIndex(mappingPath, {
    dacPath: SKILL_DAC_AWS_METRICS,
    manualPath: SKILL_MANUAL_AWS_METRICS,
    perKeyPath: SKILL_PER_KEY_AWS_METRICS,
    liveMetricsPath,
    minOverrideSeries: args.minOverrideSeries,
  });

  const inv = buildInventoryIndex(live.metrics);

  // Reconcile only classic keys that actually carry classic data on this tenant.
  const classic: ClassicKey[] = tenantKeys.keys
    .filter((k) => k.classicSeries >= minSeries)
    .map((k) => ({ metricKey: k.metricKey, classicSeries: k.classicSeries }));

  // Pass 1: look everything up once; collect mapped (classicSvc → newSvc) pairs
  // to build the service bridge used to place the unmapped tail.
  const looked = new Map<string, LookupResult>();
  const pairs: Array<[string, string]> = [];
  for (const c of classic) {
    const res = lookupClassicKey(index, c.metricKey);
    looked.set(c.metricKey, res);
    const newKey =
      res.kind === 'recipe' || res.kind === 'mapped-no-recipe'
        ? (res.entry.newDtMetricKey ?? '')
        : res.kind === 'composite'
          ? res.formula.components[0]?.newDtMetricKey ?? ''
          : '';
    if (newKey) pairs.push([serviceOf(c.metricKey), serviceOf(newKey)]);
  }
  const bridge = buildServiceBridge(pairs);

  // Pass 2: classify.
  const rows = classic.map((c) => classifyRow(c, looked.get(c.metricKey)!, inv, bridge));
  rows.sort((a, b) => {
    const d = SORT_RANK[a.recommendation] - SORT_RANK[b.recommendation];
    return d !== 0 ? d : b.classicSeries - a.classicSeries;
  });

  // ── CSV ──
  const csv = [CSV_HEADERS.join(','), ...rows.map(toCsvRow)].join('\n') + '\n';
  const csvPath = join(base, 'metric-reconciliation.csv');
  await writeFile(csvPath, csv);

  // ── Markdown summary ──
  const counts = new Map<Recommendation, number>();
  for (const r of rows) counts.set(r.recommendation, (counts.get(r.recommendation) ?? 0) + 1);
  const n = (r: Recommendation) => counts.get(r) ?? 0;
  const addToNew = rows.filter((r) => r.recommendation === 'add-to-new');
  const addMetric = rows.filter((r) => r.recommendation === 'unmapped-add-metric');
  const streams = rows.filter((r) => r.recommendation === 'custom-or-metric-streams');
  const actionable = rows.filter((r) => isActionable(r.recommendation));

  const md: string[] = [];
  md.push('# Classic → new metric reconciliation');
  md.push('');
  md.push(`- Tenant out dir: \`${base}\``);
  md.push(`- Classic keys reconciled (classicSeries ≥ ${minSeries}): **${rows.length}**`);
  md.push(`- Live new-integration inventory: **${inv.keys.size}** keys (${live.generated ?? 'n/a'})`);
  md.push('');
  md.push('## Outcome');
  md.push('');
  md.push(
    mdTable(
      ['recommendation', 'count', 'meaning'],
      [
        ['collected', n('collected'), 'new integration already collects this exact variant'],
        ['collected-other-dim', n('collected-other-dim'), 'metric flows, but under a different `.By.<dim>`'],
        ['unmapped-likely-collected', n('unmapped-likely-collected'), 'no key-map, but a same-name metric is collected — verify'],
        ['**add-to-new**', n('add-to-new'), '**known new key, not collected here — enable it**'],
        ['**unmapped-add-metric**', n('unmapped-add-metric'), '**service onboarded, this metric not collected — add it**'],
        ['**custom-or-metric-streams**', n('custom-or-metric-streams'), '**no standard equivalent — add as a custom/arbitrary key**'],
      ]
    )
  );
  md.push('');
  const collectedTotal = n('collected') + n('collected-other-dim') + n('unmapped-likely-collected');
  md.push(
    `**${collectedTotal}** of ${rows.length} already appear to be collected by the new integration; ` +
      `**${actionable.length}** are candidates to add.`
  );
  md.push('');

  md.push('## Add to the new integration (known equivalents not collected here)');
  md.push('');
  const addAuto = addToNew.filter((r) => r.availability === 'autodiscovered');
  const addRecommended = addToNew.filter((r) => r.availability !== 'autodiscovered');
  md.push(
    `These map to a real new-integration metric key that isn't flowing on this tenant, split by ` +
      `how you'd enable it.`
  );
  md.push('');
  md.push(`### autodiscovered — add explicitly via \`recommended + custom\` (${addAuto.length})`);
  md.push('');
  md.push(
    mdTable(
      ['service', 'keys to add'],
      perService(addAuto).map(([s, c]) => [s, c])
    )
  );
  md.push('');
  md.push(`### in the recommended set but not flowing (${addRecommended.length})`);
  md.push('');
  md.push(
    `These are in the recommended set yet have no series here — usually because the resource type ` +
      `isn't present on this tenant, or the recommended set wasn't fully enabled. Verify before adding.`
  );
  md.push('');
  md.push(
    mdTable(
      ['classic_key', 'series', 'mapped_new_key'],
      addRecommended
        .slice()
        .sort((a, b) => b.classicSeries - a.classicSeries)
        .slice(0, 30)
        .map((r) => [r.classicKey, r.classicSeries, r.mappedNewKey])
    )
  );
  md.push('');

  md.push('## Custom / Metric Streams candidates (no standard new equivalent)');
  md.push('');
  md.push(
    `The service isn't collected by the new integration on this tenant, so these have no ` +
      `recommended/autodiscovered key. They can be added as arbitrary custom metric keys — this ` +
      `is the Metric Streams use case.`
  );
  md.push('');
  md.push(
    mdTable(
      ['service', 'classic keys'],
      perService(streams).map(([s, c]) => [s, c])
    )
  );
  md.push('');

  md.push('## Top 30 add candidates by classic usage (series)');
  md.push('');
  md.push(
    mdTable(
      ['classic_key', 'series', 'recommendation', 'mapped_new_key'],
      actionable
        .slice()
        .sort((a, b) => b.classicSeries - a.classicSeries)
        .slice(0, 30)
        .map((r) => [r.classicKey, r.classicSeries, r.recommendation, r.mappedNewKey || '—'])
    )
  );
  md.push('');
  md.push('---');
  md.push('');
  md.push(
    `> The unmapped tail (${n('unmapped-add-metric') + n('unmapped-likely-collected') + n('custom-or-metric-streams')} keys) ` +
      `is placed against the live inventory using a classic→new service bridge derived from the keys that ` +
      `did map, plus a conservative metric-name match. The \`unmapped-likely-collected\` rows are heuristic — ` +
      `verify the dimension/grain before assuming full coverage.`
  );
  const mdPath = join(base, 'metric-reconciliation.md');
  await writeFile(mdPath, md.join('\n') + '\n');

  // ── Console ──
  console.log(`Reconciled ${rows.length} classic keys against ${inv.keys.size} live new keys.`);
  console.log(`  collected / other-dim / likely : ${n('collected')} / ${n('collected-other-dim')} / ${n('unmapped-likely-collected')}`);
  console.log(`  add-to-new (known key)         : ${n('add-to-new')}`);
  console.log(`  unmapped-add-metric            : ${n('unmapped-add-metric')}`);
  console.log(`  custom / metric-streams        : ${n('custom-or-metric-streams')}`);
  console.log(`Wrote ${csvPath}`);
  console.log(`Wrote ${mdPath}`);

  if (args.byAccount) {
    // Reuse the tenant-wide mapping index + service bridge; only the presence
    // check (inventory) is per-account. Memoize lookups across accounts.
    const memo = looked;
    const lookup = (key: string): LookupResult => {
      let r = memo.get(key);
      if (!r) memo.set(key, (r = lookupClassicKey(index, key)));
      return r;
    };
    await runByAccount(base, minSeries, lookup, bridge);
  }
}

/** Per-account reconciliation from tenant_keys_by_account.aws.json. */
async function runByAccount(
  base: string,
  minSeries: number,
  lookup: (key: string) => LookupResult,
  bridge: Map<string, string>
): Promise<void> {
  const path = join(base, 'tenant_keys_by_account.aws.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new Error(
      `--by-account: no tenant_keys_by_account.aws.json under ${base}. ` +
        `Run \`cct discover --by-account\` for this tenant first.`
    );
  }
  const file = JSON.parse(raw) as ByAccountFile;
  const accounts = Object.entries(file.accounts);

  interface AcctSummary {
    account: string;
    classicKeys: number;
    counts: Record<Recommendation, number>;
    actionable: number;
  }
  const allRows: Array<ReconRow & { account: string }> = [];
  const summaries: AcctSummary[] = [];

  for (const [account, data] of accounts) {
    const inv = buildInventoryIndex(data.new);
    const classic: ClassicKey[] = Object.entries(data.classic)
      .filter(([, c]) => c >= minSeries)
      .map(([metricKey, classicSeries]) => ({ metricKey, classicSeries }));
    const counts: Record<Recommendation, number> = {
      collected: 0,
      'collected-other-dim': 0,
      'unmapped-likely-collected': 0,
      'add-to-new': 0,
      'unmapped-add-metric': 0,
      'custom-or-metric-streams': 0,
    };
    let actionable = 0;
    for (const c of classic) {
      const row = classifyRow(c, lookup(c.metricKey), inv, bridge);
      counts[row.recommendation]++;
      if (isActionable(row.recommendation)) actionable++;
      allRows.push({ account, ...row });
    }
    summaries.push({ account, classicKeys: classic.length, counts, actionable });
  }

  // CSV: account column first, then the standard columns; sort by account then rank.
  allRows.sort(
    (a, b) =>
      a.account.localeCompare(b.account) ||
      SORT_RANK[a.recommendation] - SORT_RANK[b.recommendation] ||
      b.classicSeries - a.classicSeries
  );
  const csv =
    ['account,' + CSV_HEADERS.join(','), ...allRows.map((r) => csvCell(r.account) + ',' + toCsvRow(r))].join(
      '\n'
    ) + '\n';
  const csvPath = join(base, 'metric-reconciliation-by-account.csv');
  await writeFile(csvPath, csv);

  // Markdown: one summary row per account, most add-candidates first.
  summaries.sort((a, b) => b.actionable - a.actionable);
  const md: string[] = [];
  md.push('# Per-account classic → new metric reconciliation');
  md.push('');
  md.push(`- Accounts with cloud.aws.* data: **${accounts.length}**`);
  md.push(`- Total per-account classic rows reconciled: **${allRows.length}**`);
  md.push('');
  md.push(
    `> Classic series mostly don't carry \`aws.account.id\` (account lives in the classic entity ` +
      `model), so the classic side is only partially covered per account; the new side is complete. ` +
      `Counts below are the classic keys that DO carry an account.`
  );
  md.push('');
  md.push('## Accounts by add-candidate count');
  md.push('');
  md.push(
    mdTable(
      ['account', 'classic keys', 'collected*', 'add-to-new', 'unmapped-add', 'custom/streams', 'to add'],
      summaries.map((s) => [
        s.account,
        s.classicKeys,
        s.counts.collected + s.counts['collected-other-dim'] + s.counts['unmapped-likely-collected'],
        s.counts['add-to-new'],
        s.counts['unmapped-add-metric'],
        s.counts['custom-or-metric-streams'],
        s.actionable,
      ])
    )
  );
  md.push('');
  md.push('_*collected = exact + other-dim + likely-collected (heuristic)._');
  md.push('');
  const mdPath = join(base, 'metric-reconciliation-by-account.md');
  await writeFile(mdPath, md.join('\n') + '\n');

  console.log('');
  console.log(`Per-account: reconciled ${allRows.length} rows across ${accounts.length} accounts.`);
  console.log(`Wrote ${csvPath}`);
  console.log(`Wrote ${mdPath}`);
}
