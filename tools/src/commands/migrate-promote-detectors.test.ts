import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyAndRecord, runPromoteDetectors, type ApplyDeps, type Outcome } from './migrate-promote-detectors.ts';
import { SettingsApiError, type SettingsObject } from '../dynatrace/settings.ts';
import type { TrackerRow } from '../lib/tracker-xlsx.ts';

// The apply half of migrate-promote-detectors: everything that touches a LIVE
// alert. Driven here by a fake Settings API that behaves like the real one where
// it matters (an update token that changes on every write and is checked on
// every PUT), so the write path is exercised before it ever meets a tenant.

const CLASSIC = 'timeseries v = avg(cloud.aws.sqs.messages_visible), by:{dt.entity.custom_device}';
const APPROVED = 'timeseries v = avg(cloud.aws.sqs.ApproximateNumberOfMessagesVisible.By.QueueName), by:{dt.smartscape.aws_sqs_queue}';
const NOW = new Date('2026-11-06T12:00:00.000Z');

type Prop = { key: string; value: string };

const CLASSIC_PROPS: Prop[] = [
  { key: 'event.name', value: 'Backlog on {dims:dt.entity.custom_device.name}' },
  { key: 'dt.source_entity', value: '{dims:dt.entity.custom_device}' },
];
const NEW_PROPS: Prop[] = [
  { key: 'event.name', value: 'Backlog on {dims:dt.smartscape.aws_sqs_queue.name}' },
  { key: 'dt.smartscape_source.id', value: '{dt.smartscape.aws_sqs_queue}' },
];

function detector(query: string, props: Prop[], threshold = '100'): Record<string, unknown> {
  return {
    enabled: true,
    title: 'Queue backlog',
    executionSettings: { actor: 'actor-1' },
    analyzer: {
      name: 'dt.statistics.ui.anomaly_detection.StaticThresholdAnomalyDetectionAnalyzer',
      input: [
        { key: 'query', value: query },
        { key: 'threshold', value: threshold },
      ],
    },
    eventTemplate: { properties: props },
  };
}

const BINDING_NOTE = "added `dt.smartscape_source.id` to the split; the series count is unchanged, so the alert's grain is too.";

/** An alert as the planner leaves it. Only a ready one carries a payload by default. */
function planned(id: string, result: 'ready' | 'skipped' | 'recorded' = 'ready', reasons?: string[]): Outcome {
  const live = detector(CLASSIC, CLASSIC_PROPS);
  return {
    item: {
      objectId: id,
      title: `Queue backlog ${id}`,
      batch: 'batch-03',
      result,
      reasons: reasons ?? (result === 'ready' ? [BINDING_NOTE] : result === 'recorded' ? ['already published: the live alert already has it.'] : ['owner changed the alert after review.', 'a note']),
      diff: { fields: [] },
    },
    gate: result === 'ready' ? 'ready' : result,
    liveValue: live,
    payload:
      result === 'ready'
        ? { objectId: id, title: `Queue backlog ${id}`, batch: 'batch-03', liveQuery: CLASSIC, schemaVersion: '1.2.3', value: detector(APPROVED, NEW_PROPS) }
        : undefined,
  };
}

interface Stored {
  value: Record<string, unknown>;
  /** Left out, a read returns no token. */
  updateToken?: string;
  schemaVersion?: string;
}

interface Call {
  op: 'get' | 'put';
  id: string;
  body?: { value: Record<string, unknown>; updateToken?: string; schemaVersion?: string };
  validateOnly?: boolean;
}

/**
 * A Settings API over an in-memory store. Each write gets a new update token and
 * a PUT with any other token is refused with 409, as the real API does.
 */
