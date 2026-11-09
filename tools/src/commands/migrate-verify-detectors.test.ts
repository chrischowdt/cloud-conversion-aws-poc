import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runVerifyDetectors } from './migrate-verify-detectors.ts';
import { SettingsApiError } from '../dynatrace/settings.ts';
import { ALERTS_SHEET, readRows, upsertRows } from '../lib/tracker-xlsx.ts';
import { APPROVED, NEW_PROPS, NOW, detector, publishedAlerts } from './__testing__/published-alerts.ts';

// migrate-verify-detectors re-reads each promoted alert and compares the parts a
// publish writes with its published record. It never writes to the tenant, and
// it writes the sheet without --apply.

const authError = (id: string) => new SettingsApiError(403, `https://example/settings/objects/${id}`, '{"error":{"message":"Forbidden"}}');

describe('migrate-verify-detectors', () => {
  it('marks an alert verified when it still has the published query and event fields, and never writes to the tenant', async () => {
    const t = await publishedAlerts([{ id: 'A' }]);

    const run = await runVerifyDetectors(t.args, t.deps());

    assert.deepEqual(run.verified, ['A']);
    assert.deepEqual(t.settings.calls.map((c) => c.op), ['get']);
    assert.equal(t.sheets.length, 1);
    assert.equal(t.sheets[0]!.sheet, ALERTS_SHEET);
    assert.equal(t.sheets[0]!.path, t.trackerPath);
    assert.deepEqual(t.sheets[0]!.rows, [
      { asset_id: 'A', asset_type: 'anomaly-detector', name: 'Queue backlog', status: 'verified', verified_at: NOW.toISOString() },
    ]);
  });

  it('ignores a change to anything a publish does not write, such as the threshold or enabled', async () => {
    const t = await publishedAlerts([{ id: 'A', live: { value: detector(APPROVED, NEW_PROPS, { threshold: '250', enabled: false }), updateToken: 'x' } }]);

    const run = await runVerifyDetectors(t.args, t.deps());

    assert.deepEqual(run.verified, ['A']);
  });

  it('flags an alert whose stored query differs, naming the part, and leaves its status', async () => {
    const t = await publishedAlerts([
      { id: 'Q', live: { value: detector(`${APPROVED}\n| filter v > 1`, NEW_PROPS), updateToken: 'x' } },
      { id: 'P', live: { value: detector(APPROVED, [{ key: 'event.name', value: 'edited' }]), updateToken: 'x' } },
    ]);

    const run = await runVerifyDetectors(t.args, t.deps());

    assert.deepEqual(run.verified, []);
    assert.deepEqual(run.flagged, ['Q', 'P']);
    const [q, p] = t.sheets[0]!.rows;
    assert.deepEqual(Object.keys(q!).sort(), ['asset_id', 'asset_type', 'name', 'reasons'], 'no status: it is left as it is');
    assert.match(q!.reasons!, /^verify: /);
    assert.match(q!.reasons!, /does not have the published query\b/);
    assert.match(q!.reasons!, /someone edited it since, or the write did not stick/);
    assert.match(p!.reasons!, /does not have the published event fields/);
    assert.equal(t.settings.calls.some((c) => c.op === 'put'), false);
  });

  it('compares with what the server stored when the record has it, not with what was sent', async () => {
    const stored = detector(APPROVED, [{ key: 'event.name', value: 'normalised by the server' }]);
    const t = await publishedAlerts([
      { id: 'S', stored, live: { value: stored, updateToken: 'x' } },
      { id: 'W', stored }, // live still holds what was sent, which the server did not keep
    ]);

    const run = await runVerifyDetectors(t.args, t.deps());

    assert.deepEqual(run.verified, ['S']);
    assert.deepEqual(run.flagged, ['W']);
  });

  it('reports "no published record" for an alert the tool recorded without publishing it, and the run still succeeds', async () => {
    const t = await publishedAlerts([{ id: 'HAND', published: null, pre: null }, { id: 'A' }]);

    const run = await runVerifyDetectors(t.args, t.deps());

    assert.deepEqual(run.verified, ['A']);
    assert.deepEqual(run.flagged, ['HAND']);
    const hand = t.sheets[0]!.rows.find((r) => r.asset_id === 'HAND')!;
    assert.equal(hand.status, undefined, 'status left as it is');
    assert.equal(hand.verified_at, undefined);
    assert.match(hand.reasons!, /no published record/);
    assert.equal(t.settings.calls.some((c) => c.id === 'HAND'), false, 'nothing to compare it with, so it is not read');
  });

  it('flags an alert that no longer exists, or cannot be read', async () => {
    const t = await publishedAlerts([{ id: 'GONE', live: null }, { id: 'ERR' }], {
      hooks: { getError: (id) => (id === 'ERR' ? new SettingsApiError(500, 'https://example/settings/objects/ERR', '{"error":{"message":"boom"}}') : undefined) },
    });

    const run = await runVerifyDetectors(t.args, t.deps());

    assert.deepEqual(run.flagged, ['GONE', 'ERR']);
    const byId = Object.fromEntries(t.sheets[0]!.rows.map((r) => [r.asset_id, r.reasons]));
    assert.match(byId['GONE']!, /no longer exists \(HTTP 404\)/);
    assert.match(byId['ERR']!, /could not be read: HTTP 500/);
  });

  it('acts on promoted rows only', async () => {
    const t = await publishedAlerts([{ id: 'A' }, { id: 'V', status: 'verified' }, { id: 'S', status: 'staged', decision: 'Ready To Publish' }, { id: 'R', status: 'rolled-back' }]);

    const run = await runVerifyDetectors(t.args, t.deps());

    assert.deepEqual(run.verified, ['A']);
    assert.deepEqual([...new Set(t.settings.calls.map((c) => c.id))], ['A']);
  });

  it('selects by --batches through the manifest, and narrows by --ids', async () => {
    const manifest = [
      { batch: 'batch-03', notebookId: 'nb-3', detectors: [{ objectId: 'A', title: 'a' }, { objectId: 'B', title: 'b' }] },
      { batch: 'batch-04', notebookId: 'nb-4', detectors: [{ objectId: 'C', title: 'c' }] },
    ];
    const t = await publishedAlerts([{ id: 'A' }, { id: 'B' }, { id: 'C' }], { manifest });

    assert.deepEqual((await runVerifyDetectors({ ...t.args, batches: ['batch-03'] }, t.deps())).verified, ['A', 'B']);
    assert.deepEqual((await runVerifyDetectors({ ...t.args, batches: ['batch-03'], ids: ['B'] }, t.deps())).verified, ['B']);
    assert.deepEqual((await runVerifyDetectors({ ...t.args, ids: ['C'] }, t.deps())).verified, ['C']);
  });

  it('says why a named id was not selected', async () => {
    const t = await publishedAlerts([{ id: 'A' }, { id: 'S', status: 'staged' }]);

    const run = await runVerifyDetectors({ ...t.args, ids: ['S', 'NOPE'] }, t.deps());

    assert.deepEqual(run.verified, []);
    const out = t.lines.join('\n');
    assert.match(out, /S: status is "staged", not promoted/);
    assert.match(out, /NOPE: not on the alerts sheet/);
    assert.equal(t.settings.calls.length, 0);
    assert.equal(t.sheets.length, 0, 'nothing to record');
  });

  it('clears an earlier verify flag once the alert verifies, and leaves other reasons alone', async () => {
    const t = await publishedAlerts([
      { id: 'F', reasons: 'verify: the live alert does not have the published query (published 2026-11-06).' },
      { id: 'N', reasons: 'added `dt.smartscape_source.id` to the split.' },
    ]);

    await runVerifyDetectors(t.args, t.deps());

    const byId = Object.fromEntries(t.sheets[0]!.rows.map((r) => [r.asset_id, r]));
    assert.equal(byId['F']!.reasons, '');
    assert.equal('reasons' in byId['N']!, false);
  });

  it('stops at the first 401/403: no later alert is read, and earlier results still reach the sheet', async () => {
    const t = await publishedAlerts([{ id: 'A' }, { id: 'B' }, { id: 'C' }], { hooks: { getError: (id) => (id === 'B' ? authError(id) : undefined) } });

    await assert.rejects(runVerifyDetectors(t.args, t.deps()), /refused the token/);

    assert.equal(t.settings.calls.some((c) => c.id === 'C'), false);
    assert.deepEqual(t.sheets[0]!.rows.map((r) => [r.asset_id, r.status]), [['A', 'verified']]);
  });

  it('reports a failed sheet write and names the ids', async () => {
    const t = await publishedAlerts([{ id: 'A' }]);
    const deps = t.deps({
      upsert: async () => {
        throw new Error('EBUSY: resource busy or locked');
      },
    });

    const run = await runVerifyDetectors(t.args, deps);

    assert.equal(run.recorded, false);
    const out = t.lines.join('\n');
    assert.match(out, /could not write the tracker/);
    assert.match(out, /\bA\b/);
  });

  it('writes the real workbook: verified status and time, human columns kept', async () => {
    const t = await publishedAlerts([{ id: 'A' }]);
    await upsertRows(t.trackerPath, [], ALERTS_SHEET);

    await runVerifyDetectors(t.args, t.deps({ upsert: undefined }));

    const row = (await readRows(t.trackerPath, ALERTS_SHEET)).get('A')!;
    assert.equal(row.status, 'verified');
    assert.equal(row.verified_at, NOW.toISOString());
    assert.equal(row.decision, 'Published');
    assert.equal(row.reasons, 'a publish note');
  });

  it('refuses an empty --ids or --batches before reading anything', async () => {
    const t = await publishedAlerts([{ id: 'A' }]);
    await assert.rejects(runVerifyDetectors({ ...t.args, ids: [] }, t.deps()), /--ids/);
    await assert.rejects(runVerifyDetectors({ ...t.args, batches: [] }, t.deps()), /--batches/);
    assert.equal(t.settings.calls.length, 0);
  });
});
