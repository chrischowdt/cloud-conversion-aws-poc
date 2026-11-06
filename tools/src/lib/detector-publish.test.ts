import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { BindingOutcome } from './detector-binding.ts';
import { assertAllowedEnv, decideEntity, driftOf, selectForPublish, type ManifestBatch } from './detector-publish.ts';

const batches: ManifestBatch[] = [
  {
    batch: 'batch-01',
    notebookId: 'nb-1',
    detectors: [
      { objectId: 'A-1', title: 'Alert one' },
      { objectId: 'A-2', title: 'Alert two' },
      { objectId: 'A-3', title: 'Alert three' },
    ],
  },
  { batch: 'batch-02', notebookId: 'nb-2', detectors: [{ objectId: 'B-1', title: 'Alert four' }] },
];

function row(over: Record<string, string> = {}): Record<string, string> {
  return { decision: 'Ready To Publish', reviewer: 'reviewer-a', status: 'staged', publish_override: '', ...over };
}

function sheet(): Map<string, Record<string, string>> {
  return new Map([
    ['A-1', row()],
    ['A-2', row()],
    ['A-3', row({ decision: 'Needs Review' })],
    ['B-1', row()],
  ]);
}

describe('selectForPublish', () => {
  it('selects Ready rows in the named batches, in manifest order', () => {
    const { candidates, unknownBatches } = selectForPublish(sheet(), batches, { batches: ['batch-01'] });
    assert.deepEqual(
      candidates.map((c) => c.objectId),
      ['A-1', 'A-2'],
    );
    assert.deepEqual(unknownBatches, []);
  });

  it('keeps manifest order across batches, whatever order --batches names them in', () => {
    const { candidates } = selectForPublish(sheet(), batches, { batches: ['batch-02', 'batch-01'] });
    assert.deepEqual(
      candidates.map((c) => c.objectId),
      ['A-1', 'A-2', 'B-1'],
    );
  });

  it('fills each candidate from the manifest and the row', () => {
    const rows = sheet();
    rows.set('A-1', row({ reviewer: '  reviewer-a  ' }));
    const { candidates } = selectForPublish(rows, batches, { batches: ['batch-01'] });
    assert.deepEqual(candidates[0], {
      objectId: 'A-1',
      title: 'Alert one',
      batch: 'batch-01',
      notebookId: 'nb-1',
      reviewer: 'reviewer-a',
    });
  });

  it('accepts the decision in any case', () => {
    const rows = sheet();
    rows.set('A-3', row({ decision: ' ready to publish ' }));
    const { candidates } = selectForPublish(rows, batches, { batches: ['batch-01'] });
    assert.deepEqual(
      candidates.map((c) => c.objectId),
      ['A-1', 'A-2', 'A-3'],
    );
  });

  it('skips rows already published', () => {
    const rows = sheet();
    rows.set('A-1', row({ decision: 'Published' }));
    rows.set('A-2', row({ status: 'promoted' }));
    rows.set('A-3', row({ status: 'verified' }));
    const { candidates } = selectForPublish(rows, batches, { batches: ['batch-01'] });
    assert.deepEqual(candidates, []);
  });

  it('selects an alert re-approved after a rollback', () => {
    const rows = sheet();
    rows.set('A-1', row({ status: 'rolled-back' }));
    const { candidates } = selectForPublish(rows, batches, { batches: ['batch-01'] });
    assert.deepEqual(
      candidates.map((c) => c.objectId),
      ['A-1', 'A-2'],
    );
  });

  it('does not select an alert that has no row on the sheet', () => {
    const rows = sheet();
    rows.delete('A-2');
    const { candidates } = selectForPublish(rows, batches, { batches: ['batch-01'] });
    assert.deepEqual(
      candidates.map((c) => c.objectId),
      ['A-1'],
    );
  });

  it('reports batch names the manifest does not have', () => {
    const { candidates, unknownBatches } = selectForPublish(sheet(), batches, { batches: ['batch-99'] });
    assert.deepEqual(unknownBatches, ['batch-99']);
    assert.deepEqual(candidates, []);
  });

  it('still selects from the known batches when another name is unknown', () => {
    const { candidates, unknownBatches } = selectForPublish(sheet(), batches, { batches: ['batch-02', 'batch-99'] });
    assert.deepEqual(unknownBatches, ['batch-99']);
    assert.deepEqual(
      candidates.map((c) => c.objectId),
      ['B-1'],
    );
  });

  it('ignores a batch that was never published as a notebook', () => {
    const staged: ManifestBatch[] = [...batches, { batch: 'batch-03', detectors: [{ objectId: 'C-1', title: 'Alert five' }] }];
    const rows = sheet();
    rows.set('C-1', row());
    const { candidates, unknownBatches } = selectForPublish(rows, staged, { batches: ['batch-03'] });
    assert.deepEqual(candidates, []);
    assert.deepEqual(unknownBatches, ['batch-03'], 'an unpublished batch has no notebook to read the approved queries from');
  });

  it('assigns an alert staged in two batches to the later published one, once', () => {
    const restaged: ManifestBatch[] = [
      { batch: 'batch-01', notebookId: 'nb-1', detectors: [{ objectId: 'A-1', title: 'Old title' }] },
      { batch: 'batch-02', notebookId: 'nb-2', detectors: [{ objectId: 'A-1', title: 'New title' }, { objectId: 'B-1', title: 'Alert four' }] },
    ];
    const both = selectForPublish(sheet(), restaged, { batches: ['batch-01', 'batch-02'] });
    assert.deepEqual(
      both.candidates.map((c) => [c.objectId, c.batch, c.notebookId, c.title]),
      [
        ['A-1', 'batch-02', 'nb-2', 'New title'],
        ['B-1', 'batch-02', 'nb-2', 'Alert four'],
      ],
    );
    const earlier = selectForPublish(sheet(), restaged, { batches: ['batch-01'] });
    assert.deepEqual(earlier.candidates, [], 'the earlier batch no longer owns the alert');
  });

  it('does not read the batch from the sheet column', () => {
    const rows = sheet();
    rows.set('A-1', row({ review_batch: 'batch-02' }));
    const { candidates } = selectForPublish(rows, batches, { batches: ['batch-01'] });
    assert.deepEqual(
      candidates.map((c) => c.objectId),
      ['A-1', 'A-2'],
    );
    assert.equal(candidates[0]!.batch, 'batch-01');
  });

  it('honours ids and limit', () => {
    const named = selectForPublish(sheet(), batches, { batches: ['batch-01', 'batch-02'], ids: ['A-2', 'B-1'] });
    assert.deepEqual(
      named.candidates.map((c) => c.objectId),
      ['A-2', 'B-1'],
    );
    const limited = selectForPublish(sheet(), batches, { batches: ['batch-01', 'batch-02'], limit: 1 });
    assert.deepEqual(
      limited.candidates.map((c) => c.objectId),
      ['A-1'],
    );
    const both = selectForPublish(sheet(), batches, { batches: ['batch-01', 'batch-02'], ids: ['A-2', 'B-1'], limit: 1 });
    assert.deepEqual(
      both.candidates.map((c) => c.objectId),
      ['A-2'],
      'the limit counts selected alerts, after ids narrow them',
    );
  });

  describe('publish_override', () => {
    it('needs a reviewer', () => {
      const rows = sheet();
      rows.set('A-1', row({ publish_override: 'Publish per resource', reviewer: '' }));
      rows.set('A-2', row({ publish_override: 'Publish per resource', reviewer: '   ' }));
      const { candidates } = selectForPublish(rows, batches, { batches: ['batch-01'] });
      for (const c of candidates) {
        assert.equal(c.override, undefined);
        assert.match(c.note ?? '', /^publish_override ignored: .*reviewer/);
      }
      assert.equal(candidates.length, 2, 'the alert is still selected; only the override is dropped');
    });

    it('is honoured once a reviewer is named', () => {
      const rows = sheet();
      rows.set('A-1', row({ publish_override: 'Publish per resource' }));
      rows.set('A-2', row({ publish_override: ' publish WITHOUT entity. ' }));
      const { candidates } = selectForPublish(rows, batches, { batches: ['batch-01'] });
      assert.equal(candidates[0]!.override, 'per-resource');
      assert.equal(candidates[0]!.note, undefined);
      assert.equal(candidates[1]!.override, 'without-entity');
    });

    it('is ignored, with a note, when the value is not on the list', () => {
      const rows = sheet();
      rows.set('A-1', row({ publish_override: 'yes please' }));
      const { candidates } = selectForPublish(rows, batches, { batches: ['batch-01'] });
      assert.equal(candidates[0]!.override, undefined);
      assert.match(candidates[0]!.note ?? '', /^publish_override ignored: .*yes please/);
    });

    it('leaves override and note unset when the cell is empty', () => {
      const { candidates } = selectForPublish(sheet(), batches, { batches: ['batch-01'] });
      assert.equal('override' in candidates[0]!, false);
      assert.equal('note' in candidates[0]!, false);
    });
  });
});

