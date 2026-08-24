/**
 * discover-management-zones — read the tenant's classic management zones and
 * reduce each to the AWS tag predicates that define its AWS membership, so the
 * rewriter can turn `mzName("…")` into a native enriched-tag dimension filter.
 *
 * Read-only. Writes `<tenant>/management-zones.json`:
 *   { zones: [ { name, tags: [{key,value}], ruleCount, awsRuleCount } ], ... }
 *
 * Zones whose AWS rules don't reduce to a consistent tag set are recorded with
 * an empty `tags` array — the rewriter then leaves them untranslated rather
 * than guessing at an alert's scope.
 *
 * Required scope: `settings:objects:read`.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SettingsClient } from '../dynatrace/settings.ts';
import { extractAwsTagPredicates, tagDimension, type MzTagPredicate } from '../lib/mz-tags.ts';

export interface DiscoverManagementZonesArgs {
  outDir: string;
  baseUrl: string;
  token: string;
  /** Only fetch zones whose name contains this (server-side filter; keeps big tenants fast). */
  nameContains?: string;
  pageSize?: number;
}

interface ZoneOut {
  name: string;
  tags: MzTagPredicate[];
  filter: string;
  ruleCount: number;
}

export async function runDiscoverManagementZones(args: DiscoverManagementZonesArgs): Promise<void> {
  const client = new SettingsClient({
    baseUrl: args.baseUrl,
    token: args.token,
    maxRetries: 6,
    retryBaseMs: 1500,
    onRetry: (i) => console.log(`   retry ${i.attempt} in ${Math.round(i.delayMs)}ms (${i.reason})`),
  });

  console.log(
    `Fetching management zones${args.nameContains ? ` matching "${args.nameContains}"` : ' (all)'}…`
  );
  const objects = await client.listAllObjects({
    schemaId: 'builtin:management-zones',
    pageSize: args.pageSize ?? 200,
    filter: args.nameContains ? `value.name contains '${args.nameContains.replace(/'/g, "\\'")}'` : undefined,
    onPage: (n, t) => process.stdout.write(`\r  fetched ${n}${t ? '/' + t : ''}   `),
  });
  console.log(`\n  ${objects.length} zone(s)`);

  const zones: ZoneOut[] = [];
  let reduced = 0;
  for (const o of objects) {
    const v = o.value as { name?: string; rules?: unknown[] };
    const name = v?.name;
    if (!name) continue;
    const tags = extractAwsTagPredicates(v);
    if (tags.length) reduced++;
    zones.push({
      name,
      tags,
      filter: tags.map((t) => `\`${tagDimension(t.key)}\` == ${JSON.stringify(t.value)}`).join(' and '),
      ruleCount: Array.isArray(v.rules) ? v.rules.length : 0,
    });
  }
  zones.sort((a, b) => a.name.localeCompare(b.name));

  await mkdir(args.outDir, { recursive: true });
  const outPath = join(args.outDir, 'management-zones.json');
  await writeFile(
    outPath,
    JSON.stringify({ generated: new Date().toISOString(), baseUrl: args.baseUrl, count: zones.length, zones }, null, 2)
  );

  console.log(`  reduced to AWS tag filters: ${reduced}/${zones.length}`);
  for (const z of zones.filter((x) => x.tags.length).slice(0, 12)) {
    console.log(`    ${z.name}  ->  ${z.filter}`);
  }
  const unreduced = zones.filter((z) => !z.tags.length);
  if (unreduced.length) {
    console.log(
      `  ${unreduced.length} zone(s) had no consistent AWS tag rules — left untranslated (rewriter keeps blocking them).`
    );
  }
  console.log(`Wrote ${outPath}`);
}
