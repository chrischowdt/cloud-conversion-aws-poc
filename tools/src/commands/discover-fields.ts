/**
 * discover-fields — query the tenant for both sides of every known
 * classic→Smartscape entity pair and dump the field names each side returns.
 *
 * Output is reviewed by hand to build entries in entity-field-mappings.ts.
 * For each pair this writes:
 *   - classic fields (from `fetch dt.entity.<type> | limit 5`)
 *   - smartscape fields (from `smartscapeNodes <TYPE> | limit 5`)
 *   - a heuristic match (snake_case ↔ camelCase, exact, substring) per
 *     classic field so the human reviewer can spot the right pairing fast
 *
 * If either side errors (entity type not present, permissions, etc.) the
 * row is recorded with the error message rather than silently dropped.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DqlClient, DqlError } from '../dynatrace/dql.ts';
import { AWS_ENTITY_MAPPINGS } from '../lib/entity-mappings.ts';
import { OUT_DIR } from '../lib/paths.ts';

export interface DiscoverFieldsArgs {
  baseUrl: string;
  token: string;
  outDir?: string;
  /** Only run pairs matching this substring (case-insensitive). */
  filter?: string;
  /** Skip pairs with these classic types. */
  exclude?: string[];
}

interface FieldDiscoveryRow {
  classicEntityType: string;
  smartscapeNodeType: string;
  classicStatus: 'ok' | 'empty' | 'error';
  classicError?: string;
  classicFields: string[];
  smartscapeStatus: 'ok' | 'empty' | 'error';
  smartscapeError?: string;
  smartscapeFields: string[];
  /** Per classic field: candidate smartscape matches (best-effort). */
  candidateMatches: Record<string, string[]>;
}

function camelToDotted(s: string): string {
  return s.replace(/[A-Z]/g, (m) => '.' + m.toLowerCase()).replace(/^\./, '');
}

function findCandidates(classicField: string, smartscapeFields: string[]): string[] {
  if (classicField === 'entity.name') return smartscapeFields.includes('name') ? ['name'] : [];
  const direct = smartscapeFields.find((f) => f === classicField);
  if (direct) return [direct];
  const dottedGuess = camelToDotted(classicField);
  const matches = new Set<string>();
  for (const f of smartscapeFields) {
    if (f === classicField || f === dottedGuess) matches.add(f);
    const flat = f.replace(/[._]/g, '').toLowerCase();
    const classicFlat = classicField.replace(/[._]/g, '').toLowerCase();
    if (flat === classicFlat || flat.endsWith(classicFlat) || classicFlat.endsWith(flat)) {
      matches.add(f);
    }
  }
  // Also: substring match either direction (only when one is short enough to be specific).
  for (const f of smartscapeFields) {
    const fl = f.toLowerCase();
    const cl = classicField.toLowerCase();
    if (cl.length >= 5 && (fl.includes(cl) || cl.includes(fl))) matches.add(f);
  }
  return [...matches].slice(0, 4);
}

async function tryQuery(
  client: DqlClient,
  q: string
): Promise<{ status: 'ok' | 'empty' | 'error'; fields: string[]; error?: string }> {
  try {
    const r = await client.query({ query: q, maxResultRecords: 5 });
    if ((r.records?.length ?? 0) === 0) return { status: 'empty', fields: [] };
    const fields = new Set<string>();
    for (const row of r.records) for (const k of Object.keys(row)) fields.add(k);
    return { status: 'ok', fields: [...fields].sort() };
  } catch (e) {
    if (e instanceof DqlError) {
      return { status: 'error', fields: [], error: `HTTP ${e.status}: ${e.body.slice(0, 200)}` };
    }
    return { status: 'error', fields: [], error: (e as Error).message };
  }
}

export async function runDiscoverFields(args: DiscoverFieldsArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  await mkdir(outDir, { recursive: true });

  const mappings = AWS_ENTITY_MAPPINGS.filter(
    (m) => m.status !== 'not-planned' && m.smartscapeNodeType && m.smartscapeDimension
  );
  const filter = args.filter?.toLowerCase();
  const exclude = new Set(args.exclude ?? []);
  const todo = mappings.filter(
    (m) =>
      !exclude.has(m.classicEntityType) &&
      (!filter || m.classicEntityType.toLowerCase().includes(filter) || m.smartscapeNodeType.toLowerCase().includes(filter))
  );

  const client = new DqlClient({
    baseUrl: args.baseUrl,
    token: args.token,
    onRetry: (info) =>
      console.log(`  retry ${info.attempt}: ${info.reason} (waiting ${info.delayMs.toFixed(0)}ms)`),
  });

  console.log(`Discovering fields for ${todo.length} entity pairs…`);
  const rows: FieldDiscoveryRow[] = [];
  for (let i = 0; i < todo.length; i++) {
    const m = todo[i]!;
    const classicQ = `fetch \`dt.entity.${m.classicEntityType}\` | limit 5`;
    const smartscapeQ = `smartscapeNodes ${m.smartscapeNodeType} | limit 5`;
    const [classicRes, smartscapeRes] = await Promise.all([
      tryQuery(client, classicQ),
      tryQuery(client, smartscapeQ),
    ]);

    const candidates: Record<string, string[]> = {};
    for (const f of classicRes.fields) {
      candidates[f] = findCandidates(f, smartscapeRes.fields);
    }

    rows.push({
      classicEntityType: m.classicEntityType,
      smartscapeNodeType: m.smartscapeNodeType,
      classicStatus: classicRes.status,
      classicError: classicRes.error,
      classicFields: classicRes.fields,
      smartscapeStatus: smartscapeRes.status,
      smartscapeError: smartscapeRes.error,
      smartscapeFields: smartscapeRes.fields,
      candidateMatches: candidates,
    });
    console.log(
      `  [${i + 1}/${todo.length}] ${m.classicEntityType} ↔ ${m.smartscapeNodeType}  — ` +
        `classic=${classicRes.status}(${classicRes.fields.length}) ` +
        `smartscape=${smartscapeRes.status}(${smartscapeRes.fields.length})`
    );
  }

  const outPath = join(outDir, 'entity-field-discovery.json');
  await writeFile(outPath, JSON.stringify({ generated: new Date().toISOString(), rows }, null, 2));
  console.log('');
  console.log(`Wrote ${outPath}`);
}