describe('driftOf', () => {
  const approved = 'timeseries avg(m), by:{dt.smartscape.aws_lambda_function}';
  const staged = 'timeseries avg(classic), by:{dt.entity.custom_device}';

  it('is none when the live query is still the one the card was staged from', () => {
    assert.equal(driftOf({ liveQuery: staged, stagedQuery: staged, approvedQuery: approved, liveIsMigrated: false }), 'none');
    assert.equal(driftOf({ liveQuery: `  ${staged}\n`, stagedQuery: staged, approvedQuery: approved, liveIsMigrated: false }), 'none');
    assert.equal(driftOf({ liveQuery: staged, stagedQuery: `\n${staged}  `, approvedQuery: approved, liveIsMigrated: false }), 'none');
  });

  it('is already-published when the live query is the approved one, checked first', () => {
    assert.equal(driftOf({ liveQuery: ` ${approved}\n`, stagedQuery: staged, approvedQuery: approved, liveIsMigrated: true }), 'already-published');
    assert.equal(driftOf({ liveQuery: approved, approvedQuery: approved, liveIsMigrated: true }), 'already-published', 'even with no staged query');
    assert.equal(driftOf({ liveQuery: staged, stagedQuery: staged, approvedQuery: staged, liveIsMigrated: false }), 'already-published', 'an approval that changed nothing');
  });

  it('is already-published when the live query is the one a previous apply recorded as published', () => {
    // A publish can add the entity or a name column beyond the approved text, so
    // after a publish whose sheet write failed the live query is the published one.
    const published = `${approved} | fieldsAdd dt.smartscape.aws_lambda_function.name = getNodeName(dt.smartscape.aws_lambda_function)`;
    const base = { stagedQuery: staged, approvedQuery: approved, publishedQuery: published };
    assert.equal(driftOf({ ...base, liveQuery: ` ${published}\n`, liveIsMigrated: false }), 'already-published');
    assert.equal(driftOf({ ...base, liveQuery: published, liveIsMigrated: true }), 'already-published');
    assert.equal(driftOf({ ...base, stagedQuery: undefined, liveQuery: published, liveIsMigrated: false }), 'already-published', 'even with no staged query');
    assert.equal(driftOf({ ...base, liveQuery: 'other', liveIsMigrated: false }), 'edited', 'a query that is none of the three still drifts');
    assert.equal(driftOf({ ...base, liveQuery: staged, liveIsMigrated: false }), 'none', 'a recorded publish does not hide an untouched alert');
  });

  it('reads a live query that differs from the approved one as before when nothing was published', () => {
    const published = `${approved} | fieldsAdd x = 1`;
    assert.equal(driftOf({ liveQuery: published, stagedQuery: staged, approvedQuery: approved, liveIsMigrated: false }), 'edited');
    assert.equal(driftOf({ liveQuery: published, stagedQuery: staged, approvedQuery: approved, publishedQuery: undefined, liveIsMigrated: false }), 'edited');
    assert.equal(driftOf({ liveQuery: published, stagedQuery: staged, approvedQuery: approved, publishedQuery: '  ', liveIsMigrated: false }), 'edited', 'a blank record is no record');
  });

  it('is unknown without a staged query', () => {
    assert.equal(driftOf({ liveQuery: staged, approvedQuery: approved, liveIsMigrated: false }), 'unknown');
    assert.equal(driftOf({ liveQuery: staged, stagedQuery: '  ', approvedQuery: approved, liveIsMigrated: false }), 'unknown');
  });

  it('is owner-migrated when it differs and no classic references are left', () => {
    assert.equal(driftOf({ liveQuery: 'other', stagedQuery: staged, approvedQuery: approved, liveIsMigrated: true }), 'owner-migrated');
  });

  it('is edited when it differs otherwise', () => {
    assert.equal(driftOf({ liveQuery: 'other', stagedQuery: staged, approvedQuery: approved, liveIsMigrated: false }), 'edited');
  });
});

