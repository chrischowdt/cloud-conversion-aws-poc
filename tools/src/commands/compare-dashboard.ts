/**
 * compare-dashboard — validate the rewriter against real tenant data.
 *
 * For a downloaded dashboard, walks every DQL-bearing field, runs BOTH the
 * original and the rewritten query against the Grail Storage Query API,
 * compares the result shapes (row counts, top values, numeric sums per
 * field), and writes a markdown report.
 *
 * Expected output: parity, or a clear, per-tile description of where the
 * rewrite diverges. Useful as the confidence step before piling on more
 * translation patterns.
 *
 * Note: variable inputs are intentionally skipped — they typically reference
 * dashboard variables ($Account, $Region) the API can't substitute, so
 * running them headless would produce false-positive failures.
 *
 * Per-query DQL substitutions (the API doesn't know about dashboard
 * variables): every `$<NAME>` placeholder is replaced with `array()` so the
 * `in(x, $NAME)` predicates evaluate to "no filter" rather than failing
 * parse. This is good enough for shape validation.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { DqlClient, DqlError, type DqlResult } from '../dynatrace/dql.ts';
import { rewriteDql } from '../lib/dql-rewriter.ts';
import {
  REPO_ROOT,
  SKILL_DAC_AWS_METRICS,
  SKILL_MANUAL_AWS_METRICS,
  SKILL_PER_KEY_AWS_METRICS,
} from '../lib/paths.ts';
import { liveMetricsPathIfPresent } from '../lib/live-metrics.ts';
import { enrichedTagsPathIfPresent } from '../lib/enriched-tags.ts';
import { entityCandidatesPathIfPresent } from '../lib/entity-candidates.ts';
import { mzTagsPathIfPresent } from '../lib/mz-tags.ts';
import { loadRecipeIndex } from '../lib/recipe-lookup.ts';

export interface CompareDashboardArgs {
  baseUrl: string;
  token: string;
  input: string;
  mappingPath?: string;
  outDir?: string;
  from?: string;
  to?: string;
  /** Cap the number of queries actually run (useful for sanity). */
  limit?: number;
  /** Skip variable inputs even if they look like DQL. Default true. */
  includeVariables?: boolean;
  /**
   * Inject values for dashboard variables when the headless run executes.
   * Each key is a variable name (without leading `$`); the value is the list
   * of strings to substitute. Used for parallel-account testing: pass
   * `AccountID=560380317052,003946647406` to filter both classic and new
   * sides to only those AWS accounts.
   */
  injectedVars?: Map<string, string[]>;
  /**
   * Explicit `live-metrics.json` path for dim-variant validation. Defaults to
   * `<outDir>/live-metrics.json` if present (run `discover-metrics` first).
   */
  liveMetricsPath?: string;
  /** Minimum target-series count before a dim-override fires (default 2). */
  minOverrideSeries?: number;
}

const QUERY_FIELD_NAMES = new Set(['query', 'input', 'dqlQuery']);

interface QueryRef {
  path: string;
  field: string;
  original: string;
}

interface RunOutcome {
  status: 'ok' | 'error' | 'skipped';
  rowCount?: number;
  fieldNames?: string[];
  notifications?: string[];
  error?: string;
  /** First few rows for eyeballing — capped to keep the report short. */
  sampleRows?: Record<string, unknown>[];
  /** Per-field numeric sum (only if every value is finite). */
  numericSums?: Record<string, number>;
  /** Per-field distinct-count (categorical fields). */
  distinctCounts?: Record<string, number>;
}

interface ComparisonRow {
  index: number;
  path: string;
  field: string;
  original: string;
  rewritten: string;
  identical: boolean;
  warnings: string[];
  originalRun: RunOutcome;
  rewrittenRun: RunOutcome;
  parity: 'match' | 'mismatch' | 'one-side-empty' | 'both-empty' | 'both-error';
  parityNotes: string[];
}

function collectQueries(node: unknown, out: QueryRef[], path: string, includeVariables: boolean): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectQueries(v, out, `${path}[${i}]`, includeVariables));
    return;
  }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    const childPath = path ? `${path}.${k}` : k;
    if (
      QUERY_FIELD_NAMES.has(k) &&
      typeof v === 'string' &&
      v.length >= 30 &&
      /\b(fetch|timeseries|data record|metric\.series|fields|filter|summarize|describe|getNodeName)\b/.test(v)
    ) {
      // Variable inputs are usually `fetch dt.entity.* | fields ... | sort`
      // — same shape as a tile query; allow them by default and skip the
      // ones that obviously depend on other variables.
      const isVariable = path.startsWith('variables');
      if (isVariable && !includeVariables) continue;
      out.push({ path, field: k, original: v });
      continue;
    }
    if (typeof v === 'object') collectQueries(v, out, childPath, includeVariables);
  }
}

