import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { runRollbackDetectors } from './migrate-rollback-detectors.ts';
import { SettingsApiError } from '../dynatrace/settings.ts';
import { ALERTS_SHEET, readRows } from '../lib/tracker-xlsx.ts';
import { APPROVED, CLASSIC, CLASSIC_PROPS, ENV, NEW_PROPS, detector, preValue, publishedAlerts, publishedValue } from './__testing__/published-alerts.ts';
import type { Call } from './__testing__/fake-settings.ts';

// migrate-rollback-detectors writes LIVE alerts. Driven here by a fake Settings
// API whose update token changes on every write and is checked on every PUT, so
// the write path is exercised before it ever meets a tenant.

const authError = (id: string) => new SettingsApiError(403, `https://example/settings/objects/${id}`, '{"error":{"message":"Forbidden"}}');
const apply = { apply: true, allowEnv: ENV };
const puts = (t: { settings: { calls: Call[] } }) => t.settings.calls.filter((c) => c.op === 'put');

describe('migrate-rollback-detectors: flags', () => {
  it('requires --ids or --batches: a rollback never takes every published alert', async () => {
    const t = await publishedAlerts([{ id: 'A' }]);
    await assert.rejects(runRollbackDetectors({ ...t.args, ...apply }, t.deps()), /--ids <a,b> or --batches <list> is required/);
    await assert.rejects(runRollbackDetectors({ ...t.args, ids: [] }, t.deps()), /--ids/);
    await assert.rejects(runRollbackDetectors({ ...t.args, batches: [] }, t.deps()), /--batches/);
    assert.equal(t.settings.calls.length, 0);
  });

  it('refuses --force without --ids', async () => {
    const t = await publishedAlerts([{ id: 'A' }]);
    await assert.rejects(runRollbackDetectors({ ...t.args, ...apply, batches: ['batch-03'], force: true }, t.deps()), /--force needs --ids/);
    assert.equal(t.settings.calls.length, 0);
  });

  it('refuses --apply without --allow-env, or naming another environment, before reading anything', async () => {
    const t = await publishedAlerts([{ id: 'A' }]);
    await assert.rejects(runRollbackDetectors({ ...t.args, ids: ['A'], apply: true }, t.deps()), /--allow-env/);
    await assert.rejects(runRollbackDetectors({ ...t.args, ids: ['A'], apply: true, allowEnv: 'other99' }, t.deps()), /Refusing/);
    assert.equal(t.settings.calls.length, 0);
    assert.equal(t.sheets.length, 0);
  });
});