function fakeSettings(
  store: Map<string, Stored>,
  hooks: {
    /** Fail the nth read (0-based) of an alert. */
    getError?: (id: string, nth: number) => unknown;
    /** Fail the write before anything is stored. */
    putError?: (id: string) => unknown;
    /** Store the write, then fail as a lost response would. */
    putLandsThenFails?: (id: string) => unknown;
    /** What the server keeps of a written value (default: the value as sent). */
    stored?: (value: Record<string, unknown>) => Record<string, unknown>;
  } = {},
) {
  const calls: Call[] = [];
  let tokens = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const enter = async (): Promise<void> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
  };
  return {
    calls,
    maxInFlight: () => maxInFlight,
    async getObject(id: string): Promise<SettingsObject> {
      const nth = calls.filter((c) => c.op === 'get' && c.id === id).length;
      calls.push({ op: 'get', id });
      await enter();
      try {
        const err = hooks.getError?.(id, nth);
        if (err) throw err;
        const s = store.get(id);
        if (!s) throw new SettingsApiError(404, `https://example/settings/objects/${id}`, '{"error":{"message":"not found"}}');
        return { objectId: id, value: structuredClone(s.value), updateToken: s.updateToken, schemaVersion: s.schemaVersion };
      } finally {
        inFlight--;
      }
    },
    async putObject(
      id: string,
      body: { value: Record<string, unknown>; updateToken?: string; schemaVersion?: string },
      opts: { validateOnly?: boolean } = {},
    ): Promise<void> {
      calls.push({ op: 'put', id, body: structuredClone(body), validateOnly: opts.validateOnly });
      await enter();
      try {
        const err = hooks.putError?.(id);
        if (err) throw err;
        const s = store.get(id)!;
        if (body.updateToken !== s.updateToken) {
          throw new SettingsApiError(409, `https://example/settings/objects/${id}`, '{"error":{"message":"the object was modified"}}');
        }
        if (opts.validateOnly) return;
        const kept = hooks.stored ? hooks.stored(structuredClone(body.value)) : structuredClone(body.value);
        store.set(id, { value: kept, updateToken: `tok-${id}-w${++tokens}`, schemaVersion: s.schemaVersion });
        const lost = hooks.putLandsThenFails?.(id);
        if (lost) throw lost;
      } finally {
        inFlight--;
      }
    },
  };
}

async function setup(ids: string[]) {
  const dir = await mkdtemp(join(tmpdir(), 'promote-detectors-'));
  const promoteDir = join(dir, 'migration', 'detector-promote');
  const store = new Map<string, Stored>(ids.map((id) => [id, { value: detector(CLASSIC, CLASSIC_PROPS), updateToken: `tok-${id}-0`, schemaVersion: '1.2.3' }]));
  const lines: string[] = [];
  const sheets: Array<{ path: string; rows: TrackerRow[]; sheet: string }> = [];
  const trackerPath = join(dir, 'tracker.xlsx');
  const deps = (settings: ApplyDeps['settings'], over: Partial<ApplyDeps> = {}): ApplyDeps => ({
    settings,
    promoteDir,
    trackerPath,
    upsert: async (path, rows, sheet) => {
      sheets.push({ path, rows: structuredClone(rows), sheet });
    },
    log: (line) => lines.push(line),
    now: () => NOW,
    ...over,
  });
  const json = async (...parts: string[]): Promise<unknown> => JSON.parse(await readFile(join(promoteDir, ...parts), 'utf8'));
  return { dir, promoteDir, store, lines, sheets, deps, trackerPath, json };
}

const authError = (id: string) => new SettingsApiError(403, `https://example/settings/objects/${id}`, '{"error":{"message":"Forbidden"}}');

describe('apply: the drift re-check', () => {
  it('skips an alert whose live query changed since this run planned it, and never writes it', async () => {
    const t = await setup(['A']);
    t.store.get('A')!.value = detector(`${CLASSIC}\n| filter v > 1`, CLASSIC_PROPS);
    const s = fakeSettings(t.store);
    const o = planned('A');

    await applyAndRecord([o], t.deps(s));

    assert.deepEqual(s.calls.map((c) => c.op), ['get'], 'one re-read, no write');
    assert.equal(o.item.result, 'skipped');
    assert.match(o.item.reasons[0]!, /query changed after this run planned it/);
    assert.equal(existsSync(join(t.promoteDir, 'pre', 'A.json')), false, 'no snapshot for an alert that is not written');
    assert.equal(existsSync(join(t.promoteDir, 'published', 'A.json')), false);
  });

  it('skips an alert whose threshold changed since it was planned: the planned value would undo the change', async () => {
    const t = await setup(['A']);
    t.store.get('A')!.value = detector(CLASSIC, CLASSIC_PROPS, '250');
    const s = fakeSettings(t.store);
    const o = planned('A');

    await applyAndRecord([o], t.deps(s));

    assert.equal(s.calls.filter((c) => c.op === 'put').length, 0);
    assert.equal(o.item.result, 'skipped');
    assert.match(o.item.reasons[0]!, /changed after this run planned it/);
  });

  it('reads key order as no change', async () => {
    const t = await setup(['A']);
    const v = t.store.get('A')!.value;
    t.store.get('A')!.value = Object.fromEntries(Object.entries(v).reverse());
    const s = fakeSettings(t.store);
    const o = planned('A');

    await applyAndRecord([o], t.deps(s));

    assert.equal(o.item.result, 'published');
  });
});