/**
 * Replace dashboard variables (`$Name`) with neutral values so headless runs
 * don't fail on parse AND don't accidentally evaluate to "always false"
 * (which is what `in(x, array())` does — it nukes the result set and
 * produces misleading `both-empty` outcomes).
 *
 * Strategy (with `injectedVars` taking precedence over the defaults):
 *
 *   - `in(x, $Foo)` → if `$Foo` injected: `in(x, array("v1", "v2"))`
 *                  → else: `true` (filter is a no-op, all rows pass)
 *   - bare `$Foo`  → if `$Foo` injected: the literal value (quoted)
 *                  → else: `null`
 *
 * The injected map is used when the user provides `--vars Name=val,Name=val`
 * or `--account-id <id>` (which is shorthand for several common account-ID
 * variables) so we can run comparisons against specific parallel accounts.
 */
function substituteVariables(q: string, injectedVars: Map<string, string[]> = new Map()): string {
  // Pass 1: `in(x, $Foo)` → either array(...) with injected values, or `true`.
  let out = q.replace(/\bin\(\s*([^,()]+?)\s*,\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*\)/g, (_, lhs: string, name: string) => {
    const vals = injectedVars.get(name);
    if (vals && vals.length > 0) {
      return `in(${lhs.trim()}, array(${vals.map((v) => JSON.stringify(v)).join(', ')}))`;
    }
    return 'true';
  });
  // Pass 2: bare `$Foo` references that survived (e.g. used as a value).
  // Substituting to `null` breaks `startsWith(x, null)`, `array(null)`, etc.
  // — DQL rejects null literals in most function-argument positions.
  // Empty string is safer: predicates accept it, at worst rows get filtered
  // out (better than a hard parse error). The user can pass `--vars` when
  // they want real substitutions.
  out = out.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name: string) => {
    const vals = injectedVars.get(name);
    if (vals && vals.length > 0) return JSON.stringify(vals[0]);
    return '""';
  });
  return out;
}

function summarizeResult(r: DqlResult): RunOutcome {
  const recs = r.records ?? [];
  const fieldSet = new Set<string>();
  for (const row of recs) for (const k of Object.keys(row)) fieldSet.add(k);
  const fieldNames = [...fieldSet].sort();

  const numericSums: Record<string, number> = {};
  const distinctCounts: Record<string, number> = {};
  for (const f of fieldNames) {
    let allFinite = true;
    let sum = 0;
    const distinct = new Set<string>();
    for (const row of recs) {
      const v = row[f];
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v;
      } else if (v !== null && v !== undefined) {
        allFinite = false;
        distinct.add(String(v));
      } else {
        allFinite = false;
      }
    }
    if (allFinite && recs.length > 0) numericSums[f] = sum;
    if (distinct.size > 0) distinctCounts[f] = distinct.size;
  }

  return {
    status: 'ok',
    rowCount: recs.length,
    fieldNames,
    notifications: (r.metadata?.notifications ?? []).map((n) => `${n.severity ?? '?'}: ${n.message}`),
    sampleRows: recs.slice(0, 3),
    numericSums: Object.keys(numericSums).length > 0 ? numericSums : undefined,
    distinctCounts: Object.keys(distinctCounts).length > 0 ? distinctCounts : undefined,
  };
}

/**
 * Convert user-facing relative tokens (`-2h`, `now`, ISO already) to the
 * ISO timestamp the Storage Query API expects on
 * `defaultTimeframeStart` / `defaultTimeframeEnd`. The API rejects bare
 * `-2h` / `now` with INVALID_TIMEFRAME, so we resolve them here.
 */
function resolveRelativeToken(tok: string | undefined): string | undefined {
  if (!tok) return undefined;
  const t = tok.trim();
  if (!t) return undefined;
  if (t.toLowerCase() === 'now') return new Date().toISOString();
  const m = /^-(\d+)([smhdw])$/i.exec(t);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2]!.toLowerCase();
    const ms = unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : unit === 'h' ? n * 3_600_000 : unit === 'd' ? n * 86_400_000 : /* w */ n * 7 * 86_400_000;
    return new Date(Date.now() - ms).toISOString();
  }
  // Already ISO or something else — pass through.
  return t;
}