describe('migrate-rollback-detectors: restore', () => {
  it('writes the live value with only the query and event fields of the snapshot, locked to this run’s read', async () => {
    // The owner raised the threshold and disabled the alert after the publish.
    const t = await publishedAlerts([{ id: 'A', live: { value: detector(APPROVED, NEW_PROPS, { threshold: '250', enabled: false }), updateToken: 'tok-A-7', schemaVersion: '1.2.3' } }]);

    const run = await runRollbackDetectors({ ...t.args, ...apply, ids: ['A'] }, t.deps());

    assert.deepEqual(t.settings.calls.map((c) => c.op), ['get', 'put', 'get'], 'read, write, re-read');
    const put = t.settings.calls[1]!;
    const expected = detector(CLASSIC, CLASSIC_PROPS, { threshold: '250', enabled: false });
    assert.deepEqual(put.body!.value, expected, 'snapshot query + event fields; threshold and enabled as live');
    assert.equal(put.body!.updateToken, 'tok-A-7');
    assert.equal(put.body!.schemaVersion, '1.2.3');
    assert.notEqual(put.validateOnly, true);
    assert.deepEqual(t.store.get('A')!.value, expected);
    assert.equal(run.items[0]!.result, 'rolled-back');

    assert.equal(t.sheets.length, 1);
    assert.equal(t.sheets[0]!.sheet, ALERTS_SHEET);
    const [row] = t.sheets[0]!.rows;
    assert.deepEqual(
      { ...row, reasons: undefined },
      { asset_id: 'A', asset_type: 'anomaly-detector', name: 'Queue backlog', status: 'rolled-back', decision: 'Needs Review', reasons: undefined },
    );
    assert.match(row!.reasons!, /^rolled back /);
    assert.match(row!.reasons!, /everything else is as it was live/);
  });

  it('keeps the value it read just before the write, and the value it wrote, in the run folder', async () => {
    const t = await publishedAlerts([{ id: 'A' }]);

    const run = await runRollbackDetectors({ ...t.args, ...apply, ids: ['A'] }, t.deps());

    const before = JSON.parse(await readFile(join(run.runDir, 'before', 'A.json'), 'utf8'));
    assert.deepEqual(before.value, publishedValue());
    const payload = JSON.parse(await readFile(join(run.runDir, 'payloads', 'A.json'), 'utf8'));
    assert.deepEqual(payload.value, preValue());
    const plan = JSON.parse(await readFile(join(run.runDir, 'plan.json'), 'utf8'));
    assert.deepEqual(plan.map((i: { objectId: string; result: string }) => [i.objectId, i.result]), [['A', 'rolled-back']]);
  });

  it('selects by --batches and takes promoted or verified rows only', async () => {
    const t = await publishedAlerts([{ id: 'A' }, { id: 'V', status: 'verified' }, { id: 'R', status: 'rolled-back' }, { id: 'S', status: 'staged', decision: 'Ready To Publish' }]);

    await runRollbackDetectors({ ...t.args, ...apply, batches: ['batch-03'] }, t.deps());

    assert.deepEqual(puts(t).map((c) => c.id), ['A', 'V']);
    assert.deepEqual([...new Set(t.settings.calls.map((c) => c.id))], ['A', 'V']);
  });

  it('writes one alert at a time', async () => {
    const t = await publishedAlerts([{ id: 'A' }, { id: 'B' }, { id: 'C' }]);

    await runRollbackDetectors({ ...t.args, ...apply, ids: ['A', 'B', 'C'] }, t.deps());

    assert.equal(t.settings.maxInFlight(), 1);
    assert.equal(puts(t).length, 3);
  });

  it('records an alert that already has the snapshot’s parts as rolled back, without writing it again', async () => {
    const t = await publishedAlerts([{ id: 'A', live: { value: preValue(), updateToken: 'tok-A-0' } }]);

    const run = await runRollbackDetectors({ ...t.args, ...apply, ids: ['A'] }, t.deps());

    assert.equal(puts(t).length, 0);
    assert.equal(run.items[0]!.result, 'recorded');
    const row = t.sheets[0]!.rows[0]!;
    assert.equal(row.status, 'rolled-back');
    assert.equal(row.decision, 'Needs Review');
    assert.match(row.reasons!, /already rolled back/);
  });

  it('writes the real workbook: rolled-back and Needs Review', async () => {
    const t = await publishedAlerts([{ id: 'A' }, { id: 'B', live: { value: detector(`${APPROVED} // edited`, NEW_PROPS), updateToken: 'x' } }]);

    await runRollbackDetectors({ ...t.args, ...apply, ids: ['A', 'B'] }, t.deps({ upsert: undefined }));

    const rows = await readRows(t.trackerPath, ALERTS_SHEET);
    assert.equal(rows.get('A')!.status, 'rolled-back');
    assert.equal(rows.get('A')!.decision, 'Needs Review');
    assert.equal(rows.get('B')!.status, 'promoted', 'a refused rollback keeps its status');
    assert.equal(rows.get('B')!.decision, 'Published');
    assert.match(rows.get('B')!.reasons!, /edited after publishing/);
  });
});

