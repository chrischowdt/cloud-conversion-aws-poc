/**
 * scan-dashboards — run the DQL rewriter against every downloaded new
 * dashboard, filtered to those that actually reference AWS.
 *
 * Pipeline:
 *   1. List `*.json` in the input dir (default: tools/out/dashboards/new).
 *   2. Per file, parse the wrapper { metadata, content, contentType } that
 *      download-dashboards writes; `content` is a JSON string OR object.
 *   3. AWS-detection: skip files whose serialized content doesn't reference
 *      `dt.cloud.aws.`, `builtin:cloud.aws.`, `dt.entity.aws_`, or
 *      `cloud:aws:` (the AWS custom_device entity-type tag).
 *   4. For each AWS dashboard, walk the parsed content and extract every
 *      DQL-bearing string field (`query`, `input`, `dqlQuery`) ≥ 30 chars.
 *      Run `rewriteDql` on each.
 *   5. Aggregate transforms + warnings into a summary, and stream
 *      per-dashboard results to JSONL.
 *
 * Outputs:
 *   tools/out/dashboard-scan/summary.json
 *   tools/out/dashboard-scan/results.jsonl
 *   tools/out/dashboard-scan/skipped.txt  — files filtered out as non-AWS
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';

import { rewriteDql, isBlockingWarning, type Transform, type Warning } from '../lib/dql-rewriter.ts';
import {
  OUT_DIR,
  REPO_ROOT,
  SKILL_DAC_AWS_METRICS,
  SKILL_MANUAL_AWS_METRICS,
  SKILL_PER_KEY_AWS_METRICS,
} from '../lib/paths.ts';
import { liveMetricsPathIfPresent } from '../lib/live-metrics.ts';
import { loadRecipeIndex } from '../lib/recipe-lookup.ts';

export interface ScanDashboardsArgs {
  inputDir?: string;
  mappingPath?: string;
  outDir?: string;
  /** Process at most N AWS dashboards (post-filter). */
  limit?: number;
  /** Skip the AWS filter and scan everything. */
  all?: boolean;
  /**
   * Explicit `live-metrics.json` path for dim-variant validation. Defaults to
   * `<tenant-dir>/live-metrics.json` if present (run `discover-metrics` first).
   */
  liveMetricsPath?: string;
  /** Minimum target-series count before a dim-override fires (default 2). */
  minOverrideSeries?: number;
}

// AWS markers — any one of these in the file content makes the dashboard
// "AWS-using" for our purposes. Run as substring contains over the serialized
// content (cheap and avoids re-walking the JSON twice).
const AWS_MARKERS = [
  'dt.cloud.aws.',
  'builtin:cloud.aws.',
  'dt.entity.aws_',
  'cloud:aws:',
];

const QUERY_FIELD_NAMES = new Set(['query', 'input', 'dqlQuery']);

interface QueryRef {
  /** Tile id or variable name, for pointing back at it later. */
  location: string;
  field: string;
  query: string;
}

interface PerDashboardResult {
  id: string;
  name: string;
  file: string;
  queryCount: number;
  /** Queries we actually changed (≥1 transform). */
  rewrittenCount: number;
  /** Queries we changed cleanly (≥1 transform, 0 warnings). */
  cleanCount: number;
  /** Queries the rewriter flagged (≥1 warning). */
  flaggedCount: number;
  transforms: Record<string, number>;
  warnings: Record<string, number>;
  details: Array<{
    location: string;
    field: string;
    original: string;
    rewritten: string;
    transformCount: number;
    warningCount: number;
    transformKinds: string[];
    warningKinds: string[];
  }>;
}

