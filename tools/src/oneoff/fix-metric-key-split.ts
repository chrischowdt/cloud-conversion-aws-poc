/**
 * ONE-OFF — restore the entity split that an automated port dropped.
 * See ./metric-key-split.ts for the why. NOT part of the `cct` automation.
 *
 *   node --env-file-if-exists=.env.local --experimental-strip-types \
 *     --no-warnings=ExperimentalWarning src/oneoff/fix-metric-key-split.ts \
 *     --allow-env nic55601 --creator rodrigo.maldonado@dynatrace.com [--apply]
 *
 * PREPARE by default: reads the tenant, verifies each patched query against live
 * data, runs a server-side validateOnly write, and writes a plan. Nothing is
 * persisted until --apply. --rollback restores the pre-patch snapshots.
 *
 * Selects a detector only when ALL of these hold (evidence, not a name match):
 *   1. created by --creator
 *   2. references cloud.aws.
 *   3. its title joins to a classic metric event whose query type is METRIC_KEY
 *      (the type Dynatrace splits automatically; METRIC_SELECTOR carries an
 *      explicit splitBy and was ported correctly)
 *   4. its timeseries has no top-level by-clause
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SettingsClient, SettingsApiError, type SettingsObject } from '../dynatrace/settings.ts';
import { DqlClient, DqlError } from '../dynatrace/dql.ts';
import { tenantOutDir, envIdFromBaseUrl } from '../lib/paths.ts';
import { addEntitySplit, firstSeriesName, hasTopLevelBy } from './metric-key-split.ts';

const DETECTOR_SCHEMA = 'builtin:davis.anomaly-detectors';
const CLASSIC_SCHEMA = 'builtin:anomaly-detection.metric-events';
const DEFAULT_DIM = 'dt.entity.custom_device';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Flags {
  allowEnv?: string;
  creator?: string;
  apply: boolean;
  rollback: boolean;
  force: boolean;
  includeUnverified: boolean;
  ids?: Set<string>;
  limit?: number;
  concurrency: number;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { apply: false, rollback: false, force: false, includeUnverified: false, concurrency: 4 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = () => argv[++i];
    if (a === '--allow-env') f.allowEnv = next();
    else if (a === '--creator') f.creator = next();
    else if (a === '--apply') f.apply = true;
    else if (a === '--rollback') f.rollback = true;
    else if (a === '--force') f.force = true;
    else if (a === '--include-unverified') f.includeUnverified = true;
    else if (a === '--ids') f.ids = new Set((next() ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--limit') f.limit = Number(next());
    else if (a === '--concurrency') f.concurrency = Math.max(1, Number(next()) || 4);
    else throw new Error(`unknown flag ${a}`);
  }
  return f;
}

type Status = 'ready' | 'no-data' | 'dim-missing' | 'query-error';

interface PlanItem {
  objectId: string;
  title: string;
  dim: string;
  status: Status;
  series?: number;
  breaching?: number | null;
  note?: string;
  original: string;
  patched: string;
  validate?: 'ok' | string;
}

const norm = (s: unknown) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

type Input = { key: string; value: unknown };
const queryInputOf = (o: SettingsObject): Input | undefined => {
  const inputs = ((o.value as any)?.analyzer?.input ?? []) as Input[];
  return inputs.find((i) => i?.key === 'query' || i?.key === 'query.expression');
};
const inputValue = (o: SettingsObject, key: string): string | undefined => {
  const inputs = ((o.value as any)?.analyzer?.input ?? []) as Input[];
  const v = inputs.find((i) => i?.key === key)?.value;
  return v === undefined ? undefined : String(v);
};

async function pool<T>(items: T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await fn(items[i]!, i);
      }
    })
  );
}

async function resolveCreator(spec: string, outDir: string): Promise<string> {
  if (UUID.test(spec)) return spec.toLowerCase();
  const usersPath = join(outDir, 'users.json');
  if (!existsSync(usersPath)) throw new Error(`--creator ${spec}: no ${usersPath} to resolve an email; pass the UUID instead`);
  // discover-users writes { generated, baseUrl, count, users: [{ id, email }] }.
  const j = JSON.parse(await readFile(usersPath, 'utf8')) as any;
  const list: Array<{ id?: string; email?: string }> = Array.isArray(j) ? j : Array.isArray(j?.users) ? j.users : [];
  const hit = list.find((u) => norm(u.email) === norm(spec));
  if (!hit?.id) throw new Error(`--creator ${spec}: not found in ${usersPath}`);
  return hit.id.toLowerCase();
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const baseUrl = process.env['DT_BASE_URL'] ?? '';
  const token = process.env['DT_TOKEN'] ?? '';
  if (!baseUrl || !token) throw new Error('DT_BASE_URL and DT_TOKEN must be set (use --env-file).');

  // The guard that keeps a prod token from being used by accident: the caller
  // must NAME the environment they intend, and it must match the one connected.
  const envId = envIdFromBaseUrl(baseUrl);
  if (!flags.allowEnv) throw new Error('--allow-env <env-id> is required (e.g. --allow-env nic55601).');
  if (flags.allowEnv !== envId) {
    throw new Error(`Connected to "${envId}" but --allow-env says "${flags.allowEnv}". Refusing.`);
  }

  const outDir = join(tenantOutDir({ baseUrl }), 'migration', 'detector-fix');
  const preDir = join(outDir, 'pre');
  await mkdir(preDir, { recursive: true });
  const settings = new SettingsClient({ baseUrl, token });

  // ── rollback ────────────────────────────────────────────────────────────
  if (flags.rollback) {
    const { readdir } = await import('node:fs/promises');
    const files = (await readdir(preDir)).filter((f) => f.endsWith('.json'));
    console.log(`Rolling back ${files.length} snapshot(s) on ${envId}…`);
    let restored = 0, unchanged = 0, failed = 0;
    for (const f of files) {
      const snap = JSON.parse(await readFile(join(preDir, f), 'utf8')) as { objectId: string; title: string; value: any };
      const live = await settings.getObject(snap.objectId);
      const liveQ = queryInputOf(live)?.value;
      const snapQ = (snap.value?.analyzer?.input ?? []).find((i: Input) => i.key === 'query' || i.key === 'query.expression')?.value;
      if (liveQ === snapQ) { unchanged++; continue; }
      try {
        await settings.putObject(snap.objectId, { value: snap.value, updateToken: (live as any).updateToken, schemaVersion: (live as any).schemaVersion });
        restored++;
      } catch (e) {
        failed++;
        console.log(`  ! ${snap.title}: ${e instanceof SettingsApiError ? `HTTP ${e.status} ${e.body.slice(0, 120)}` : (e as Error).message}`);
      }
    }
    console.log(`Restored ${restored}; already original ${unchanged}; failed ${failed}.`);
    return;
  }

  if (!flags.creator) throw new Error('--creator <email|uuid> is required.');
  const creatorId = await resolveCreator(flags.creator, tenantOutDir({ baseUrl }));

  // ── select ──────────────────────────────────────────────────────────────
  console.log(`Tenant ${envId} — creator ${flags.creator} (${creatorId}) — ${flags.apply ? 'APPLY' : 'PREPARE (no writes)'}`);
  const detectors = await settings.listAllObjects({
    schemaId: DETECTOR_SCHEMA,
    fields: 'objectId,summary,schemaId,schemaVersion,modified,createdBy,updateToken,value',
  });
  const classic = await settings.listAllObjects({ schemaId: CLASSIC_SCHEMA, fields: 'objectId,summary,value' });

  const classicByTitle = new Map<string, SettingsObject[]>();
  for (const c of classic) {
    for (const t of [(c.value as any)?.summary, (c.value as any)?.eventTemplate?.title, c.summary]) {
      const k = norm(t);
      if (!k) continue;
      const arr = classicByTitle.get(k) ?? [];
      if (!arr.includes(c)) arr.push(c);
      classicByTitle.set(k, arr);
    }
  }

  const skip = { notAws: 0, noClassicMatch: 0, notMetricKey: 0, alreadySplit: 0, commentInCommand: 0, noTimeseries: 0 };
  const candidates: Array<{ det: SettingsObject; q: string; classicDims: string[] }> = [];
  for (const d of detectors) {
    if (String((d as any).createdBy ?? '').toLowerCase() !== creatorId) continue;
    if (flags.ids && !flags.ids.has(d.objectId)) continue;
    const qi = queryInputOf(d);
    const q = String(qi?.value ?? '');
    if (!/cloud\.aws\./.test(q)) { skip.notAws++; continue; }
    const matches = classicByTitle.get(norm((d.value as any)?.title)) ?? [];
    if (!matches.length) { skip.noClassicMatch++; continue; }
    if (!matches.every((m) => (m.value as any)?.queryDefinition?.type === 'METRIC_KEY')) { skip.notMetricKey++; continue; }
    if (hasTopLevelBy(q)) { skip.alreadySplit++; continue; }
    const probe = addEntitySplit(q, DEFAULT_DIM);
    if (!probe.ok) {
      if (probe.reason === 'comment-in-command') skip.commentInCommand++;
      else if (probe.reason === 'no-timeseries') skip.noTimeseries++;
      continue;
    }
    const classicDims = [...new Set(matches.map((m) => String((m.value as any)?.queryDefinition?.entityFilter?.dimensionKey ?? '')).filter(Boolean))];
    candidates.push({ det: d, q, classicDims });
  }
  const limited = flags.limit ? candidates.slice(0, flags.limit) : candidates;
  console.log(`Selected ${candidates.length} detector(s)${flags.limit ? ` (processing ${limited.length})` : ''}.`);
  console.log(`  skipped: not-AWS ${skip.notAws}, no classic match ${skip.noClassicMatch}, not METRIC_KEY ${skip.notMetricKey}, ` +
    `already split ${skip.alreadySplit}, // in command ${skip.commentInCommand}, no timeseries ${skip.noTimeseries}`);

  // ── verify each patch against live data ─────────────────────────────────
  const dql = new DqlClient({ baseUrl, token });
  const now = Date.now();
  const window = { defaultTimeframeStart: new Date(now - 24 * 3600e3).toISOString(), defaultTimeframeEnd: new Date(now).toISOString() };

  async function probeDim(item: { det: SettingsObject; q: string }, dim: string) {
    const r = addEntitySplit(item.q, dim);
    if (!r.ok) return { status: 'query-error' as Status, note: r.reason, patched: item.q };
    const patched = r.query;
    const name = firstSeriesName(patched);
    const thr = Number(inputValue(item.det, 'threshold'));
    const cond = inputValue(item.det, 'alertCondition');
    const isStatic = /StaticThreshold/.test(String((item.det.value as any)?.analyzer?.name ?? ''));
    const dimRef = `\`${dim}\``;
    const withPeak =
      name && isStatic && Number.isFinite(thr) && (cond === 'ABOVE' || cond === 'BELOW')
        ? `${patched}\n| fieldsAdd __peak = ${cond === 'ABOVE' ? 'arrayMax' : 'arrayMin'}(${name})\n` +
          `| summarize series = count(), withEntity = countIf(isNotNull(${dimRef})), breaching = countIf(__peak ${cond === 'ABOVE' ? '>' : '<'} ${thr})`
        : null;
    const plain = `${patched}\n| summarize series = count(), withEntity = countIf(isNotNull(${dimRef}))`;
    for (const [query, hasBreach] of [[withPeak, true], [plain, false]] as const) {
      if (!query) continue;
      try {
        const res = await dql.query({ query, ...window, maxResultRecords: 5 });
        const rec = (res.records[0] ?? {}) as Record<string, unknown>;
        const series = Number(rec['series'] ?? 0);
        const withEntity = Number(rec['withEntity'] ?? 0);
        const breaching = hasBreach ? Number(rec['breaching'] ?? 0) : null;
        const status: Status = series === 0 ? 'no-data' : withEntity === 0 ? 'dim-missing' : 'ready';
        return { status, series, breaching, patched, note: undefined as string | undefined };
      } catch (e) {
        if (hasBreach) continue; // retry without the breach arithmetic
        const msg = e instanceof DqlError ? `HTTP ${e.status}: ${e.body.slice(0, 160)}` : (e as Error).message;
        return { status: 'query-error' as Status, note: msg, patched };
      }
    }
    return { status: 'query-error' as Status, note: 'no probe ran', patched };
  }

  const plan: PlanItem[] = new Array(limited.length);
  await pool(limited, flags.concurrency, async (item, i) => {
    const title = String((item.det.value as any)?.title ?? item.det.summary ?? item.det.objectId);
    // The classic config's dimensionKey first when it names one, else the
    // entity dimension every bare cloud.aws.* series carries.
    const dims = [...new Set([...item.classicDims, DEFAULT_DIM])];
    let best: Awaited<ReturnType<typeof probeDim>> | undefined;
    let usedDim = dims[0]!;
    for (const dim of dims) {
      const r = await probeDim(item, dim);
      best = r; usedDim = dim;
      if (r.status === 'ready') break;
    }
    plan[i] = {
      objectId: item.det.objectId, title, dim: usedDim, status: best!.status,
      series: (best as any).series, breaching: (best as any).breaching, note: best!.note,
      original: item.q, patched: best!.patched,
    };
    if ((i + 1) % 20 === 0) console.log(`  verified ${i + 1}/${limited.length}`);
  });

  // ── server-side validation of the actual write (persists nothing) ───────
  const ready = plan.filter((p) => p.status === 'ready' || (flags.includeUnverified && p.status !== 'query-error'));
  console.log(`\nValidating ${ready.length} write(s) server-side (validateOnly — nothing persisted)…`);
  let authStop = false;
  await pool(ready, flags.concurrency, async (p) => {
    if (authStop) return;
    try {
      const live = await settings.getObject(p.objectId);
      const value = structuredClone(live.value) as any;
      const qi = (value.analyzer.input as Input[]).find((i) => i.key === 'query' || i.key === 'query.expression')!;
      qi.value = p.patched;
      await settings.putObject(p.objectId, { value, updateToken: (live as any).updateToken, schemaVersion: (live as any).schemaVersion }, { validateOnly: true });
      p.validate = 'ok';
    } catch (e) {
      const msg = e instanceof SettingsApiError ? `HTTP ${e.status} ${e.body.slice(0, 160)}` : (e as Error).message;
      p.validate = msg;
      if (e instanceof SettingsApiError && (e.status === 401 || e.status === 403)) authStop = true;
    }
  });

  await writeFile(join(outDir, 'plan.json'), JSON.stringify(plan, null, 2));
  const tally = new Map<string, number>();
  for (const p of plan) tally.set(p.status, (tally.get(p.status) ?? 0) + 1);
  const validOk = plan.filter((p) => p.validate === 'ok').length;
  const breachers = plan.filter((p) => (p.breaching ?? 0) > 0).sort((a, b) => (b.breaching ?? 0) - (a.breaching ?? 0));

  console.log(`\nPlan (${plan.length}): ${[...tally].map(([k, n]) => `${k}=${n}`).join(', ')}`);
  console.log(`validateOnly write: ${validOk} ok, ${ready.length - validOk} failed`);
  const bad = ready.filter((p) => p.validate !== 'ok');
  for (const p of bad.slice(0, 5)) console.log(`   ! ${p.title.slice(0, 50)}: ${p.validate}`);
  console.log(`\nWhat would START firing (a series breaching its threshold in the last 24h — an upper bound,`);
  console.log(`not the exact sliding-window rule): ${breachers.length} detector(s), ${breachers.reduce((a, b) => a + (b.breaching ?? 0), 0)} series.`);
  for (const p of breachers.slice(0, 12)) console.log(`   ${String(p.breaching).padStart(4)} of ${String(p.series).padEnd(4)} ${p.title.slice(0, 64)}`);
  const unverified = plan.filter((p) => p.status !== 'ready');
  if (unverified.length) {
    console.log(`\nNOT patched (could not verify against live data): ${unverified.length}`);
    for (const p of unverified.slice(0, 10)) console.log(`   [${p.status}] ${p.title.slice(0, 56)}${p.note ? ` — ${p.note.slice(0, 60)}` : ''}`);
  }
  console.log(`\nPlan written to ${join(outDir, 'plan.json')}`);

  if (!flags.apply) {
    console.log('No writes made. Re-run with --apply to patch the live detectors.');
    return;
  }
  if (authStop || bad.length) {
    throw new Error(`Refusing to apply: ${bad.length} write(s) failed server-side validation. Fix that first.`);
  }

  // ── apply ───────────────────────────────────────────────────────────────
  console.log(`\nApplying to ${ready.length} detector(s) on ${envId}…`);
  const log: Array<{ objectId: string; title: string; result: string }> = [];
  let ok = 0, drifted = 0, failed = 0;
  for (const p of ready) {
    try {
      const live = await settings.getObject(p.objectId);
      const qi = queryInputOf(live)!;
      const liveQ = String(qi.value ?? '');
      // The guard that matters: change only what was planned. If the query is not
      // byte-identical to the one verified, someone edited it since — leave it.
      if (liveQ !== p.original && !flags.force) {
        drifted++; log.push({ objectId: p.objectId, title: p.title, result: 'drifted — skipped' });
        console.log(`  ~ ${p.title.slice(0, 56)} — query changed since planned; skipped`);
        continue;
      }
      if (hasTopLevelBy(liveQ)) { log.push({ objectId: p.objectId, title: p.title, result: 'already split' }); continue; }
      const snapPath = join(preDir, `${p.objectId}.json`);
      if (!existsSync(snapPath)) {
        // First snapshot wins: a re-run after a partial failure must keep the ORIGINAL.
        await writeFile(snapPath, JSON.stringify({ objectId: p.objectId, title: p.title, snapshotAt: new Date().toISOString(), value: live.value }, null, 2));
      }
      const re = addEntitySplit(liveQ, p.dim);
      if (!re.ok) { failed++; log.push({ objectId: p.objectId, title: p.title, result: `cannot patch: ${re.reason}` }); continue; }
      const value = structuredClone(live.value) as any;
      (value.analyzer.input as Input[]).find((i) => i.key === 'query' || i.key === 'query.expression')!.value = re.query;
      await settings.putObject(p.objectId, { value, updateToken: (live as any).updateToken, schemaVersion: (live as any).schemaVersion });
      ok++; log.push({ objectId: p.objectId, title: p.title, result: 'patched' });
    } catch (e) {
      failed++;
      const msg = e instanceof SettingsApiError ? `HTTP ${e.status} ${e.body.slice(0, 120)}` : (e as Error).message;
      log.push({ objectId: p.objectId, title: p.title, result: `failed: ${msg}` });
      console.log(`  ! ${p.title.slice(0, 56)}: ${msg}`);
      if (e instanceof SettingsApiError && (e.status === 401 || e.status === 403)) { console.log('  Auth failure — stopping.'); break; }
    }
  }
  await writeFile(join(outDir, 'applied.json'), JSON.stringify(log, null, 2));
  console.log(`\nPatched ${ok}; drifted ${drifted}; failed ${failed}. Log: ${join(outDir, 'applied.json')}`);
  console.log(`Snapshots in ${preDir} — undo with:  --allow-env ${envId} --rollback`);
}

main().catch((e) => {
  console.error(`\n${(e as Error).message}`);
  process.exit(1);
});
