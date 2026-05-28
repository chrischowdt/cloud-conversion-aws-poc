/**
 * rewrite-dashboard — apply the DQL rewriter to every query in a downloaded
 * dashboard JSON, producing a new dashboard JSON ready for upload alongside
 * a per-tile transform/warning report.
 *
 * Input file must be in the wrapper shape that `download-dashboards` writes:
 *   { metadata, content, contentType }
 * where `content` is the dashboard payload (string OR object).
 *
 * Outputs (next to the input, or under --out-dir):
 *   <basename>.rewritten.json     — dashboard ready to upload
 *   <basename>.rewrite-report.md  — markdown listing original/rewritten/warnings
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

import { rewriteDql, type Transform, type Warning } from '../lib/dql-rewriter.ts';
import { classicEntityToSmartscape } from '../lib/entity-mappings.ts';
import {
  REPO_ROOT,
  SKILL_DAC_AWS_METRICS,
  SKILL_MANUAL_AWS_METRICS,
  SKILL_PER_KEY_AWS_METRICS,
} from '../lib/paths.ts';
import { loadRecipeIndex, lookupClassicKey, type RecipeIndex } from '../lib/recipe-lookup.ts';

export interface RewriteDashboardArgs {
  input: string;
  mappingPath?: string;
  outDir?: string;
}

const QUERY_FIELD_NAMES = new Set(['query', 'input', 'dqlQuery']);

interface QueryHit {
  path: string;
  field: string;
  original: string;
  rewritten: string;
  transforms: Transform[];
  warnings: Warning[];
}

/**
 * Apply structured (non-DQL) rewrites to a string. Used for the dashboard's
 * "shadow" representations of a query: `queryConfig.subQueries[].metric.key`
 * (a bare classic metric key), `queryConfig.subQueries[].by[]` (bare classic
 * entity dim like `dt.entity.aws_lambda_function`), `queryConfig.subQueries[].filter`
 * (free-form filter expression), and the visualization config's column
 * references in `fieldMapping.leftAxisValues`, `hiddenLegendFields`, and
 * `table.columnTypeOverrides[].fields`.
 *
 * Without these rewrites the rewritten query emits columns under new names
 * but the visualization still references the old names → "Invalid data
 * mapping" / "field is no longer available" errors.
 *
 * Transforms applied (order matters):
 *   1. `agg(classic_key)` → `agg(new_key)` — for viz column references; no
 *      backticks (DQL strips them in result-column names, so viz refs
 *      shouldn't have them either).
 *   2. Bare classic metric key (e.g. `dt.cloud.aws.lambda.duration`) → new key.
 *   3. `dt.entity.X` → `dt.smartscape.X` (when X is mapped to a Smartscape type).
 *
 * Returns `null` if nothing changed (caller can leave the value alone).
 */
const AGG_CALL_COLUMN_RE =
  /\b(avg|sum|max|min|count|percentile|median)\(\s*((?:builtin:cloud\.aws|dt\.cloud\.aws|ext:cloud\.aws)\.[\w.:]+|cloud\.aws\.[a-z0-9_]+\.[a-z][\w]*)\s*\)/g;

const BARE_METRIC_KEY_RE =
  /\b((?:builtin:cloud\.aws|dt\.cloud\.aws|ext:cloud\.aws)\.[\w.:]+|cloud\.aws\.[a-z0-9_]+\.[a-z][\w]*)\b/g;

const BARE_ENTITY_DIM_RE = /\bdt\.entity\.([\w:]+)\b/g;

function rewriteStructuredString(input: string, index: RecipeIndex): string | null {
  let s = input;
  let changed = false;

  // 1. `agg(classic_key)` → `agg(new_key)` (no backticks). This is the form
  //    used in viz `leftAxisValues` / `hiddenLegendFields` / `columnTypeOverrides`.
  s = s.replace(AGG_CALL_COLUMN_RE, (full, agg: string, key: string) => {
    // Skip new-form keys (`.By.<PascalCase>`).
    if (/\.By\.[A-Z]/.test(key)) return full;
    const lookup = lookupClassicKey(index, key);
    if (lookup.kind === 'recipe' || lookup.kind === 'mapped-no-recipe') {
      const newKey = lookup.entry.newDtMetricKey;
      if (newKey) {
        changed = true;
        return `${agg}(${newKey})`;
      }
    }
    return full;
  });

  // 2. Bare classic metric key (e.g. in `queryConfig.subQueries[].metric.key`).
  //    Replace ONLY when the entire string is the key — partial matches would
  //    double-rewrite the agg-call form already swapped above.
  if (BARE_METRIC_KEY_RE.test(s.trim())) {
    BARE_METRIC_KEY_RE.lastIndex = 0;
    const wholeMatch = BARE_METRIC_KEY_RE.exec(s.trim());
    if (wholeMatch && wholeMatch[0] === s.trim() && !/\.By\.[A-Z]/.test(wholeMatch[0])) {
      const lookup = lookupClassicKey(index, wholeMatch[0]);
      if (lookup.kind === 'recipe' || lookup.kind === 'mapped-no-recipe') {
        const newKey = lookup.entry.newDtMetricKey;
        if (newKey) {
          changed = true;
          s = s.replace(wholeMatch[0], newKey);
        }
      }
    }
  }

  // 3. `dt.entity.X` → `dt.smartscape.X` (for `by[]` items and filter
  //    expressions inside queryConfig.subQueries).
  s = s.replace(BARE_ENTITY_DIM_RE, (full, entityType: string) => {
    const m = classicEntityToSmartscape(entityType);
    if (m && m.smartscapeDimension && m.status !== 'not-planned') {
      changed = true;
      return m.smartscapeDimension;
    }
    return full;
  });

  return changed ? s : null;
}