interface SummaryReport {
  generated: string;
  inputDir: string;
  totals: {
    files: number;
    presetFiles: number;
    awsFiles: number;
    nonAwsFiles: number;
    parseErrors: number;
    queries: number;
    rewrittenQueries: number;
    cleanQueries: number;
    flaggedQueries: number;
    // Reframed success buckets (every query lands in exactly one):
    //   convertedClean = transform, no warnings (== cleanQueries)
    //   convertedSoft  = warnings, but none blocking (working DQL + verify-me)
    //   blocked        = ≥1 blocking warning (no new equivalent / needs manual)
    //   noopQueries    = no transform and no warnings (already new-form / non-DQL)
    // "converted" = convertedClean + convertedSoft.
    convertedSoft: number;
    blocked: number;
    noopQueries: number;
  };
  transformKindCounts: Record<string, number>;
  warningKindCounts: Record<string, number>;
  topFlaggedWarningExamples: Array<{
    kind: string;
    text: string;
    file: string;
    location: string;
  }>;
}

/**
 * Dynatrace-managed preset dashboards have `metadata.originAppId` starting
 * with `dynatrace.` (e.g. `dynatrace.clouds`, `dynatrace.kubernetes`). Per
 * [dt-migration/references/dashboard-scanning.md], these are auto-updated
 * during cloud migration and should not be scanned — they aren't actionable
 * user dashboards.
 */
function isPresetDashboard(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const originAppId = (metadata as Record<string, unknown>).originAppId;
  return typeof originAppId === 'string' && originAppId.startsWith('dynatrace.');
}

function bump<K extends string>(m: Record<K, number>, k: K): void {
  m[k] = (m[k] ?? 0) + 1;
}

function safeParseContent(raw: unknown): unknown | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectQueries(content: unknown, out: QueryRef[], path: string): void {
  if (content === null || content === undefined) return;
  if (Array.isArray(content)) {
    content.forEach((v, i) => collectQueries(v, out, `${path}[${i}]`));
    return;
  }
  if (typeof content !== 'object') return;
  for (const [k, v] of Object.entries(content as Record<string, unknown>)) {
    const childPath = path ? `${path}.${k}` : k;
    if (QUERY_FIELD_NAMES.has(k) && typeof v === 'string' && v.length >= 30) {
      // Crude guard: skip strings that obviously aren't DQL (no recognizable
      // command keyword). Keeps `input` / `content` fields holding free text
      // out of the report.
      if (/\b(fetch|timeseries|data record|metric\.series|fields|filter|summarize|describe|getNodeName)\b/.test(v)) {
        out.push({ location: path || '(root)', field: k, query: v });
      }
      continue;
    }
    if (typeof v === 'object') collectQueries(v, out, childPath);
  }
}

function hasAwsMarker(s: string): boolean {
  for (const m of AWS_MARKERS) if (s.includes(m)) return true;
  return false;
}

/** True if any extracted query references AWS. UI groupBy lists and similar
 *  fields don't count — those leak through a whole-file scan but aren't real
 *  AWS usage (see the AAP : JET : CS Reliability case, whose 143 `fetch logs`
 *  queries pass the whole-file filter only because a variable's `groupBy`
 *  list mentions `dt.entity.aws_availability_zone`). */
function anyQueryIsAws(queries: QueryRef[]): boolean {
  for (const q of queries) {
    if (hasAwsMarker(q.query)) return true;
  }
  return false;
}