describe('apply: the snapshot', () => {
  it('keeps the first snapshot: an existing pre/<id>.json is not overwritten', async () => {
    const t = await setup(['A']);
    await mkdir(join(t.promoteDir, 'pre'), { recursive: true });
    const first = JSON.stringify({ objectId: 'A', title: 'Queue backlog A', snapshotAt: '2026-10-01T00:00:00.000Z', value: { original: true } });
    await writeFile(join(t.promoteDir, 'pre', 'A.json'), first);
    const o = planned('A');

    await applyAndRecord([o], t.deps(fakeSettings(t.store)));

    assert.equal(o.item.result, 'published');
    assert.equal(await readFile(join(t.promoteDir, 'pre', 'A.json'), 'utf8'), first);
  });

  it('snapshots the value read just before the write, with its title and time', async () => {
    const t = await setup(['A']);
    await applyAndRecord([planned('A')], t.deps(fakeSettings(t.store)));

    assert.deepEqual(await t.json('pre', 'A.json'), {
      objectId: 'A',
      title: 'Queue backlog A',
      snapshotAt: NOW.toISOString(),
      value: detector(CLASSIC, CLASSIC_PROPS),
    });
  });
});

describe('apply: the write', () => {
  it("uses the updateToken of this run's re-read and the whole payload value", async () => {
    const t = await setup(['A']);
    // Saved unchanged since planning: same value, new token.
    t.store.get('A')!.updateToken = 'tok-A-resaved';
    const s = fakeSettings(t.store);
    const o = planned('A');

    await applyAndRecord([o], t.deps(s));

    assert.deepEqual(s.calls.map((c) => c.op), ['get', 'put', 'get'], 're-read, write, re-read');
    const put = s.calls[1]!;
    assert.equal(put.body!.updateToken, 'tok-A-resaved');
    assert.deepEqual(put.body!.value, o.payload!.value);
    assert.equal(put.body!.schemaVersion, '1.2.3');
    assert.notEqual(put.validateOnly, true, 'a real write, not a validation');
    assert.deepEqual(t.store.get('A')!.value, o.payload!.value);
  });

  it('writes one alert at a time', async () => {
    const t = await setup(['A', 'B', 'C']);
    const s = fakeSettings(t.store);

    await applyAndRecord([planned('A'), planned('B'), planned('C')], t.deps(s));

    assert.equal(s.maxInFlight(), 1);
    assert.equal(s.calls.filter((c) => c.op === 'put').length, 3);
  });

  it('acts on ready alerts only: a skipped one that carries a payload is never read or written', async () => {
    const t = await setup(['A', 'S', 'R']);
    const s = fakeSettings(t.store);
    const skipped = planned('S', 'skipped', ['server validation failed: HTTP 400: bad value']);
    skipped.payload = planned('S').payload; // prepare keeps the payload of a validation failure
    const recorded = planned('R', 'recorded');

    await applyAndRecord([skipped, recorded, planned('A')], t.deps(s));

    assert.deepEqual([...new Set(s.calls.map((c) => c.id))], ['A']);
    assert.equal(skipped.item.result, 'skipped');
    assert.equal(recorded.item.result, 'recorded');
  });

  it('skips an alert whose write is refused (changed between re-read and write), with no published record', async () => {
    const t = await setup(['A']);
    const s = fakeSettings(t.store, {
      putError: () => new SettingsApiError(409, 'https://example/settings/objects/A', '{"error":{"message":"the object was modified"}}'),
    });
    const o = planned('A');

    const run = await applyAndRecord([o], t.deps(s));

    assert.equal(o.item.result, 'skipped');
    assert.match(o.item.reasons[0]!, /HTTP 409/);
    assert.equal(existsSync(join(t.promoteDir, 'published', 'A.json')), false);
    assert.equal(run.stop, undefined, 'a refused write is not an auth failure');
  });

  it('never sends a write twice: a write that got no answer is settled by a re-read', async () => {
    const t = await setup(['A', 'B']);
    const s = fakeSettings(t.store, {
      putLandsThenFails: (id) => (id === 'A' ? new TypeError('fetch failed') : undefined),
      putError: (id) => (id === 'B' ? new TypeError('fetch failed') : undefined),
    });
    const a = planned('A');
    const b = planned('B');

    await applyAndRecord([a, b], t.deps(s));

    assert.equal(s.calls.filter((c) => c.op === 'put' && c.id === 'A').length, 1);
    assert.equal(s.calls.filter((c) => c.op === 'put' && c.id === 'B').length, 1);
    assert.equal(a.item.result, 'published', 'the re-read shows it landed');
    assert.ok(a.item.reasons.some((r) => /no answer/.test(r)));
    assert.equal(existsSync(join(t.promoteDir, 'published', 'A.json')), true);
    assert.equal(b.item.result, 'skipped', 'the re-read shows it did not land');
    assert.match(b.item.reasons[0]!, /did not land/);
    assert.equal(existsSync(join(t.promoteDir, 'published', 'B.json')), false);
  });

  it('settles a server error by a re-read: a gateway 504 after the write was stored counts as published', async () => {
    const t = await setup(['A']);
    const s = fakeSettings(t.store, {
      putLandsThenFails: () => new SettingsApiError(504, 'https://example/settings/objects/A', '{"error":{"message":"Gateway Timeout"}}'),
    });
    const o = planned('A');

    const run = await applyAndRecord([o], t.deps(s));

    assert.deepEqual(s.calls.map((c) => c.op), ['get', 'put', 'get'], 'one write, one re-read to settle it, never re-sent');
    assert.equal(o.item.result, 'published', o.item.reasons.join(' | '));
    assert.ok(o.item.reasons.some((r) => /HTTP 504/.test(r) && /landed/.test(r)), o.item.reasons.join(' | '));
    assert.deepEqual(run.published, ['A']);
    assert.deepEqual(await t.json('published', 'A.json'), { objectId: 'A', publishedAt: NOW.toISOString(), value: o.payload!.value });
    assert.deepEqual(t.sheets[0]!.rows.map((r) => [r.asset_id, r.status, r.decision]), [['A', 'promoted', 'Published']]);
  });

  it('settles a server error by a re-read: a 503 with nothing stored is not written', async () => {
    const t = await setup(['A']);
    const s = fakeSettings(t.store, {
      putError: () => new SettingsApiError(503, 'https://example/settings/objects/A', '{"error":{"message":"Service Unavailable"}}'),
    });
    const o = planned('A');

    const run = await applyAndRecord([o], t.deps(s));

    assert.deepEqual(s.calls.map((c) => c.op), ['get', 'put', 'get'], 'one write, one re-read to settle it, never re-sent');
    assert.equal(o.item.result, 'skipped');
    assert.match(o.item.reasons[0]!, /^not written: /);
    assert.match(o.item.reasons[0]!, /HTTP 503/);
    assert.match(o.item.reasons[0]!, /did not land/);
    assert.deepEqual(run.published, []);
    assert.equal(run.stop, undefined);
    assert.equal(existsSync(join(t.promoteDir, 'published', 'A.json')), false);
  });

  it('treats a 400 as a definite refusal: not written, with no re-read', async () => {
    const t = await setup(['A']);
    const s = fakeSettings(t.store, {
      putError: () => new SettingsApiError(400, 'https://example/settings/objects/A', '{"error":{"message":"bad value"}}'),
    });
    const o = planned('A');

    await applyAndRecord([o], t.deps(s));

    assert.deepEqual(s.calls.map((c) => c.op), ['get', 'put']);
    assert.equal(o.item.result, 'skipped');
    assert.match(o.item.reasons[0]!, /not written: the write was refused: HTTP 400/);
  });

  it('never writes without an update token: a re-read that returns none is not written', async () => {
    const t = await setup(['A']);
    delete t.store.get('A')!.updateToken;
    const s = fakeSettings(t.store);
    const o = planned('A');

    const run = await applyAndRecord([o], t.deps(s));

    assert.deepEqual(s.calls.map((c) => c.op), ['get'], 'the re-read, and no write');
    assert.equal(o.item.result, 'skipped');
    assert.match(o.item.reasons[0]!, /^no update token returned by the re-read; not written/);
    assert.equal(run.stop, undefined);
    assert.equal(existsSync(join(t.promoteDir, 'pre', 'A.json')), false, 'no snapshot for an alert that is not written');
    assert.equal(existsSync(join(t.promoteDir, 'published', 'A.json')), false);
    assert.deepEqual(t.store.get('A')!.value, detector(CLASSIC, CLASSIC_PROPS), 'the live alert is untouched');
  });
});