/**
 * Field-name heuristics for the structured-pass: which JSON keys hold strings
 * that may contain classic references the dashboard editor / visualization
 * layer cares about? Discovered empirically on the eCargo Lambda dashboard
 * (2026-05-12) — paths the renderer reads outside of the DQL query.
 *
 * The walker applies `rewriteStructuredString` to any string value reached
 * through one of these keys (recursively — arrays of strings inside).
 */
const STRUCTURED_FIELD_KEYS = new Set([
  'key', // queryConfig.subQueries[].metric.key
  'filter', // queryConfig.subQueries[].filter
]);

/**
 * Array-valued fields whose elements are column-name refs to rewrite.
 * Walker handles these by index, applying `rewriteStructuredString` per element.
 */
const STRUCTURED_ARRAY_KEYS = new Set([
  'by', // queryConfig.subQueries[].by[]
  'leftAxisValues', // viz fieldMapping.leftAxisValues[]
  'hiddenLegendFields', // viz chartSettings.hiddenLegendFields[]
  'fields', // viz table.columnTypeOverrides[].fields[]
]);

/**
 * Recursively walk a parsed dashboard, mutate every query/input/dqlQuery
 * string field with the rewriter output, and return the collected hits.
 * Only strings that look like DQL are rewritten — short strings or comma
 * lists (variable defaults) are left alone.
 *
 * Also applies a SECOND pass for structured (non-DQL) references: the
 * dashboard editor maintains a `queryConfig` mirror of each tile's query,
 * and the visualization layer references column names by literal string in
 * `fieldMapping.leftAxisValues` / `hiddenLegendFields` / similar paths.
 * Without rewriting those, the renderer reports "Invalid data mapping" /
 * "field is no longer available" even though the DQL query is correct.
 */
function rewriteInPlace(node: unknown, index: RecipeIndex, hits: QueryHit[], path: string): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => rewriteInPlace(v, index, hits, `${path}[${i}]`));
    return;
  }
  if (typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    const childPath = path ? `${path}.${k}` : k;
    if (
      QUERY_FIELD_NAMES.has(k) &&
      typeof v === 'string' &&
      v.length >= 30 &&
      /\b(fetch|timeseries|data record|metric\.series|fields|filter|summarize|describe|getNodeName)\b/.test(v)
    ) {
      const result = rewriteDql(v, index);
      // Only mutate when the rewriter actually changed something — leave
      // identical strings as-is to keep the diff small.
      if (result.rewritten !== v) obj[k] = result.rewritten;
      hits.push({
        path,
        field: k,
        original: result.original,
        rewritten: result.rewritten,
        transforms: result.transforms,
        warnings: result.warnings,
      });
      continue;
    }

    // Structured-field rewrites for non-DQL references the renderer also reads.
    if (STRUCTURED_FIELD_KEYS.has(k) && typeof v === 'string') {
      const rewritten = rewriteStructuredString(v, index);
      if (rewritten !== null) obj[k] = rewritten;
      continue;
    }
    if (STRUCTURED_ARRAY_KEYS.has(k) && Array.isArray(v)) {
      const next: unknown[] = [];
      let touched = false;
      for (const item of v) {
        if (typeof item === 'string') {
          const rw = rewriteStructuredString(item, index);
          if (rw !== null) {
            next.push(rw);
            touched = true;
          } else {
            next.push(item);
          }
        } else {
          next.push(item);
        }
      }
      if (touched) obj[k] = next;
      // Don't recurse into rewritten array elements — they're terminal strings.
      continue;
    }

    if (typeof v === 'object') rewriteInPlace(v, index, hits, childPath);
  }
}

function fenced(s: string): string {
  return '```dql\n' + s.trim() + '\n```';
}