export async function runScanDashboards(args: ScanDashboardsArgs): Promise<void> {
  // Base = the tenant output dir. When only --input-dir was given, derive the
  // tenant root as its grandparent (…/<env>/dashboards/new → …/<env>).
  const base =
    args.outDir ?? (args.inputDir ? resolve(args.inputDir, '..', '..') : OUT_DIR);
  const scanDir = join(base, 'dashboard-scan');
  await mkdir(scanDir, { recursive: true });
  const inputDir = args.inputDir ?? join(base, 'dashboards', 'new');
  const mappingPath =
    args.mappingPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.with_recipes.json');

  const liveMetricsPath = args.liveMetricsPath ?? liveMetricsPathIfPresent(base);
  const index = await loadRecipeIndex(mappingPath, {
    dacPath: SKILL_DAC_AWS_METRICS,
    manualPath: SKILL_MANUAL_AWS_METRICS,
    perKeyPath: SKILL_PER_KEY_AWS_METRICS,
    liveMetricsPath,
    minOverrideSeries: args.minOverrideSeries,
  });
  if (liveMetricsPath) {
    console.log(
      `Dim-validation: using ${liveMetricsPath} (min ${index.minOverrideSeries} target series)`
    );
  }
  const files = (await readdir(inputDir)).filter((f) => f.endsWith('.json'));
  console.log(`Scanning ${files.length} dashboards in ${inputDir}`);

  const summary: SummaryReport = {
    generated: new Date().toISOString(),
    inputDir,
    totals: {
      files: files.length,
      presetFiles: 0,
      awsFiles: 0,
      nonAwsFiles: 0,
      parseErrors: 0,
      queries: 0,
      rewrittenQueries: 0,
      cleanQueries: 0,
      flaggedQueries: 0,
      convertedSoft: 0,
      blocked: 0,
      noopQueries: 0,
    },
    transformKindCounts: {},
    warningKindCounts: {},
    topFlaggedWarningExamples: [],
  };

  const resultsPath = join(scanDir, 'results.jsonl');
  const skippedPath = join(scanDir, 'skipped.txt');
  const resultsStream = createWriteStream(resultsPath, { encoding: 'utf8' });
  const skippedStream = createWriteStream(skippedPath, { encoding: 'utf8' });

  const exampleSeenKinds = new Set<string>();
  let awsCounted = 0;

  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const filePath = join(inputDir, file);
      let parsed: { metadata?: { id?: string; name?: string }; content?: unknown };
      try {
        parsed = JSON.parse(await readFile(filePath, 'utf8'));
      } catch {
        summary.totals.parseErrors++;
        skippedStream.write(`${file}\tparse-error\n`);
        continue;
      }

      if (isPresetDashboard(parsed.metadata)) {
        summary.totals.presetFiles++;
        skippedStream.write(`${file}\tpreset-dashboard\n`);
        continue;
      }

      const rawContent = parsed.content;
      const content = safeParseContent(rawContent);
      if (content === null) {
        summary.totals.parseErrors++;
        skippedStream.write(`${file}\tinner-parse-error\n`);
        continue;
      }

      const queries: QueryRef[] = [];
      collectQueries(content, queries, '');

      if (!args.all && !anyQueryIsAws(queries)) {
        summary.totals.nonAwsFiles++;
        skippedStream.write(`${file}\tnot-aws\n`);
        continue;
      }
      summary.totals.awsFiles++;

      if (args.limit && awsCounted >= args.limit) {
        skippedStream.write(`${file}\tover-limit\n`);
        continue;
      }
      awsCounted++;

      const id = parsed.metadata?.id ?? file;
      const name = parsed.metadata?.name ?? '(unnamed)';
      const perDash: PerDashboardResult = {
        id,
        name,
        file,
        queryCount: queries.length,
        rewrittenCount: 0,
        cleanCount: 0,
        flaggedCount: 0,
        transforms: {},
        warnings: {},
        details: [],
      };

      for (const q of queries) {
        summary.totals.queries++;
        const r = rewriteDql(q.query, index);
        const tCount = r.transforms.length;
        const wCount = r.warnings.length;
        // `non-aws-entity` is an informational "left untouched" note (the entity
        // migrates with the general tooling and isn't decommissioned here), NOT
        // an AWS-conversion caveat — so it doesn't count toward clean/soft/
        // blocked/flagged. A query whose only warning is that note, with no AWS
        // transform, is a no-op for this automation.
        const awsW = r.warnings.filter((w) => w.kind !== 'non-aws-entity').length;
        if (tCount > 0) {
          perDash.rewrittenCount++;
          summary.totals.rewrittenQueries++;
        }
        if (tCount > 0 && awsW === 0) {
          perDash.cleanCount++;
          summary.totals.cleanQueries++;
        }
        if (awsW > 0) {
          perDash.flaggedCount++;
          summary.totals.flaggedQueries++;
        }
        // Reframed buckets (exactly one): blocked > soft-converted > clean > no-op.
        const hasBlocking = r.warnings.some((w) => w.kind !== 'non-aws-entity' && isBlockingWarning(w.kind));
        if (hasBlocking) summary.totals.blocked++;
        else if (awsW > 0) summary.totals.convertedSoft++;
        else if (tCount === 0) summary.totals.noopQueries++;
        const tKinds = new Set<string>();
        for (const t of r.transforms) {
          bump(perDash.transforms, t.kind);
          bump(summary.transformKindCounts, t.kind);
          tKinds.add(t.kind);
        }
        const wKinds = new Set<string>();
        for (const w of r.warnings) {
          bump(perDash.warnings, w.kind);
          bump(summary.warningKindCounts, w.kind);
          wKinds.add(w.kind);
          if (!exampleSeenKinds.has(w.kind)) {
            exampleSeenKinds.add(w.kind);
            summary.topFlaggedWarningExamples.push({
              kind: w.kind,
              text: w.text.slice(0, 220),
              file,
              location: q.location,
            });
          }
        }
        perDash.details.push({
          location: q.location,
          field: q.field,
          original: r.original,
          rewritten: r.rewritten,
          transformCount: tCount,
          warningCount: wCount,
          transformKinds: [...tKinds],
          warningKinds: [...wKinds],
        });
      }

      resultsStream.write(JSON.stringify(perDash) + '\n');

      if ((i + 1) % 200 === 0 || i === files.length - 1) {
        console.log(
          `  ${i + 1}/${files.length} — aws=${summary.totals.awsFiles} ` +
            `q=${summary.totals.queries} rewritten=${summary.totals.rewrittenQueries} ` +
            `clean=${summary.totals.cleanQueries} flagged=${summary.totals.flaggedQueries}`
        );
      }
    }
  } finally {
    resultsStream.end();
    skippedStream.end();
  }

  const summaryPath = join(scanDir, 'summary.json');
  await writeFile(summaryPath, JSON.stringify(summary, null, 2));

  console.log('');
  console.log('=== SCAN COMPLETE ===');
  console.log(`Files scanned:     ${summary.totals.files}`);
  console.log(`  Preset (skipped):${summary.totals.presetFiles}`);
  console.log(`  AWS dashboards:  ${summary.totals.awsFiles}`);
  console.log(`  Non-AWS:         ${summary.totals.nonAwsFiles}`);
  console.log(`  Parse errors:    ${summary.totals.parseErrors}`);
  console.log(`Queries seen:      ${summary.totals.queries}`);
  console.log(`  Rewritten (≥1 transform): ${summary.totals.rewrittenQueries}`);
  const qN = summary.totals.queries || 1;
  const qpct = (n: number) => `${((100 * n) / qN).toFixed(1)}%`;
  const converted = summary.totals.cleanQueries + summary.totals.convertedSoft;
  console.log('');
  console.log('Conversion outcome (every query in exactly one bucket):');
  console.log(`  CONVERTED:                    ${converted} (${qpct(converted)})`);
  console.log(`    · clean (0 warnings):       ${summary.totals.cleanQueries} (${qpct(summary.totals.cleanQueries)})`);
  console.log(`    · converted + verify caveat:${summary.totals.convertedSoft} (${qpct(summary.totals.convertedSoft)})`);
  console.log(`  BLOCKED (no equiv / manual):  ${summary.totals.blocked} (${qpct(summary.totals.blocked)})`);
  console.log(`  No-op (already new / non-DQL):${summary.totals.noopQueries} (${qpct(summary.totals.noopQueries)})`);
  console.log('');
  console.log('Top transform kinds:');
  for (const [k, v] of Object.entries(summary.transformKindCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
  console.log('Top warning kinds:');
  for (const [k, v] of Object.entries(summary.warningKindCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${v}`);
  }
  console.log('');
  console.log(`Wrote ${summaryPath}`);
  console.log(`Wrote ${resultsPath}`);
  console.log(`Wrote ${skippedPath}`);
}