describe('migrate-rollback-detectors: refusals', () => {
  it('refuses an alert edited after publishing, naming what changed; restores it with --force --ids', async () => {
    const edited = detector(`${APPROVED}\n| filter v > 5`, NEW_PROPS, { threshold: '300' });
    const t = await publishedAlerts([{ id: 'A', live: { value: edited, updateToken: 'tok-A-0', schemaVersion: '1.2.3' } }]);

    const refused = await runRollbackDetectors({ ...t.args, ...apply, ids: ['A'] }, t.deps());

    assert.equal(puts(t).length, 0);
    assert.equal(refused.items[0]!.result, 'refused');
    const row = t.sheets[0]!.rows[0]!;
    assert.deepEqual(Object.keys(row).sort(), ['asset_id', 'asset_type', 'name', 'reasons'], 'no status or decision');
    assert.match(row.reasons!, /edited after publishing: its query no longer matches what was published/);
    assert.match(row.reasons!, /--force --ids A/);

    const forced = await runRollbackDetectors({ ...t.args, ...apply, ids: ['A'], force: true }, t.deps());

    assert.equal(forced.items[0]!.result, 'rolled-back');
    assert.deepEqual(puts(t)[0]!.body!.value, detector(CLASSIC, CLASSIC_PROPS, { threshold: '300' }));
    const forcedRow = t.sheets[1]!.rows[0]!;
    assert.equal(forcedRow.status, 'rolled-back');
    assert.match(forcedRow.reasons!, /--force/);
  });

  it('names the event fields when they were edited', async () => {
    const t = await publishedAlerts([{ id: 'A', live: { value: detector(APPROVED, [{ key: 'event.name', value: 'mine' }]), updateToken: 'x' } }]);

    await runRollbackDetectors({ ...t.args, ...apply, ids: ['A'] }, t.deps());

    assert.match(t.sheets[0]!.rows[0]!.reasons!, /its event fields no longer match/);
  });

  it('refuses an alert with no snapshot (recorded without a tool publish), even with --force, without reading it', async () => {
    const t = await publishedAlerts([{ id: 'HAND', pre: null, published: null }]);

    for (const force of [false, true]) {
      const run = await runRollbackDetectors({ ...t.args, ...apply, ids: ['HAND'], force }, t.deps());
      assert.equal(run.items[0]!.result, 'refused');
      assert.match(run.items[0]!.reasons[0]!, /^no snapshot; cannot roll back/);
    }
    assert.equal(t.settings.calls.length, 0);
    assert.match(t.sheets[0]!.rows[0]!.reasons!, /no snapshot; cannot roll back/);
    assert.equal(t.sheets[0]!.rows[0]!.status, undefined);
  });

  it('refuses an alert whose published record is missing, since an edit cannot be ruled out, unless --force', async () => {
    const t = await publishedAlerts([{ id: 'A', published: null }]);

    const refused = await runRollbackDetectors({ ...t.args, ...apply, ids: ['A'] }, t.deps());
    assert.equal(refused.items[0]!.result, 'refused');
    assert.match(refused.items[0]!.reasons[0]!, /no published record/);
    assert.equal(puts(t).length, 0);

    const forced = await runRollbackDetectors({ ...t.args, ...apply, ids: ['A'], force: true }, t.deps());
    assert.equal(forced.items[0]!.result, 'rolled-back');
    assert.deepEqual(t.store.get('A')!.value, preValue());
  });

  it('skips an alert that no longer exists', async () => {
    const t = await publishedAlerts([{ id: 'GONE', live: null }]);

    const run = await runRollbackDetectors({ ...t.args, ...apply, ids: ['GONE'] }, t.deps());

    assert.equal(run.items[0]!.result, 'skipped');
    assert.match(run.items[0]!.reasons[0]!, /no longer exists \(HTTP 404\)/);
  });
});

describe('migrate-rollback-detectors: prepare', () => {
  it('reads but never writes: no PUT, no sheet write, the value it would write on disk', async () => {
    const t = await publishedAlerts([{ id: 'A' }, { id: 'E', live: { value: detector(`${APPROVED} // edited`, NEW_PROPS), updateToken: 'x' } }]);

    const run = await runRollbackDetectors({ ...t.args, ids: ['A', 'E'] }, t.deps());

    assert.deepEqual(t.settings.calls.map((c) => c.op), ['get', 'get']);
    assert.equal(t.sheets.length, 0);
    assert.deepEqual(run.items.map((i) => [i.objectId, i.result]), [['A', 'would-restore'], ['E', 'refused']]);
    assert.match(run.runDir, /detector-rollback[\\/]prepare[\\/]/);
    const payload = JSON.parse(await readFile(join(run.runDir, 'payloads', 'A.json'), 'utf8'));
    assert.deepEqual(payload.value, preValue());
    assert.equal(existsSync(join(run.runDir, 'before')), false);
    assert.equal(t.store.get('A')!.updateToken, 'tok-A-0', 'the live alert is untouched');
  });
});

