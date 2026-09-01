/**
 * discover-users — harvest user UUID -> email pairs so the tracker can show who
 * actually owns a dashboard instead of a raw id.
 *
 * There is no simple non-Account-Management API for this mapping, but the
 * query-execution audit trail carries both fields, so we read them from there.
 * Only users who RAN A QUERY in the window appear — see lib/users.ts.
 *
 * Read-only. Writes `<tenant>/users.json`; migrate-refresh picks it up
 * automatically.
 *
 * Required scope: access to `dt.system.query_executions` in Grail.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DqlClient } from '../dynatrace/dql.ts';

export interface DiscoverUsersArgs {
  outDir: string;
  baseUrl: string;
  token: string;
  /** Look-back window in days (default 90). Longer sees more people. */
  days?: number;
}

export async function runDiscoverUsers(args: DiscoverUsersArgs): Promise<void> {
  const days = args.days ?? 90;
  const client = new DqlClient({ baseUrl: args.baseUrl, token: args.token });
  const query =
    `fetch dt.system.query_executions, from: now()-${days}d\n` +
    `| fields user.email, user.id\n` +
    `| dedup user.email`;

  console.log(`Harvesting user ids -> emails from query executions (last ${days}d)…`);
  const res = await client.query({ query, maxResultRecords: 100_000, fetchTimeoutSeconds: 120 });

  const byId = new Map<string, string>();
  for (const r of res.records) {
    const id = r['user.id'];
    const email = r['user.email'];
    if (typeof id === 'string' && typeof email === 'string' && id && email && !byId.has(id)) {
      byId.set(id, email);
    }
  }
  const users = [...byId].map(([id, email]) => ({ id, email })).sort((a, b) => a.email.localeCompare(b.email));
  const service = users.filter((u) => u.email.endsWith('@service.sso.dynatrace.com')).length;

  await mkdir(args.outDir, { recursive: true });
  const outPath = join(args.outDir, 'users.json');
  await writeFile(
    outPath,
    JSON.stringify(
      { generated: new Date().toISOString(), baseUrl: args.baseUrl, windowDays: days, count: users.length, users },
      null,
      2
    )
  );
  console.log(`  ${users.length} user(s) (${service} service account(s), ${users.length - service} people)`);
  console.log(
    `  NOTE: only users who ran a query in the last ${days}d appear — an owner missing from this set ` +
      `keeps their raw id in the tracker rather than going blank.`
  );
  console.log(`Wrote ${outPath}`);
}