async function runOne(client: DqlClient, q: string, from?: string, to?: string): Promise<RunOutcome> {
  try {
    const result = await client.query({
      query: q,
      defaultTimeframeStart: resolveRelativeToken(from),
      defaultTimeframeEnd: resolveRelativeToken(to),
      maxResultRecords: 1000,
    });
    return summarizeResult(result);
  } catch (e) {
    if (e instanceof DqlError) {
      return { status: 'error', error: `HTTP ${e.status}: ${e.body.slice(0, 400)}` };
    }
    return { status: 'error', error: (e as Error).message };
  }
}

function comparePair(a: RunOutcome, b: RunOutcome): { parity: ComparisonRow['parity']; notes: string[] } {
  const notes: string[] = [];
  if (a.status === 'error' && b.status === 'error') return { parity: 'both-error', notes: [`both errored`] };
  if (a.status === 'error' && b.status === 'ok') {
    notes.push(`original errored: ${a.error}`);
    return { parity: 'mismatch', notes };
  }
  if (b.status === 'error' && a.status === 'ok') {
    notes.push(`rewritten errored: ${b.error}`);
    return { parity: 'mismatch', notes };
  }
  if (a.rowCount === 0 && b.rowCount === 0) return { parity: 'both-empty', notes };
  if (a.rowCount === 0 || b.rowCount === 0) {
    notes.push(`row counts differ: original=${a.rowCount}, rewritten=${b.rowCount}`);
    return { parity: 'one-side-empty', notes };
  }
  if (a.rowCount !== b.rowCount) {
    notes.push(`row counts differ: original=${a.rowCount}, rewritten=${b.rowCount}`);
  }
  // Numeric sums: if both have the same field name, compare within 10%.
  if (a.numericSums && b.numericSums) {
    for (const f of Object.keys(a.numericSums)) {
      const av = a.numericSums[f]!;
      const bv = b.numericSums[f];
      if (bv === undefined) {
        notes.push(`field "${f}" present in original (sum=${av}), absent in rewritten`);
        continue;
      }
      if (av === 0 && bv === 0) continue;
      const rel = Math.abs(av - bv) / Math.max(1e-9, Math.abs(av) + Math.abs(bv));
      if (rel > 0.05) notes.push(`field "${f}" sums diverge: original=${av}, rewritten=${bv} (rel=${rel.toFixed(3)})`);
    }
  }
  return { parity: notes.length === 0 ? 'match' : 'mismatch', notes };
}

function renderRow(row: ComparisonRow): string {
  const fence = (s: string) => '```dql\n' + s.trim() + '\n```';
  const j = (o: unknown) => '```json\n' + JSON.stringify(o, null, 2) + '\n```';
  const lines: string[] = [];
  lines.push(`## #${row.index + 1} · ${row.path}${row.path ? '.' : ''}${row.field}  — **${row.parity}**`);
  if (row.parityNotes.length > 0) for (const n of row.parityNotes) lines.push(`- ${n}`);
  if (row.warnings.length > 0) {
    lines.push('');
    lines.push('Rewriter warnings:');
    for (const w of row.warnings) lines.push(`- ${w}`);
  }
  lines.push('');
  lines.push('**Original:**');
  lines.push(fence(row.original));
  lines.push('');
  lines.push('**Rewritten:**');
  lines.push(fence(row.rewritten));
  lines.push('');
  lines.push(`**Original run:** rows=${row.originalRun.rowCount ?? '—'} · status=${row.originalRun.status}`);
  if (row.originalRun.fieldNames) lines.push(`fields: ${row.originalRun.fieldNames.join(', ')}`);
  if (row.originalRun.sampleRows) lines.push(j(row.originalRun.sampleRows));
  if (row.originalRun.error) lines.push('Error: ' + row.originalRun.error);
  lines.push('');
  lines.push(`**Rewritten run:** rows=${row.rewrittenRun.rowCount ?? '—'} · status=${row.rewrittenRun.status}`);
  if (row.rewrittenRun.fieldNames) lines.push(`fields: ${row.rewrittenRun.fieldNames.join(', ')}`);
  if (row.rewrittenRun.sampleRows) lines.push(j(row.rewrittenRun.sampleRows));
  if (row.rewrittenRun.error) lines.push('Error: ' + row.rewrittenRun.error);
  lines.push('');
  return lines.join('\n');
}