describe('migrate-rollback-detectors: the write', () => {
  it('never writes without an update token', async () => {
    const t = await publishedAlerts([{ id: 'A', live: { value: publishedValue() } }]);

    const run = await runRollbackDetectors({ ...t.args, ...apply, ids: ['A'] }, t.deps());

    assert.deepEqual(t.settings.calls.map((c) => c.op), ['get']);
    assert.equal(run.items[0]!.result, 'skipped');
    assert.match(run.items[0]!.reasons[0]!, /no update token returned by the read; not written/);
    assert.equal(t.sheets[0]!.rows[0]!.status, undefined);
  });

  it('treats a 409 as a refusal: not written, not re-sent', async () => {
    const t = await publishedAlerts([{ id: 'A' }], {
      hooks: { putError: () => new SettingsApiError(409, 'https://example/settings/objects/A', '{"error":{"message":"the object was modified"}}') },
    });

    const run = await runRollbackDetectors({ ...t.args, ...apply, ids: ['A'] }, t.deps());

    assert.deepEqual(t.settings.calls.map((c) => c.op), ['get', 'put']);
    assert.equal(run.items[0]!.result, 'skipped');
    assert.match(run.items[0]!.reasons[0]!, /HTTP 409/);
  });

  it('settles a server error by one re-read and never re-sends: a 504 after the write was stored counts as rolled back', async () => {
    const t = await publishedAlerts([{ id: 'A' }], {
      hooks: { putLandsThenFails: () => new SettingsApiError(504, 'https://example/settings/objects/A', '{"error":{"message":"Gateway Timeout"}}') },
    });

    const run = await runRollbackDetectors({ ...t.args, ...apply, ids: ['A'] }, t.deps());

    assert.deepEqual(t.settings.calls.map((c) => c.op), ['get', 'put', 'get']);
    assert.equal(run.items[0]!.result, 'rolled-back');
    assert.ok(run.items[0]!.reasons.some((r) => /HTTP 504/.test(r) && /landed/.test(r)), run.items[0]!.reasons.join(' | '));
  });

  it('settles a server error by one re-read: a 503 with nothing stored is not written', async () => {
    const t = await publishedAlerts([{ id: 'A' }], {
      hooks: { putError: () => new SettingsApiError(503, 'https://example/settings/objects/A', '{"error":{"message":"Service Unavailable"}}') },
    });

    const run = await runRollbackDetectors({ ...t.args, ...apply, ids: ['A'] }, t.deps());

    assert.deepEqual(t.settings.calls.map((c) => c.op), ['get', 'put', 'get']);
    assert.equal(run.items[0]!.result, 'skipped');
    assert.match(run.items[0]!.reasons[0]!, /HTTP 503/);
    assert.match(run.items[0]!.reasons[0]!, /did not land/);
    assert.equal(t.sheets[0]!.rows[0]!.status, undefined);
  });

  it('checks the re-read after the write and records a value that differs from what it wrote', async () => {
    const t = await publishedAlerts([{ id: 'A' }], {
      hooks: {
        stored: (v) => {
          (v.eventTemplate as { properties: unknown[] }).properties = [{ key: 'event.name', value: 'something else' }];
          return v;
        },
      },
    });

    const run = await runRollbackDetectors({ ...t.args, ...apply, ids: ['A'] }, t.deps());

    assert.equal(run.items[0]!.result, 'rolled-back', 'the write went through');
    assert.ok(run.items[0]!.reasons.some((r) => /re-read after the write does not show the restored event fields/.test(r)), run.items[0]!.reasons.join(' | '));
  });
});

describe('migrate-rollback-detectors: auth failures and the sheet', () => {
  it('stops at the first 401/403: no later alert is read, and earlier rollbacks still reach the sheet', async () => {
    const t = await publishedAlerts([{ id: 'A' }, { id: 'B' }, { id: 'C' }], { hooks: { getError: (id) => (id === 'B' ? authError(id) : undefined) } });

    await assert.rejects(runRollbackDetectors({ ...t.args, ...apply, ids: ['A', 'B', 'C'] }, t.deps()), /refused the token/);

    assert.equal(t.settings.calls.some((c) => c.id === 'C'), false, 'C is never read');
    assert.equal(puts(t).some((c) => c.id === 'B'), false);
    assert.deepEqual(t.sheets[0]!.rows.map((r) => [r.asset_id, r.status]), [['A', 'rolled-back']]);
  });

  it('stops on a refused write too', async () => {
    const t = await publishedAlerts([{ id: 'A' }, { id: 'B' }], { hooks: { putError: (id) => (id === 'A' ? authError(id) : undefined) } });

    await assert.rejects(runRollbackDetectors({ ...t.args, ...apply, ids: ['A', 'B'] }, t.deps()), /refused the token/);

    assert.equal(t.settings.calls.some((c) => c.id === 'B'), false);
    assert.deepEqual(t.store.get('A')!.value, publishedValue());
  });

  it('keeps the rollback when the sheet write fails, and prints the ids to record', async () => {
    const t = await publishedAlerts([{ id: 'A' }, { id: 'B' }]);
    const deps = t.deps({
      upsert: async () => {
        throw new Error('EBUSY: resource busy or locked');
      },
    });

    const run = await runRollbackDetectors({ ...t.args, ...apply, ids: ['A', 'B'] }, deps);

    assert.equal(run.recorded, false);
    assert.deepEqual(t.store.get('A')!.value, preValue());
    const out = t.lines.join('\n');
    assert.match(out, /Rolled back, but could not write the tracker/);
    assert.match(out, /--apply --ids A,B/);
  });
});