describe('apply: the re-read check', () => {
  it('records and prints a stored value that differs from the payload; the alert still counts as published', async () => {
    const t = await setup(['A']);
    const s = fakeSettings(t.store, {
      stored: (v) => {
        (v.eventTemplate as { properties: Prop[] }).properties = [{ key: 'event.name', value: 'something else' }];
        return v;
      },
    });
    const o = planned('A');

    const run = await applyAndRecord([o], t.deps(s));

    assert.equal(o.item.result, 'published');
    assert.ok(o.item.reasons.some((r) => /re-read after the write does not show/.test(r)), o.item.reasons.join(' | '));
    assert.ok(t.lines.some((l) => /re-read after the write does not show/.test(l)), 'printed');
    assert.deepEqual(run.published, ['A']);
    assert.equal(existsSync(join(t.promoteDir, 'published', 'A.json')), true);
    assert.match(t.sheets[0]!.rows[0]!.reasons ?? '', /re-read after the write does not show/);
  });

  it('notes nothing when the stored value matches', async () => {
    const t = await setup(['A']);
    const o = planned('A');
    await applyAndRecord([o], t.deps(fakeSettings(t.store)));
    assert.deepEqual(o.item.reasons, [BINDING_NOTE]);
  });
});

describe('apply: the published record', () => {
  it('writes published/<id>.json after a successful write', async () => {
    const t = await setup(['A']);
    const o = planned('A');
    await applyAndRecord([o], t.deps(fakeSettings(t.store)));

    assert.deepEqual(await t.json('published', 'A.json'), { objectId: 'A', publishedAt: NOW.toISOString(), value: o.payload!.value });
  });
});