export async function runCompareDashboard(args: CompareDashboardArgs): Promise<void> {
  const mappingPath =
    args.mappingPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.with_recipes.json');
  const liveMetricsPath = args.liveMetricsPath ?? liveMetricsPathIfPresent(args.outDir);
  const index = await loadRecipeIndex(mappingPath, {
    dacPath: SKILL_DAC_AWS_METRICS,
    manualPath: SKILL_MANUAL_AWS_METRICS,
    perKeyPath: SKILL_PER_KEY_AWS_METRICS,
    liveMetricsPath,
    enrichedTagsPath: enrichedTagsPathIfPresent(args.outDir),
    entityCandidatesPath: entityCandidatesPathIfPresent(args.outDir),
    mzTagsPath: mzTagsPathIfPresent(args.outDir),
    minOverrideSeries: args.minOverrideSeries,
  });
  if (liveMetricsPath) {
    console.log(
      `Dim-validation: using ${liveMetricsPath} (min ${index.minOverrideSeries} target series)`
    );
  }

  const inputPath = resolve(args.input);
  const wrapper = JSON.parse(await readFile(inputPath, 'utf8')) as {
    metadata?: { id?: string; name?: string };
    content?: unknown;
  };
  const content: unknown =
    typeof wrapper.content === 'string' ? JSON.parse(wrapper.content) : wrapper.content;

  const queries: QueryRef[] = [];
  collectQueries(content, queries, '', args.includeVariables ?? true);

  const queue = args.limit ? queries.slice(0, args.limit) : queries;
  const dashName = wrapper.metadata?.name ?? basename(inputPath, '.json');
  console.log(`Comparing dashboard "${dashName}" — ${queue.length} queries`);

  const client = new DqlClient({
    baseUrl: args.baseUrl,
    token: args.token,
    onRetry: (info) =>
      console.log(`  retry ${info.attempt}: ${info.reason} (waiting ${info.delayMs.toFixed(0)}ms)`),
  });

  const rows: ComparisonRow[] = [];
  for (let i = 0; i < queue.length; i++) {
    const q = queue[i]!;
    const rewritten = rewriteDql(q.original, index);
    const subOriginal = substituteVariables(q.original, args.injectedVars);
    const subRewritten = substituteVariables(rewritten.rewritten, args.injectedVars);

    const [oRun, rRun] = await Promise.all([
      runOne(client, subOriginal, args.from, args.to),
      runOne(client, subRewritten, args.from, args.to),
    ]);
    const cmp = comparePair(oRun, rRun);
    rows.push({
      index: i,
      path: q.path,
      field: q.field,
      original: q.original,
      rewritten: rewritten.rewritten,
      identical: q.original === rewritten.rewritten,
      warnings: rewritten.warnings.map((w) => `[${w.kind}] ${w.text}`),
      originalRun: oRun,
      rewrittenRun: rRun,
      parity: cmp.parity,
      parityNotes: cmp.notes,
    });
    console.log(`  [${i + 1}/${queue.length}] ${q.path}.${q.field}  → ${cmp.parity}`);
  }

  // Summary
  const parityCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.parity] = (acc[r.parity] ?? 0) + 1;
    return acc;
  }, {});

  const baseName = basename(inputPath, '.json').replace(/\.rewritten$/, '');
  // args.outDir is the tenant root (tools/out/<env>); nest reports under it.
  const outDir = args.outDir
    ? join(args.outDir, 'dashboard-compare')
    : join(REPO_ROOT, 'tools', 'out', 'dashboard-compare');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `${baseName}.compare.md`);

  const header = [
    `# Compare report: ${dashName}`,
    '',
    `Source: \`${inputPath}\``,
    `Tenant: ${args.baseUrl}`,
    `Timeframe: ${args.from ?? '-2h'} → ${args.to ?? 'now'}`,
    `Queries compared: **${rows.length}**`,
    '',
    'Parity breakdown:',
    ...Object.entries(parityCounts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- **${k}**: ${v}`),
    '',
    '> Note: dashboard variables (`$Name`) are substituted with `array()` so `in(x, $Name)` filters reduce to no-op. Tile-style queries that depend on variables for correctness will look different from how they render in the UI.',
    '',
    '---',
    '',
  ].join('\n');

  const body = rows.map(renderRow).join('\n---\n\n');
  await writeFile(outPath, header + body);

  // JSON sibling so downstream tooling (migrate-refresh) can read parity
  // programmatically — the markdown is for humans, this is for the tracker.
  const jsonPath = join(outDir, `${baseName}.compare.json`);
  await writeFile(
    jsonPath,
    JSON.stringify(
      {
        generated: new Date().toISOString(),
        id: wrapper.metadata?.id ?? null,
        name: dashName,
        source: inputPath,
        tenant: args.baseUrl,
        timeframe: { from: args.from ?? '-2h', to: args.to ?? 'now' },
        parityCounts,
        tiles: rows.map((r) => ({ path: r.path, field: r.field, parity: r.parity, notes: r.parityNotes })),
      },
      null,
      2
    )
  );

  console.log('');
  console.log('Parity breakdown:', parityCounts);
  console.log(`Wrote ${outPath}`);
}
