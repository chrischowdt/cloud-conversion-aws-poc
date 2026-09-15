/**
 * discover-entity-candidates — turn the product team's entity file into entity
 * mappings we can actually trust, by asking the tenant about each one.
 *
 * `entity-mappings.ts` is hand-curated, and a classic type missing from it
 * becomes a BLOCKING `unmapped-entity-type` that can hold an entire dashboard
 * out of review. The skill's `dac-aws-to-2ndgen-entities.json` already lists far
 * more types than we map — but its `dacResourceType` is a resource name, not a
 * Smartscape node type, and deriving one from the other is a GUESS. Guesses in
 * this area have been wrong before (`AWS_KAFKA_CLUSTER` does not exist; classic
 * `cloud:aws:kafka` is MSK), and a wrong node type produces a query that runs
 * and returns nothing.
 *
 * So every derived candidate is probed — `smartscapeNodes <TYPE> | limit 1` —
 * and only the ones the tenant confirms are written out. Types already covered
 * by the curated table are skipped, never overwritten.
 *
 * Read-only against the tenant. Writes `<tenant>/entity-candidates.json`.
 * Scopes: storage:entities:read (via the DQL endpoint).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DqlClient } from '../dynatrace/dql.ts';
import { OUT_DIR, REFERENCE_AWS_ENTITIES } from '../lib/paths.ts';
import { classicEntityToSmartscape } from '../lib/entity-mappings.ts';
import { deriveCandidates, type EntityCandidate, type EntityCandidateFile } from '../lib/entity-candidates.ts';

export interface DiscoverEntityCandidatesArgs {
  baseUrl: string;
  token: string;
  outDir?: string;
  /** Override the skill entity file (defaults to the bundled reference copy). */
  entitiesPath?: string;
  /** Probe at most this many candidates (they run one at a time). */
  limit?: number;
}

export async function runDiscoverEntityCandidates(args: DiscoverEntityCandidatesArgs): Promise<void> {
  const outDir = args.outDir ?? OUT_DIR;
  await mkdir(outDir, { recursive: true });
  const entitiesPath = args.entitiesPath ?? REFERENCE_AWS_ENTITIES;

  const raw = JSON.parse(await readFile(entitiesPath, 'utf8')) as unknown;
  const all = deriveCandidates(raw);
  // Anything the curated table already answers is not a candidate — a derived
  // row must never displace hand-verified knowledge.
  let candidates = all.filter((c) => !classicEntityToSmartscape(c.classicEntityType));
  if (args.limit) candidates = candidates.slice(0, args.limit);

  console.log(`Entity file: ${all.length} classic type(s); ${all.length - candidates.length} already mapped.`);
  console.log(`Probing ${candidates.length} candidate node type(s) on ${args.baseUrl}…`);

  const client = new DqlClient({ baseUrl: args.baseUrl, token: args.token });
  const verified: EntityCandidate[] = [];
  const rejected: EntityCandidateFile['rejected'] = [];
  // One probe per distinct node type — many classic types share one.
  const nodeVerdict = new Map<string, { ok: boolean; reason: string }>();

  for (const c of candidates) {
    let verdict = nodeVerdict.get(c.smartscapeNodeType);
    if (!verdict) {
      try {
        const res = await client.query({ query: `smartscapeNodes ${c.smartscapeNodeType} | summarize n = count()` });
        const rec = (res.records ?? [])[0] as Record<string, unknown> | undefined;
        const n = Number(rec?.['n'] ?? 0);
        verdict = n > 0
          ? { ok: true, reason: `${n} node(s)` }
          : { ok: false, reason: 'node type exists but has no instances on this tenant' };
      } catch (e) {
        // An unknown node type is a query error, which is exactly the signal we
        // want — record it rather than letting it abort the sweep.
        verdict = { ok: false, reason: `rejected by tenant: ${(e as Error).message.slice(0, 80)}` };
      }
      nodeVerdict.set(c.smartscapeNodeType, verdict);
    }
    if (verdict.ok) {
      verified.push(c);
      console.log(`  ✓ ${c.classicEntityType.padEnd(32)} -> ${c.smartscapeNodeType} (${verdict.reason})`);
    } else {
      rejected.push({ classicEntityType: c.classicEntityType, smartscapeNodeType: c.smartscapeNodeType, reason: verdict.reason });
    }
  }

  const file: EntityCandidateFile = {
    generated: new Date().toISOString(),
    tenant: args.baseUrl,
    verified,
    rejected,
  };
  const dest = join(outDir, 'entity-candidates.json');
  await writeFile(dest, JSON.stringify(file, null, 2));

  console.log('');
  console.log(`Verified ${verified.length} new mapping(s); ${rejected.length} candidate(s) had no usable node type.`);
  console.log(`Wrote ${dest}`);
  if (verified.length) {
    console.log('These load automatically on the next scan/stage for this tenant.');
  }
}