describe('apply: sheet rows', () => {
  it('writes one row per alert to the alerts sheet, in one write', async () => {
    const t = await setup(['A', 'R', 'S']);
    await applyAndRecord([planned('A'), planned('R', 'recorded'), planned('S', 'skipped')], t.deps(fakeSettings(t.store)));

    assert.equal(t.sheets.length, 1);
    assert.equal(t.sheets[0]!.sheet, 'alerts');
    assert.equal(t.sheets[0]!.path, t.trackerPath);
    assert.deepEqual(t.sheets[0]!.rows, [
      {
        asset_id: 'A',
        asset_type: 'anomaly-detector',
        name: 'Queue backlog A',
        status: 'promoted',
        decision: 'Published',
        promoted_at: NOW.toISOString(),
        review_batch: 'batch-03',
        reasons: BINDING_NOTE,
      },
      {
        asset_id: 'R',
        asset_type: 'anomaly-detector',
        name: 'Queue backlog R',
        status: 'promoted',
        decision: 'Published',
        promoted_at: NOW.toISOString(),
        review_batch: 'batch-03',
        reasons: 'already published, recorded',
      },
      { asset_id: 'S', asset_type: 'anomaly-detector', name: 'Queue backlog S', reasons: 'owner changed the alert after review. a note' },
    ]);
  });

  it("dates a recorded alert by its earlier publish when there is a record of it", async () => {
    const t = await setup(['R']);
    await mkdir(join(t.promoteDir, 'published'), { recursive: true });
    await writeFile(join(t.promoteDir, 'published', 'R.json'), JSON.stringify({ objectId: 'R', publishedAt: '2026-11-01T08:00:00.000Z', value: {} }));

    await applyAndRecord([planned('R', 'recorded')], t.deps(fakeSettings(t.store)));

    assert.equal(t.sheets[0]!.rows[0]!.promoted_at, '2026-11-01T08:00:00.000Z');
  });

  it('records an alert skipped at apply time with its reason only', async () => {
    const t = await setup(['A']);
    t.store.get('A')!.value = detector(`${CLASSIC} // edited`, CLASSIC_PROPS);
    await applyAndRecord([planned('A')], t.deps(fakeSettings(t.store)));

    const row = t.sheets[0]!.rows[0]!;
    assert.deepEqual(Object.keys(row).sort(), ['asset_id', 'asset_type', 'name', 'reasons']);
    assert.match(row.reasons!, /query changed after this run planned it/);
  });
});