function renderReport(input: string, dashName: string, hits: QueryHit[]): string {
  const lines: string[] = [];
  lines.push(`# Rewrite report: ${dashName}`);
  lines.push('');
  lines.push(`Source: \`${input}\``);
  lines.push(`Queries seen: **${hits.length}**`);
  const changed = hits.filter((h) => h.original !== h.rewritten).length;
  const flagged = hits.filter((h) => h.warnings.length > 0).length;
  const clean = hits.filter((h) => h.original !== h.rewritten && h.warnings.length === 0).length;
  lines.push(
    `Changed: **${changed}** · Clean rewrites: **${clean}** · With warnings: **${flagged}**`
  );
  lines.push('');
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    lines.push(`## #${i + 1} · ${h.path}${h.path ? '.' : ''}${h.field}`);
    lines.push('');
    lines.push('**Original:**');
    lines.push(fenced(h.original));
    lines.push('');
    lines.push('**Rewritten:**');
    lines.push(fenced(h.rewritten));
    lines.push('');
    if (h.transforms.length > 0) {
      lines.push(`Transforms (${h.transforms.length}):`);
      for (const t of h.transforms) {
        lines.push(`- \`[${t.kind}]\` ${t.before} → ${t.after}`);
        if (t.detail) lines.push(`  - ${t.detail}`);
      }
      lines.push('');
    }
    if (h.warnings.length > 0) {
      lines.push(`Warnings (${h.warnings.length}):`);
      for (const w of h.warnings) {
        lines.push(`- \`[${w.kind}]\` ${w.text.replace(/\n/g, ' ')}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n') + '\n';
}

export async function runRewriteDashboard(args: RewriteDashboardArgs): Promise<{
  outDashboardPath: string;
  outReportPath: string;
  hits: number;
  changed: number;
  flagged: number;
}> {
  const mappingPath =
    args.mappingPath ?? join(REPO_ROOT, 'mappings', 'aws_mapping.with_recipes.json');
  const index = await loadRecipeIndex(mappingPath, {
    dacPath: SKILL_DAC_AWS_METRICS,
    manualPath: SKILL_MANUAL_AWS_METRICS,
    perKeyPath: SKILL_PER_KEY_AWS_METRICS,
  });

  const inputPath = resolve(args.input);
  const raw = await readFile(inputPath, 'utf8');
  const wrapper = JSON.parse(raw) as {
    metadata?: { id?: string; name?: string };
    content?: unknown;
    contentType?: string;
  };

  // Parse the content if it's a string (the download-dashboards wrapper
  // stores it as text when contentType is application/octet-stream).
  const contentWasString = typeof wrapper.content === 'string';
  const content: unknown = contentWasString
    ? JSON.parse(wrapper.content as string)
    : wrapper.content;

  const hits: QueryHit[] = [];
  rewriteInPlace(content, index, hits, '');

  const out = {
    ...wrapper,
    content: contentWasString ? JSON.stringify(content, null, 2) : content,
  };

  const dashName = wrapper.metadata?.name ?? basename(inputPath, '.json');
  const baseName = basename(inputPath, '.json');
  const outDir = args.outDir ?? dirname(inputPath);
  await mkdir(outDir, { recursive: true });
  const outDashboardPath = join(outDir, `${baseName}.rewritten.json`);
  const outReportPath = join(outDir, `${baseName}.rewrite-report.md`);
  // Upload-ready form: the inner content payload only (no wrapper), with a
  // `(rewritten)` suffix on the dashboard name so it doesn't collide on
  // upload with the classic source. Drop in via the Dynatrace import UI or
  // POST to the Document Service with `type: dashboard`.
  const outUploadPath = join(outDir, `${baseName}.upload.json`);
  const uploadContent =
    content !== null && typeof content === 'object'
      ? (JSON.parse(JSON.stringify(content)) as Record<string, unknown>)
      : ({} as Record<string, unknown>);
  const settings = (uploadContent.settings as Record<string, unknown> | undefined) ?? {};
  const origName = (settings.name as string | undefined) ?? dashName;
  if (!String(origName).endsWith('(rewritten)')) {
    settings.name = `${origName} (rewritten)`;
    uploadContent.settings = settings;
  }
  await writeFile(outDashboardPath, JSON.stringify(out, null, 2));
  await writeFile(outReportPath, renderReport(inputPath, dashName, hits));
  await writeFile(outUploadPath, JSON.stringify(uploadContent, null, 2));

  const changed = hits.filter((h) => h.original !== h.rewritten).length;
  const flagged = hits.filter((h) => h.warnings.length > 0).length;
  console.log(`Rewrote dashboard "${dashName}"`);
  console.log(`  queries seen:    ${hits.length}`);
  console.log(`  queries changed: ${changed}`);
  console.log(`  flagged:         ${flagged}`);
  console.log(`Wrote ${outDashboardPath}`);
  console.log(`Wrote ${outReportPath}`);
  console.log(`Wrote ${outUploadPath} (upload-ready content)`);
  return { outDashboardPath, outReportPath, hits: hits.length, changed, flagged };
}