describe('decideEntity', () => {
  // Shaped like what resolveBinding returns: bound carries a query and a note;
  // per-entity and unverified carry a query, a note AND a warning; the outcomes
  // that stay unbound carry only a warning.
  const bound: BindingOutcome = { kind: 'bound', query: 'q2', note: 'added the entity: 12 series with and without it, so the grain is unchanged.' };
  const unverified: BindingOutcome = {
    kind: 'unverified',
    query: 'q3',
    note: 'added the entity to the split.',
    warning: { kind: 'alert-per-entity', text: 'No data in the last 7 days, so it is unproven whether adding the entity keeps this alert\'s grain.' },
  };
  const perEntity: BindingOutcome = {
    kind: 'per-entity',
    query: 'q4',
    note: 'added the entity to the split: 12 series became 40 over the last 7 days.',
    warning: {
      kind: 'alert-per-entity',
      text: 'The classic alert combined several resources into each series (12 series; 40 per resource). It now alerts per resource, so check that the threshold still fits a single resource.',
    },
  };
  const outcome = (kind: 'too-many' | 'skipped' | 'error'): BindingOutcome => ({
    kind,
    warning: { kind: 'alert-unbound', text: 'This alert will not attach to an entity: the reason.' },
  });

  it('uses the bound query when the grain is unchanged', () => {
    assert.deepEqual(decideEntity(bound), { action: 'use-bound', query: 'q2' });
    assert.deepEqual(decideEntity(bound, 'per-resource'), { action: 'use-bound', query: 'q2' });
    assert.deepEqual(decideEntity(bound, 'without-entity'), { action: 'unbound' });
  });

  it('uses the bound query when the grain could not be checked', () => {
    assert.deepEqual(decideEntity(unverified), { action: 'use-bound', query: 'q3' });
    assert.deepEqual(decideEntity(unverified, 'per-resource'), { action: 'use-bound', query: 'q3' });
    assert.deepEqual(decideEntity(unverified, 'without-entity'), { action: 'unbound' });
  });

  it('sends a per-entity split back for review unless a reviewer accepted it', () => {
    const d = decideEntity(perEntity);
    assert.equal(d.action, 'skip');
    assert.match(d.action === 'skip' ? d.reason : '', /back for review/);
    assert.match(d.action === 'skip' ? d.reason : '', /publish_override/);
    assert.deepEqual(decideEntity(perEntity, 'per-resource'), { action: 'use-bound', query: 'q4' });
    assert.deepEqual(decideEntity(perEntity, 'without-entity'), { action: 'unbound' });
  });

  it('puts the series counts in the per-entity reason', () => {
    const d = decideEntity(perEntity);
    assert.match(d.action === 'skip' ? d.reason : '', /12 series; 40 per resource/);
  });

  it('still skips a per-entity split whose warning is missing', () => {
    const { warning: _dropped, ...bare } = perEntity;
    const d = decideEntity(bare);
    assert.equal(d.action, 'skip');
    assert.match(d.action === 'skip' ? d.reason : '', /back for review/);
  });

  it('skips when no entity can be added, unless the reviewer says it has none', () => {
    for (const kind of ['too-many', 'skipped', 'error'] as const) {
      for (const override of [undefined, 'per-resource'] as const) {
        const d = decideEntity(outcome(kind), override);
        assert.equal(d.action, 'skip', `${kind} / ${override ?? 'no override'}`);
        assert.match(d.action === 'skip' ? d.reason : '', /back for review/, `${kind} / ${override ?? 'no override'}`);
      }
      assert.deepEqual(decideEntity(outcome(kind), 'without-entity'), { action: 'unbound' }, kind);
    }
  });

  it('carries the binding check detail into the skip reason', () => {
    const d = decideEntity(outcome('error'));
    assert.match(d.action === 'skip' ? d.reason : '', /the reason\./);
  });

  it('says why a per-resource override cannot lift a cap', () => {
    const d = decideEntity(outcome('too-many'), 'per-resource');
    assert.match(d.action === 'skip' ? d.reason : '', /Publish per resource.*cannot/);
    assert.match(d.action === 'skip' ? d.reason : '', /Publish without entity/);
  });

  it('fails closed on a bound outcome that carries no query', () => {
    for (const kind of ['bound', 'unverified', 'per-entity'] as const) {
      assert.equal(decideEntity({ kind }, 'per-resource').action, 'skip', kind);
    }
  });

  it('does not decide for a query that already binds an entity', () => {
    assert.equal(decideEntity({ kind: 'already' }).action, 'skip');
    assert.equal(decideEntity({ kind: 'already' }, 'per-resource').action, 'skip');
    assert.deepEqual(decideEntity({ kind: 'already' }, 'without-entity'), { action: 'unbound' });
  });
});

describe('assertAllowedEnv', () => {
  const url = 'https://abc12345.apps.dynatrace.com';

  it('throws when applying without --allow-env', () => {
    assert.throws(() => assertAllowedEnv(url, undefined, true), /--allow-env/);
    assert.throws(() => assertAllowedEnv(url, '', true), /--allow-env/);
    assert.throws(() => assertAllowedEnv(url, '   ', true), /--allow-env/);
  });

  it('throws when --allow-env names another environment, naming both', () => {
    assert.throws(() => assertAllowedEnv(url, 'zzz99999', true), (e: Error) => /abc12345/.test(e.message) && /zzz99999/.test(e.message));
  });

  it('passes when they match', () => {
    assert.doesNotThrow(() => assertAllowedEnv(url, 'abc12345', true));
    assert.doesNotThrow(() => assertAllowedEnv(url, ' abc12345 ', true));
  });

  it('passes when not applying, whatever --allow-env says', () => {
    assert.doesNotThrow(() => assertAllowedEnv(url, undefined, false));
    assert.doesNotThrow(() => assertAllowedEnv(url, 'zzz99999', false));
  });
});