describe('apply: auth failures', () => {
  it('stops at the first one: no later alert is read or written, and earlier publishes still reach the sheet', async () => {
    const t = await setup(['A', 'B', 'C']);
    const s = fakeSettings(t.store, { getError: (id) => (id === 'B' ? authError(id) : undefined) });
    const [a, b, c] = [planned('A'), planned('B'), planned('C')];

    const run = await applyAndRecord([a, b, c], t.deps(s));

    assert.ok(run.stop instanceof SettingsApiError);
    assert.deepEqual(run.published, ['A']);
    assert.deepEqual(run.notAttempted, ['B', 'C']);
    assert.equal(s.calls.some((x) => x.id === 'C'), false, 'C is never read');
    assert.equal(s.calls.some((x) => x.op === 'put' && x.id === 'B'), false);
    assert.deepEqual(t.sheets[0]!.rows.map((r) => [r.asset_id, r.status]), [['A', 'promoted']]);
    assert.equal(b.item.result, 'ready', 'not written, and not a skip to record on the sheet');
    assert.match(c.item.reasons.at(-1)!, /not written: the run stopped/);
  });

  it('stops on a refused write too', async () => {
    const t = await setup(['A', 'B']);
    const s = fakeSettings(t.store, { putError: (id) => (id === 'A' ? authError(id) : undefined) });

    const run = await applyAndRecord([planned('A'), planned('B')], t.deps(s));

    assert.ok(run.stop);
    assert.deepEqual(run.published, []);
    assert.equal(s.calls.some((x) => x.id === 'B'), false);
    assert.equal(existsSync(join(t.promoteDir, 'published', 'A.json')), false);
  });

  it('counts a write whose re-read is refused as published, then stops', async () => {
    const t = await setup(['A', 'B']);
    const s = fakeSettings(t.store, { getError: (id, nth) => (id === 'A' && nth === 1 ? authError(id) : undefined) });
    const a = planned('A');

    const run = await applyAndRecord([a, planned('B')], t.deps(s));

    assert.ok(run.stop);
    assert.deepEqual(run.published, ['A']);
    assert.ok(a.item.reasons.some((r) => /re-read after the write failed/.test(r)));
    assert.equal(existsSync(join(t.promoteDir, 'published', 'A.json')), true);
    assert.deepEqual(t.sheets[0]!.rows.map((r) => [r.asset_id, r.status]), [['A', 'promoted']]);
    assert.equal(s.calls.some((x) => x.id === 'B'), false);
  });
});

describe('apply: the sheet write fails', () => {
  it('keeps the publish and prints the ids to record', async () => {
    const t = await setup(['A', 'B']);
    const deps = t.deps(fakeSettings(t.store), {
      upsert: async () => {
        throw new Error('EBUSY: resource busy or locked');
      },
    });

    const run = await applyAndRecord([planned('A'), planned('B')], deps);

    assert.equal(run.recorded, false);
    assert.deepEqual(run.published, ['A', 'B']);
    const out = t.lines.join('\n');
    assert.match(out, /Published, but could not write the tracker/);
    assert.match(out, /A,B/);
    assert.match(out, /--apply/);
    assert.equal(existsSync(join(t.promoteDir, 'published', 'A.json')), true);
  });
});

describe('runPromoteDetectors: flags that would widen an apply', () => {
  const base = { outDir: join(tmpdir(), 'promote-detectors-none'), baseUrl: 'https://abc12345.apps.dynatrace.com', token: 't', batches: ['batch-03'] };

  it('refuses --force without --ids', async () => {
    await assert.rejects(runPromoteDetectors({ ...base, force: true }), /--force needs --ids/);
    await assert.rejects(runPromoteDetectors({ ...base, force: true, apply: true, allowEnv: 'abc12345' }), /--force needs --ids/);
  });

  it('refuses an empty --ids', async () => {
    await assert.rejects(runPromoteDetectors({ ...base, ids: [] }), /--ids/);
  });

  it('refuses --apply without --allow-env before reading anything', async () => {
    await assert.rejects(runPromoteDetectors({ ...base, apply: true }), /--allow-env/);
  });
});
