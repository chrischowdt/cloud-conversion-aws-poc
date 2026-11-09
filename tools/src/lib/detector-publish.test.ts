import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { BindingOutcome } from './detector-binding.ts';
import { buildReviewQuery } from './detector-notebook.ts';
import { SettingsApiError } from '../dynatrace/settings.ts';
import { DqlError } from '../dynatrace/dql.ts';
import { DocumentApiError } from '../dynatrace/document.ts';
import {
  BUILTIN_PLACEHOLDERS,
  detectorValuesEqual,
  parseIds,
  whyNotSelected,
  assertAllowedEnv,
  buildPublishValue,
  decideEntity,
  diffOutsidePublishedParts,
  driftOf,
  findApprovedTile,
  isAuthFailure,
  mapEventFields,
  parseBatches,
  parseLimit,
  publishedPartsDiff,
  publishedPartsEqual,
  restoreValue,
  rollbackDecision,
  selectForPublish,
  selectPublished,
  staticColumns,
  stagedQueriesOf,
  withColumnAliases,
  withNodeNameColumn,
  type EventProp,
  type ManifestBatch,
} from './detector-publish.ts';

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
      status: 'staged',
    });
  });

  it("carries the row's status, trimmed and lower-cased: a re-approval after a rollback keeps rolled-back", () => {
    const rows = sheet();
    rows.set('A-1', row({ status: ' Rolled-Back ' }));
    rows.set('A-2', row({ status: '' }));
    const { candidates } = selectForPublish(rows, batches, { batches: ['batch-01'] });
    assert.deepEqual(candidates.map((c) => c.status), ['rolled-back', '']);
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

  it('is already-published when the live query is any query an earlier apply wrote or may have written (its pending record)', () => {
    const pending = `${approved}\n| fieldsAdd x = 1`;
    const base = { stagedQuery: staged, approvedQuery: approved, publishedQuery: 'an older publish', publishedQueries: [pending] };
    assert.equal(driftOf({ ...base, liveQuery: pending, liveIsMigrated: true }), 'already-published');
    assert.equal(driftOf({ ...base, publishedQuery: undefined, liveQuery: ` ${pending} `, liveIsMigrated: true }), 'already-published');
    assert.equal(driftOf({ ...base, liveQuery: 'other', liveIsMigrated: false }), 'edited');
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

  describe('with several staged candidates', () => {
    const fromTile = `${staged}\nnew proposed dql`;
    const fromArchive = 'timeseries avg(classic), interval:1m';

    it('is none when the live query matches any of them, ignoring surrounding whitespace', () => {
      assert.equal(driftOf({ liveQuery: staged, stagedQueries: [fromArchive, staged], approvedQuery: approved, liveIsMigrated: false }), 'none');
      assert.equal(driftOf({ liveQuery: ` ${staged}\n`, stagedQueries: [fromTile, fromArchive, `${staged}  `], approvedQuery: approved, liveIsMigrated: false }), 'none');
    });

    it('drifts only when it matches none of them', () => {
      const a = { stagedQueries: [fromArchive, fromTile], approvedQuery: approved };
      assert.equal(driftOf({ ...a, liveQuery: 'other', liveIsMigrated: false }), 'edited');
      assert.equal(driftOf({ ...a, liveQuery: 'other', liveIsMigrated: true }), 'owner-migrated');
    });

    it('is unknown when no candidate is known', () => {
      assert.equal(driftOf({ liveQuery: staged, stagedQueries: [], approvedQuery: approved, liveIsMigrated: false }), 'unknown');
      assert.equal(driftOf({ liveQuery: staged, stagedQueries: ['', '  '], approvedQuery: approved, liveIsMigrated: false }), 'unknown');
    });

    it('counts stagedQuery as one more candidate', () => {
      assert.equal(driftOf({ liveQuery: staged, stagedQuery: fromArchive, stagedQueries: [staged], approvedQuery: approved, liveIsMigrated: false }), 'none');
    });

    it('still checks already-published first', () => {
      assert.equal(driftOf({ liveQuery: approved, stagedQueries: [staged, approved], approvedQuery: approved, liveIsMigrated: true }), 'already-published');
    });
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

const SQS = 'dt.smartscape.aws_sqs_queue';

function map(props: EventProp[], over: { columns?: string[]; entityColumn?: string; withoutEntity?: boolean } = {}) {
  return mapEventFields(props, { columns: new Set(over.columns ?? []), entityColumn: over.entityColumn, withoutEntity: over.withoutEntity ?? false });
}

/** The value of the first property with this key. */
function valueOf(props: EventProp[], key: string): unknown {
  return props.find((p) => p.key === key)?.value;
}

describe('mapEventFields: the entity binding', () => {
  it('drops the classic binding and sets the Smartscape one', () => {
    const r = map([{ key: 'dt.source_entity', value: '{dims:dt.entity.custom_device}' }], { entityColumn: SQS });
    assert.equal(
      r.props.some((p) => p.key === 'dt.source_entity'),
      false,
    );
    assert.equal(valueOf(r.props, 'dt.smartscape_source.id'), `{${SQS}}`);
    assert.deepEqual(r.unresolved, []);
  });

  it('sets neither binding key without an entity column', () => {
    const r = map(
      [
        { key: 'dt.source_entity', value: '{dims:dt.entity.custom_device}' },
        { key: 'dt.smartscape_source.id', value: '{dt.smartscape.aws_old}' },
      ],
      { withoutEntity: true },
    );
    assert.deepEqual(r.props, []);
  });

  it('keeps the binding where the classic one stood and the other properties in order', () => {
    const r = map(
      [
        { key: 'event.name', value: 'Queue backlog' },
        { key: 'dt.source_entity', value: '{dims:dt.entity.custom_device}' },
        { key: 'event.description', value: 'Check the consumers' },
      ],
      { entityColumn: SQS },
    );
    assert.deepEqual(
      r.props.map((p) => p.key),
      ['event.name', 'dt.smartscape_source.id', 'event.description'],
    );
  });

  it('appends the binding when the template had none, and leaves a correct one alone', () => {
    const added = map([{ key: 'event.name', value: 'x' }], { entityColumn: SQS });
    assert.deepEqual(added.props, [
      { key: 'event.name', value: 'x' },
      { key: 'dt.smartscape_source.id', value: `{${SQS}}` },
    ]);
    assert.equal(added.changes.length, 1);

    const same = map([{ key: 'dt.smartscape_source.id', value: `{${SQS}}` }], { entityColumn: SQS });
    assert.deepEqual(same.props, [{ key: 'dt.smartscape_source.id', value: `{${SQS}}` }]);
    assert.deepEqual(same.changes, []);
  });

  it('rebuilds a stale Smartscape binding and keeps a single one when both are present', () => {
    const r = map(
      [
        { key: 'dt.source_entity', value: '{dims:dt.entity.custom_device}' },
        { key: 'dt.smartscape_source.id', value: '{dt.smartscape.aws_old}' },
      ],
      { entityColumn: SQS },
    );
    assert.deepEqual(r.props, [{ key: 'dt.smartscape_source.id', value: `{${SQS}}` }]);
  });

  it('reports the binding change', () => {
    const r = map([{ key: 'dt.source_entity', value: '{dims:dt.entity.custom_device}' }], { entityColumn: SQS });
    assert.deepEqual(r.changes, [
      { field: 'dt.source_entity → dt.smartscape_source.id', before: '{dims:dt.entity.custom_device}', after: `{${SQS}}` },
    ]);
  });
});

describe('mapEventFields: placeholders', () => {
  it('maps a classic entity id and name', () => {
    const r = map(
      [{ key: 'event.name', value: 'High on {dims:dt.entity.custom_device.name} ({dims:dt.entity.custom_device})' }],
      { entityColumn: SQS, columns: [SQS] },
    );
    assert.equal(valueOf(r.props, 'event.name'), `High on {dims:${SQS}.name} ({dims:${SQS}})`);
    assert.equal(r.nameColumn, `${SQS}.name`);
    assert.deepEqual(r.unresolved, []);
    assert.ok(
      r.changes.some(
        (c) =>
          c.field === 'event.name' &&
          c.before === 'High on {dims:dt.entity.custom_device.name} ({dims:dt.entity.custom_device})' &&
          c.after === `High on {dims:${SQS}.name} ({dims:${SQS}})`,
      ),
    );
  });

  it('keeps the bare form of a mapped entity placeholder and maps dt.source_entity too', () => {
    const r = map([{ key: 'event.name', value: '{dt.entity.aws_lambda_function} {dims:dt.source_entity} {dt.source_entity.name}' }], {
      entityColumn: SQS,
    });
    assert.equal(valueOf(r.props, 'event.name'), `{${SQS}} {dims:${SQS}} {${SQS}.name}`);
    assert.equal(r.nameColumn, `${SQS}.name`);
  });

  it('sets no name column when no name placeholder was mapped', () => {
    const r = map([{ key: 'event.name', value: 'On {dims:dt.entity.custom_device}' }], { entityColumn: SQS });
    assert.equal(r.nameColumn, undefined);
  });

  it('keeps built-ins and emitted columns, bare or dims', () => {
    const text = '{threshold} {severity} {dims:ServiceName} {ServiceName}';
    const r = map([{ key: 'event.description', value: text }], { columns: ['ServiceName'] });
    assert.equal(valueOf(r.props, 'event.description'), text);
    assert.deepEqual(r.unresolved, []);
    assert.deepEqual(r.changes, []);
  });

  it('knows every built-in placeholder', () => {
    const builtins = ['threshold', 'severity', 'alert_condition', 'violating_samples', 'dealerting_samples', 'sliding_window', 'metricname', 'metric_value', 'baseline', 'dims'];
    assert.deepEqual([...BUILTIN_PLACEHOLDERS].sort(), [...builtins].sort());
    const text = builtins.map((b) => `{${b}}`).join(' ');
    const r = map([{ key: 'event.description', value: text }]);
    assert.equal(valueOf(r.props, 'event.description'), text);
    assert.deepEqual(r.unresolved, []);
  });

  it('matches a respelled dimension that has no spaces', () => {
    const r = map([{ key: 'event.name', value: '{dims:cluster_name}' }], { columns: ['ClusterName'] });
    assert.equal(valueOf(r.props, 'event.name'), '{dims:ClusterName}');
    assert.deepEqual(r.unresolved, []);
    assert.deepEqual(r.aliases, []);
  });

  it('reads a column whose name has spaces through an alias without them', () => {
    const r = map([{ key: 'event.name', value: 'Lag on {dims:cluster_name}' }], { columns: ['Cluster Name'] });
    assert.equal(valueOf(r.props, 'event.name'), 'Lag on {dims:Cluster_Name}');
    assert.deepEqual(r.aliases, [{ alias: 'Cluster_Name', column: 'Cluster Name' }]);
    assert.deepEqual(r.unresolved, []);
  });

  it('aliases a placeholder that names a spaced column exactly, each whitespace run becoming one underscore', () => {
    const r = map([{ key: 'event.name', value: '{dims:Consumer  Group} on {dims:Broker ID}' }], { columns: ['Consumer  Group', 'Broker ID'] });
    assert.equal(valueOf(r.props, 'event.name'), '{dims:Consumer_Group} on {dims:Broker_ID}');
    assert.deepEqual(r.aliases, [
      { alias: 'Consumer_Group', column: 'Consumer  Group' },
      { alias: 'Broker_ID', column: 'Broker ID' },
    ]);
  });

  it('lists each alias once, however many placeholders read it', () => {
    const r = map(
      [
        { key: 'event.name', value: '{dims:cluster_name} {Cluster Name}' },
        { key: 'event.description', value: '{dims:Cluster Name}' },
      ],
      { columns: ['Cluster Name'] },
    );
    assert.deepEqual(r.aliases, [{ alias: 'Cluster_Name', column: 'Cluster Name' }]);
  });

  it('matches regardless of case and backticks, and keeps the bare form', () => {
    const r = map([{ key: 'event.name', value: '{`CLUSTER_NAME`}' }], { columns: ['Cluster Name'] });
    assert.equal(valueOf(r.props, 'event.name'), '{Cluster_Name}');
    assert.deepEqual(r.aliases, [{ alias: 'Cluster_Name', column: 'Cluster Name' }]);
  });

  it('prefers the column without spaces, and needs no alias then', () => {
    for (const columns of [
      ['Broker ID', 'Broker_ID'],
      ['Broker_ID', 'Broker ID'],
    ]) {
      const r = map([{ key: 'event.name', value: '{dims:broker_id}' }], { columns });
      assert.equal(valueOf(r.props, 'event.name'), '{dims:Broker_ID}', columns.join(' | '));
      assert.deepEqual(r.aliases, [], columns.join(' | '));
    }
  });

  it('moves a placeholder that names a spaced column to the emitted column without spaces', () => {
    const r = map([{ key: 'event.name', value: '{dims:Broker ID} {Broker ID}' }], { columns: ['Broker ID', 'Broker_ID'] });
    assert.equal(valueOf(r.props, 'event.name'), '{dims:Broker_ID} {Broker_ID}');
    assert.deepEqual(r.aliases, []);
  });

  it('leaves a placeholder that already names a column without spaces as it is, even when a spaced sibling exists', () => {
    const r = map([{ key: 'event.name', value: '{dims:Broker_ID}' }], { columns: ['Broker ID', 'Broker_ID'] });
    assert.equal(valueOf(r.props, 'event.name'), '{dims:Broker_ID}');
    assert.deepEqual(r.changes, []);
  });

  it('reports what it cannot map and leaves the text', () => {
    const r = map([{ key: 'event.name', value: 'Role {dims:Role}' }], { columns: ['ServiceName'] });
    assert.deepEqual(r.unresolved, ['{dims:Role}']);
    assert.equal(valueOf(r.props, 'event.name'), 'Role {dims:Role}');
    assert.deepEqual(r.changes, []);
  });

  it('lists an unresolved placeholder once, across properties', () => {
    const r = map(
      [
        { key: 'event.name', value: '{dims:Role} and {Role}' },
        { key: 'event.description', value: '{dims:Role}' },
      ],
      { columns: [] },
    );
    assert.deepEqual(r.unresolved, ['{dims:Role}', '{Role}']);
  });

  it('reports a classic entity placeholder as unresolved when there is no entity and none was waived', () => {
    const r = map([{ key: 'event.name', value: 'On {dims:dt.entity.custom_device}' }]);
    assert.deepEqual(r.unresolved, ['{dims:dt.entity.custom_device}']);
    assert.equal(valueOf(r.props, 'event.name'), 'On {dims:dt.entity.custom_device}');
  });

  it('leaves a classic entity placeholder alone when the query emits that very column', () => {
    const r = map([{ key: 'event.name', value: 'On {dims:dt.entity.host}' }], { columns: ['dt.entity.host'] });
    assert.equal(valueOf(r.props, 'event.name'), 'On {dims:dt.entity.host}');
    assert.deepEqual(r.unresolved, []);
  });

  it('without an entity, entity placeholders are removed', () => {
    const r = map([{ key: 'event.name', value: 'Lag on {dims:dt.entity.custom_device.name}' }], { withoutEntity: true });
    assert.equal(valueOf(r.props, 'event.name'), 'Lag on');
    assert.deepEqual(r.unresolved, []);
    assert.equal(r.changes.length, 1);
    assert.equal(r.nameColumn, undefined);
  });

  it('closes the gap a removed placeholder leaves in the middle of a sentence', () => {
    const r = map([{ key: 'event.name', value: '{dims:dt.entity.custom_device} lag on {dims:dt.entity.custom_device.name} is high' }], {
      withoutEntity: true,
    });
    assert.equal(valueOf(r.props, 'event.name'), 'lag on is high');
  });

  it('passes non-string values and keyless properties through untouched', () => {
    const props: EventProp[] = [{ key: 'n', value: 5 }, { value: 'x {dims:Q}' }, { key: 'o', value: { a: 1 } }];
    const r = map(props, { columns: ['Q'] });
    assert.deepEqual(r.props, props);
    assert.deepEqual(r.unresolved, []);
  });

  it('does not mutate the properties it is given', () => {
    const props: EventProp[] = [
      { key: 'dt.source_entity', value: '{dims:dt.entity.custom_device}' },
      { key: 'event.name', value: 'On {dims:dt.entity.custom_device.name}' },
    ];
    const before = JSON.stringify(props);
    map(props, { entityColumn: SQS });
    assert.equal(JSON.stringify(props), before);
  });
});

describe('withNodeNameColumn', () => {
  it('appends a fieldsAdd that reads the node name', () => {
    const out = withNodeNameColumn(`timeseries x=avg(m), by:{${SQS}}`, SQS);
    assert.ok(out.startsWith(`timeseries x=avg(m), by:{${SQS}}`));
    assert.ok(out.endsWith(`\n| fieldsAdd ${SQS}.name = getNodeName(${SQS})`));
  });

  it('does not leave a blank line after a query that ends in a newline', () => {
    const out = withNodeNameColumn(`timeseries x=avg(m), by:{${SQS}}\n`, SQS);
    assert.equal(out, `timeseries x=avg(m), by:{${SQS}}\n| fieldsAdd ${SQS}.name = getNodeName(${SQS})`);
  });

  it('starts the new command on its own line after a trailing comment', () => {
    const out = withNodeNameColumn(`timeseries x=avg(m), by:{${SQS}} // per queue`, SQS);
    assert.ok(out.includes('// per queue\n| fieldsAdd'));
  });
});

describe('withColumnAliases', () => {
  it('adds every alias on one new line', () => {
    const q = 'timeseries x = avg(m), by:{`Cluster Name`, `Broker ID`}\n';
    assert.equal(
      withColumnAliases(q, [
        { alias: 'Cluster_Name', column: 'Cluster Name' },
        { alias: 'Broker_ID', column: 'Broker ID' },
      ]),
      'timeseries x = avg(m), by:{`Cluster Name`, `Broker ID`}\n| fieldsAdd Cluster_Name = `Cluster Name`, Broker_ID = `Broker ID`',
    );
  });

  it('leaves the query alone without aliases', () => {
    assert.equal(withColumnAliases('timeseries x = avg(m)\n', []), 'timeseries x = avg(m)\n');
  });

  it('emits columns the event fields then read, as the static column reader sees them', () => {
    const q = withColumnAliases('timeseries x = avg(m), by:{`Cluster Name`} // note', [{ alias: 'Cluster_Name', column: 'Cluster Name' }]);
    assert.ok(staticColumns(q).has('Cluster_Name'));
  });
});

describe('staticColumns', () => {
  it('lists what a timeseries, its by-clause and the later fields emit', () => {
    const q = 'timeseries v = avg(m), by:{dt.smartscape_source.id = dt.smartscape.aws_x, QueueName}\n| fieldsAdd env = "a"';
    assert.deepEqual(staticColumns(q), new Set(['v', 'timeframe', 'interval', 'dt.smartscape_source.id', 'QueueName', 'env']));
  });

  it('reads backtick-quoted dimensions and several aggregations in braces', () => {
    const q = 'timeseries {a = avg(m), b = max(m, rollup: total)}, by:{`Cluster Name`, Broker_ID = `Broker ID`}';
    assert.deepEqual(staticColumns(q), new Set(['a', 'b', 'timeframe', 'interval', 'Cluster Name', 'Broker_ID']));
  });

  it('reads fields and fieldsAdd names, bare or assigned, and ignores commas inside calls and strings', () => {
    const q = ['timeseries v = avg(m)', '| fieldsAdd x = if(a > 1, "p,q", "r"), `y z` = 2', '| fields v, timeframe, x = x, `y z`'].join('\n');
    assert.deepEqual(staticColumns(q), new Set(['v', 'timeframe', 'interval', 'x', 'y z']));
  });

  it('does not count a by-clause buried in a filter, a comment or a string', () => {
    const q = 'timeseries v = avg(m, filter: {matchesValue(a, "by:{nope}")}), by:{Real} // by:{alsoNope}';
    assert.deepEqual(staticColumns(q), new Set(['v', 'timeframe', 'interval', 'Real']));
  });

  it('reads every timeseries, including one inside an append', () => {
    const q = 'timeseries a = avg(m), by:{One}\n| append [ timeseries b = avg(n), by:{Two} ]';
    assert.deepEqual(staticColumns(q), new Set(['a', 'b', 'timeframe', 'interval', 'One', 'Two']));
  });

  it('is empty for a query with no timeseries and no field commands', () => {
    assert.deepEqual(staticColumns('fetch logs | limit 5'), new Set());
  });
});

type Inputs = Array<{ key: string; value: string }>;

function liveDetector(): Record<string, unknown> {
  return {
    enabled: false,
    title: 'Queue backlog',
    description: 'd',
    executionSettings: { actor: 'actor-1' },
    analyzer: {
      name: 'dt.statistics.ui.anomaly_detection.StaticThresholdAnomalyDetectionAnalyzer',
      input: [
        { key: 'query.expression', value: 'timeseries x=avg(old)' },
        { key: 'threshold', value: '5' },
        { key: 'alertCondition', value: 'ABOVE' },
      ],
    },
    eventTemplate: { properties: [{ key: 'event.name', value: 'old name' }], other: 'kept' },
  };
}

describe('buildPublishValue', () => {
  it('changes only the query and the event properties', () => {
    const live = liveDetector();
    const props: EventProp[] = [{ key: 'event.name', value: 'new name' }];
    const out = buildPublishValue(live, 'timeseries x=avg(new)', props);

    const input = (out.analyzer as { input: Inputs }).input;
    assert.equal(input.find((i) => i.key === 'query.expression')?.value, 'timeseries x=avg(new)');
    assert.deepEqual((out.eventTemplate as { properties: EventProp[] }).properties, props);

    // Reset those two parts and nothing else differs from live.
    const back = structuredClone(out);
    (back.analyzer as { input: Inputs }).input.find((i) => i.key === 'query.expression')!.value = 'timeseries x=avg(old)';
    (back.eventTemplate as { properties: EventProp[] }).properties = [{ key: 'event.name', value: 'old name' }];
    assert.deepEqual(back, liveDetector());
  });

  it('writes the query under the key the detector already uses', () => {
    const live = liveDetector();
    (live.analyzer as { input: Inputs }).input[0]!.key = 'query';
    const out = buildPublishValue(live, 'Q', []);
    const input = (out.analyzer as { input: Inputs }).input;
    assert.deepEqual(
      input.map((i) => i.key),
      ['query', 'threshold', 'alertCondition'],
    );
    assert.equal(input[0]!.value, 'Q');
  });

  it('never mutates live or the properties it is given', () => {
    const live = liveDetector();
    const props: EventProp[] = [{ key: 'event.name', value: 'new name' }];
    const out = buildPublishValue(live, 'Q', props);
    assert.deepEqual(live, liveDetector());
    (out.eventTemplate as { properties: EventProp[] }).properties[0]!.value = 'changed after';
    assert.equal(props[0]!.value, 'new name');
  });

  it('adds an event template when the detector had none', () => {
    const live = liveDetector();
    delete live.eventTemplate;
    const out = buildPublishValue(live, 'Q', [{ key: 'a', value: 'b' }]);
    assert.deepEqual(out.eventTemplate, { properties: [{ key: 'a', value: 'b' }] });
  });

  it('refuses a detector with no query input rather than publish nothing', () => {
    const live = liveDetector();
    (live.analyzer as { input: unknown[] }).input = [{ key: 'threshold', value: '5' }];
    assert.throws(() => buildPublishValue(live, 'Q', []), /query/);
  });
});

describe('publishedPartsEqual', () => {
  it('ignores key order and other fields', () => {
    const a = liveDetector();
    const b: Record<string, unknown> = {
      eventTemplate: { other: 'x', properties: [{ value: 'old name', key: 'event.name' }] },
      analyzer: { input: [{ value: 'timeseries x=avg(old)', key: 'query.expression' }, { key: 'threshold', value: '9' }], name: 'other' },
      enabled: true,
      extra: { added: 'by the API' },
    };
    assert.equal(publishedPartsEqual(a, b), true);
    assert.equal(publishedPartsEqual(b, a), true);
  });

  it('is false for a different query or different properties', () => {
    const a = liveDetector();
    const q = liveDetector();
    (q.analyzer as { input: Inputs }).input[0]!.value = 'timeseries x=avg(other)';
    assert.equal(publishedPartsEqual(a, q), false);

    const p = liveDetector();
    (p.eventTemplate as { properties: EventProp[] }).properties = [{ key: 'event.name', value: 'different' }];
    assert.equal(publishedPartsEqual(a, p), false);

    const extra = liveDetector();
    (extra.eventTemplate as { properties: EventProp[] }).properties.push({ key: 'added', value: 'x' });
    assert.equal(publishedPartsEqual(a, extra), false);
  });

  it('finds the query under either key', () => {
    const a = liveDetector();
    const b = liveDetector();
    (b.analyzer as { input: Inputs }).input[0]!.key = 'query';
    assert.equal(publishedPartsEqual(a, b), true);
  });

  it('treats absent and empty event properties as the same', () => {
    const a = liveDetector();
    const b = liveDetector();
    (a.eventTemplate as { properties: EventProp[] }).properties = [];
    delete b.eventTemplate;
    assert.equal(publishedPartsEqual(a, b), true);
  });
});

describe('findApprovedTile', () => {
  const markdown = (id: string) => ({ type: 'markdown', markdown: `card for ${id}` });
  const dql = (value: string) => ({ type: 'dql', state: { input: { value } } });
  const tile = (id: string, query = 'timeseries x = avg(cloud.aws.lambda.Errors.By.FunctionName)') =>
    dql(buildReviewQuery(id, query, 'timeseries x = avg(cloud.aws.lambda.errors_sum)'));

  it('returns the value of the query tile that carries the alert marker', () => {
    const mine = tile('vu9U3hXa3q0AAAAB', 'timeseries mine = avg(cloud.aws.lambda.Errors.By.FunctionName)');
    const sections = [markdown('other'), tile('other-id'), markdown('vu9U3hXa3q0AAAAB'), mine];
    assert.deepEqual(findApprovedTile(sections, 'vu9U3hXa3q0AAAAB'), { value: mine.state.input.value });
  });

  it('does not take a tile for an id that only starts with this one', () => {
    assert.deepEqual(findApprovedTile([tile('A-10')], 'A-1'), { error: 'query tile not found' });
  });

  it('reports a missing tile', () => {
    assert.deepEqual(findApprovedTile([markdown('A-1'), dql('timeseries x = avg(y)'), { type: 'dql' }], 'A-1'), {
      error: 'query tile not found',
    });
  });

  it('refuses to choose between two tiles for the same alert', () => {
    const sections = [tile('A-1', 'timeseries a = avg(one)'), tile('B-1'), tile('A-1', 'timeseries a = avg(two)')];
    assert.deepEqual(findApprovedTile(sections, 'A-1'), { error: 'two query tiles for this alert' });
  });

  it('ignores the marker text outside a query tile', () => {
    const quoted = { type: 'markdown', state: { input: { value: buildReviewQuery('A-1', 'q', 'o') } } };
    const real = tile('A-1');
    assert.deepEqual(findApprovedTile([quoted, real], 'A-1'), { value: real.state.input.value });
  });

  it('refuses a tile holding two alerts’ cards, for every alert it names: one tile pasted into another, the other deleted', () => {
    // Read as one alert's tile, the first marker would hand the other alert this alert's query.
    const merged = dql(
      buildReviewQuery('A-1', 'timeseries a = avg(cloud.aws.lambda.Errors.By.FunctionName)', 'classic a') +
        buildReviewQuery('B-1', 'timeseries b = avg(cloud.aws.lambda.Throttles.By.FunctionName)', 'classic b'),
    );
    for (const id of ['A-1', 'B-1']) {
      assert.deepEqual(findApprovedTile([markdown(id), merged], id), { error: 'tile carries markers for several alerts' }, id);
    }
  });

  it('refuses a merged tile even when the alert also has a tile of its own', () => {
    const merged = dql(buildReviewQuery('A-1', 'timeseries a = avg(one)', 'o') + buildReviewQuery('B-1', 'timeseries b = avg(two)', 'o'));
    assert.deepEqual(findApprovedTile([tile('A-1'), merged], 'A-1'), { error: 'tile carries markers for several alerts' });
  });

  it('takes a tile whose markers all name this alert', () => {
    const value = buildReviewQuery('A-1', 'timeseries a = avg(one)', 'o');
    const twice = dql(`${value}\n// [CCT-DETECTOR objectId=A-1]\n`);
    assert.deepEqual(findApprovedTile([twice], 'A-1'), { value: twice.state.input.value });
  });
});

describe('isAuthFailure', () => {
  const err = (status: number) => new SettingsApiError(status, 'https://example/settings/objects/x', 'denied');

  it('is true for a Settings API 401 or 403', () => {
    assert.equal(isAuthFailure(err(401)), true);
    assert.equal(isAuthFailure(err(403)), true);
  });

  it('is false for any other Settings API status, a plain error, or no error', () => {
    assert.equal(isAuthFailure(err(400)), false);
    assert.equal(isAuthFailure(err(404)), false);
    assert.equal(isAuthFailure(new Error('HTTP 403')), false);
    assert.equal(isAuthFailure(undefined), false);
  });

  it('is true for a DQL or Document API 401 or 403: every API a publish calls', () => {
    assert.equal(isAuthFailure(new DqlError(401, 'https://example/query:execute', 'denied')), true);
    assert.equal(isAuthFailure(new DqlError(403, 'https://example/query:execute', 'denied')), true);
    assert.equal(isAuthFailure(new DocumentApiError(401, 'https://example/documents/x', 'denied')), true);
    assert.equal(isAuthFailure(new DocumentApiError(403, 'https://example/documents/x', 'denied')), true);
  });

  it('is false for a DQL or Document API error that is not about the token', () => {
    assert.equal(isAuthFailure(new DqlError(400, 'https://example/query:execute', 'syntax')), false);
    assert.equal(isAuthFailure(new DocumentApiError(404, 'https://example/documents/x', 'gone')), false);
  });
});

describe('parseIds', () => {
  it('reads a comma-separated list, trimmed, without repeats', () => {
    assert.deepEqual(parseIds('a, b,,c ,a'), ['a', 'b', 'c']);
  });

  it('is undefined when the flag is absent', () => {
    assert.equal(parseIds(undefined), undefined);
  });

  it('throws when the flag has no value: with --apply that would publish the whole batch', () => {
    assert.throws(() => parseIds(true), (e: Error) => e.message === '--ids needs a value: a comma-separated list of alert ids');
  });

  it('throws when the value names no id', () => {
    for (const raw of ['', ' , ,']) {
      assert.throws(() => parseIds(raw), (e: Error) => e.message === `--ids "${raw}" names no alert id`, raw);
    }
  });
});

describe('whyNotSelected', () => {
  const batches: ManifestBatch[] = [
    { batch: 'batch-01', notebookId: 'nb-1', detectors: [{ objectId: 'A', title: 'a' }, { objectId: 'MOVED', title: 'm' }] },
    { batch: 'batch-02', notebookId: 'nb-2', detectors: [{ objectId: 'OTHER', title: 'o' }, { objectId: 'MOVED', title: 'm' }] },
    { batch: 'batch-03', detectors: [{ objectId: 'UNPUBLISHED', title: 'u' }] },
  ];
  const rows = new Map<string, Record<string, string>>([
    ['A', { decision: 'Needs Review', status: 'staged' }],
    ['OTHER', { decision: 'Ready To Publish', status: 'staged' }],
    ['MOVED', { decision: 'Ready To Publish', status: 'staged' }],
  ]);
  const why = (ids: string[], extraRows: Array<[string, Record<string, string>]> = []) =>
    Object.fromEntries(whyNotSelected(ids, new Map([...rows, ...extraRows]), batches, { batches: ['batch-01'] }).map((x) => [x.id, x.reason]));

  it('names the rule each id fails', () => {
    const r = why(['NOPE', 'UNPUBLISHED', 'OTHER', 'MOVED', 'A']);
    assert.match(r['NOPE']!, /in no published review batch/);
    assert.match(r['UNPUBLISHED']!, /in no published review batch/);
    assert.match(r['OTHER']!, /batch-02, not in batch-01/);
    assert.match(r['MOVED']!, /batch-02, not in batch-01/, 'its newest card decides');
    assert.match(r['A']!, /decision is "Needs Review", not Ready To Publish/);
  });

  it('says when an alert is already published, or missing from the sheet', () => {
    const extra: ManifestBatch[] = [{ batch: 'batch-01', notebookId: 'nb-1', detectors: [{ objectId: 'P', title: 'p' }, { objectId: 'NOROW', title: 'n' }] }];
    const r = Object.fromEntries(
      whyNotSelected(['P', 'NOROW'], new Map([['P', { decision: 'Published', status: 'promoted' }]]), extra, { batches: ['batch-01'] }).map((x) => [x.id, x.reason]),
    );
    assert.match(r['P']!, /already published \(status promoted\)/);
    assert.match(r['NOROW']!, /not on the alerts sheet/);
  });

  it('calls an empty decision empty', () => {
    assert.match(why(['A'], [['A', { decision: '', status: 'staged' }]])['A']!, /decision is empty/);
  });
});

describe('detectorValuesEqual', () => {
  const v = { enabled: true, analyzer: { input: [{ key: 'query', value: 'q' }, { key: 'threshold', value: '1' }] } };

  it('ignores key order', () => {
    assert.equal(detectorValuesEqual(v, { analyzer: { input: [{ value: 'q', key: 'query' }, { key: 'threshold', value: '1' }] }, enabled: true }), true);
  });

  it('counts any other difference, not only the parts a publish writes', () => {
    assert.equal(detectorValuesEqual(v, { ...v, enabled: false }), false);
    assert.equal(detectorValuesEqual(v, { enabled: true, analyzer: { input: [{ key: 'query', value: 'q' }, { key: 'threshold', value: '2' }] } }), false);
  });
});

describe('stagedQueriesOf', () => {
  const card = (id: string, classic: string) => ({
    id: `dql-${id}`,
    type: 'dql',
    state: { input: { value: buildReviewQuery(id, 'timeseries x = avg(new)', classic) } },
  });
  const tile = buildReviewQuery('A-1', 'timeseries x = avg(new)', 'timeseries x = avg(from_tile)');

  it('lists every source that holds the card, base payload, archive, then tile', () => {
    const r = stagedQueriesOf('A-1', { base: [card('A-1', 'timeseries x = avg(from_base)')], archive: [card('A-1', 'timeseries x = avg(from_archive)')], tileValue: tile });
    assert.deepEqual(r, [
      { from: 'base', query: 'timeseries x = avg(from_base)' },
      { from: 'archive', query: 'timeseries x = avg(from_archive)' },
      { from: 'tile', query: 'timeseries x = avg(from_tile)' },
    ]);
  });

  it('leaves out a payload that has no card for the alert', () => {
    const r = stagedQueriesOf('A-1', { base: [card('B-1', 'other')], archive: [card('A-1', 'timeseries x = avg(from_archive)')], tileValue: tile });
    assert.deepEqual(r.map((c) => c.from), ['archive', 'tile']);
  });

  it('has only the tile when there are no payloads', () => {
    assert.deepEqual(stagedQueriesOf('A-1', { tileValue: tile }), [{ from: 'tile', query: 'timeseries x = avg(from_tile)' }]);
  });

  it('leaves out a card whose reference block is gone', () => {
    const noBlock = { id: 'dql-A-1', type: 'dql', state: { input: { value: '// [CCT-DETECTOR objectId=A-1]\ntimeseries x = avg(new)' } } };
    assert.deepEqual(stagedQueriesOf('A-1', { base: [noBlock], tileValue: tile }).map((c) => c.from), ['tile']);
  });

  it('is empty when no source has the classic query', () => {
    assert.deepEqual(stagedQueriesOf('A-1', { base: [], archive: [], tileValue: '// [CCT-DETECTOR objectId=A-1]\nq' }), []);
  });
});

describe('parseLimit', () => {
  it('reads a positive integer', () => {
    assert.equal(parseLimit('25'), 25);
    assert.equal(parseLimit(' 3 '), 3);
  });

  it('is undefined when the flag is absent', () => {
    assert.equal(parseLimit(undefined), undefined);
  });

  it('throws naming the value given for anything else', () => {
    for (const raw of ['x', '0', '-2', '2.5', '1e3', '']) {
      assert.throws(() => parseLimit(raw), (e: Error) => e.message === `--limit "${raw}" must be a positive integer`, raw);
    }
  });

  it('throws when the flag has no value', () => {
    assert.throws(() => parseLimit(true), (e: Error) => e.message === '--limit needs a value: a positive integer');
  });
});

describe('parseBatches', () => {
  it('reads a comma-separated list, trimmed, without repeats', () => {
    assert.deepEqual(parseBatches('batch-03, batch-04,,batch-03'), ['batch-03', 'batch-04']);
  });

  it('is undefined when the flag is absent', () => {
    assert.equal(parseBatches(undefined), undefined);
  });

  it('throws when the flag has no value: read as "no filter" it would widen the run', () => {
    assert.throws(() => parseBatches(true), (e: Error) => e.message === '--batches needs a value: a comma-separated list of review batches, e.g. batch-03,batch-04');
  });

  it('throws when the value names no batch', () => {
    for (const raw of ['', ' , ']) {
      assert.throws(() => parseBatches(raw), (e: Error) => e.message === `--batches "${raw}" names no review batch`, raw);
    }
  });
});

/** A detector as a publish leaves it: a different query and event fields than `liveDetector`. */
function publishedDetector(): Record<string, unknown> {
  const v = liveDetector();
  (v.analyzer as { input: Inputs }).input[0]!.value = 'timeseries x=avg(new)';
  (v.eventTemplate as { properties: EventProp[] }).properties = [
    { key: 'event.name', value: 'new name' },
    { key: 'dt.smartscape_source.id', value: '{dt.smartscape.aws_sqs_queue}' },
  ];
  return v;
}

describe('rollbackDecision', () => {
  it('restores an alert that still has what was published', () => {
    assert.equal(rollbackDecision(publishedDetector(), publishedDetector(), false), 'restore');
  });

  it('ignores key order and every field a publish does not write', () => {
    const live = publishedDetector();
    (live.analyzer as { input: Inputs }).input[1]!.value = '50'; // threshold changed by the owner
    live.enabled = true;
    const reordered = Object.fromEntries(Object.entries(live).reverse());
    assert.equal(rollbackDecision(reordered, publishedDetector(), false), 'restore');
  });

  it('refuses an alert whose query or event fields were edited after publishing', () => {
    const q = publishedDetector();
    (q.analyzer as { input: Inputs }).input[0]!.value = 'timeseries x=avg(edited)';
    assert.equal(rollbackDecision(q, publishedDetector(), false), 'refuse-edited');

    const p = publishedDetector();
    (p.eventTemplate as { properties: EventProp[] }).properties[0]!.value = 'edited name';
    assert.equal(rollbackDecision(p, publishedDetector(), false), 'refuse-edited');
  });

  it('restores an edited alert with force', () => {
    const q = publishedDetector();
    (q.analyzer as { input: Inputs }).input[0]!.value = 'timeseries x=avg(edited)';
    assert.equal(rollbackDecision(q, publishedDetector(), true), 'restore');
  });
});

describe('diffOutsidePublishedParts', () => {
  const sent = (): Record<string, unknown> => ({
    enabled: true,
    title: 't',
    analyzer: {
      name: 'a',
      input: [
        { key: 'query', value: 'timeseries x = avg(m)' },
        { key: 'threshold', value: '5' },
      ],
    },
    eventTemplate: { properties: [{ key: 'event.name', value: 'n' }] },
  });

  it('is empty for the same value, whatever the key order', () => {
    const v = sent();
    assert.deepEqual(diffOutsidePublishedParts(v, Object.fromEntries(Object.entries(sent()).reverse())), []);
  });

  it('leaves out the query input and the event properties: their check is separate', () => {
    const stored = sent();
    (stored.analyzer as { input: Inputs }).input[0]!.value = 'timeseries changed = avg(m)';
    (stored.eventTemplate as { properties: EventProp[] }).properties = [];
    assert.deepEqual(diffOutsidePublishedParts(sent(), stored), []);
  });

  it('names every other path that differs: changed, added or dropped, inputs by their key', () => {
    const stored = sent();
    stored.enabled = false;
    delete stored.title;
    (stored.analyzer as { input: Inputs }).input.reverse(); // order alone is no difference
    (stored.analyzer as { input: Inputs }).input.push({ key: 'alertCondition', value: 'ABOVE' });
    (stored.analyzer as { input: Inputs }).input.find((i) => i.key === 'threshold')!.value = '6';
    (stored.eventTemplate as Record<string, unknown>).extra = { a: 1 };
    assert.deepEqual(diffOutsidePublishedParts(sent(), stored), [
      'analyzer.input[alertCondition]',
      'analyzer.input[threshold].value',
      'enabled',
      'eventTemplate.extra',
      'title',
    ]);
  });

  it('compares other arrays by position', () => {
    const a = { ...sent(), tags: ['x', 'y'] };
    const b = { ...sent(), tags: ['x', 'z', 'w'] };
    assert.deepEqual(diffOutsidePublishedParts(a, b), ['tags[1]', 'tags[2]']);
  });

  it('does not modify either value', () => {
    const a = sent();
    const b = sent();
    b.enabled = false;
    diffOutsidePublishedParts(a, b);
    assert.deepEqual(a, sent());
    assert.equal(b.enabled, false);
    assert.equal(((b.analyzer as { input: Inputs }).input[0]!).value, 'timeseries x = avg(m)');
  });
});

describe('publishedPartsDiff', () => {
  it('is empty when the parts a publish writes agree', () => {
    const other = publishedDetector();
    other.enabled = true;
    assert.deepEqual(publishedPartsDiff(publishedDetector(), other), []);
  });

  it('names the query, the event fields, or both', () => {
    const q = publishedDetector();
    (q.analyzer as { input: Inputs }).input[0]!.value = 'timeseries x=avg(edited)';
    assert.deepEqual(publishedPartsDiff(q, publishedDetector()), ['query']);

    const p = publishedDetector();
    (p.eventTemplate as { properties: EventProp[] }).properties.pop();
    assert.deepEqual(publishedPartsDiff(p, publishedDetector()), ['event fields']);

    assert.deepEqual(publishedPartsDiff(liveDetector(), publishedDetector()), ['query', 'event fields']);
  });
});

describe('restoreValue', () => {
  /** The published alert after its owner changed the threshold, enabled it and its actor changed. */
  function editedLive(): Record<string, unknown> {
    const v = publishedDetector();
    (v.analyzer as { input: Inputs }).input[1]!.value = '50';
    v.enabled = true;
    v.executionSettings = { actor: 'actor-2' };
    return v;
  }

  it('takes the query and the event properties from the snapshot', () => {
    const out = restoreValue(editedLive(), liveDetector());
    assert.equal(publishedPartsEqual(out, liveDetector()), true);
    assert.equal((out.analyzer as { input: Inputs }).input[0]!.value, 'timeseries x=avg(old)');
    assert.deepEqual((out.eventTemplate as { properties: EventProp[] }).properties, [{ key: 'event.name', value: 'old name' }]);
  });

  it('keeps everything else as it is live: threshold, enabled, actor, other inputs and template fields', () => {
    const live = editedLive();
    const out = restoreValue(live, liveDetector());
    const back = structuredClone(out);
    (back.analyzer as { input: Inputs }).input[0]!.value = 'timeseries x=avg(new)';
    (back.eventTemplate as { properties: EventProp[] }).properties = (publishedDetector().eventTemplate as { properties: EventProp[] }).properties;
    assert.deepEqual(back, editedLive(), 'only the two parts differ from live');
    assert.equal(out.enabled, true);
    assert.deepEqual(out.executionSettings, { actor: 'actor-2' });
    assert.equal((out.analyzer as { input: Inputs }).input[1]!.value, '50');
    assert.equal((out.eventTemplate as { other?: string }).other, 'kept');
  });

  it('writes the query under the key the live alert uses', () => {
    const live = editedLive();
    (live.analyzer as { input: Inputs }).input[0]!.key = 'query';
    const out = restoreValue(live, liveDetector());
    const input = (out.analyzer as { input: Inputs }).input;
    assert.deepEqual(input.map((i) => i.key), ['query', 'threshold', 'alertCondition']);
    assert.equal(input[0]!.value, 'timeseries x=avg(old)');
  });

  it('mutates neither argument, and shares no object with the snapshot', () => {
    const live = editedLive();
    const snap = liveDetector();
    const out = restoreValue(live, snap);
    assert.deepEqual(live, editedLive());
    assert.deepEqual(snap, liveDetector());
    (out.eventTemplate as { properties: EventProp[] }).properties[0]!.value = 'changed after';
    assert.equal((snap.eventTemplate as { properties: EventProp[] }).properties[0]!.value, 'old name');
  });

  it('removes the event properties when the snapshot had none', () => {
    const snap = liveDetector();
    delete (snap.eventTemplate as { properties?: EventProp[] }).properties;
    const out = restoreValue(editedLive(), snap);
    assert.deepEqual(out.eventTemplate, { other: 'kept' });
    assert.equal(publishedPartsEqual(out, snap), true);
  });

  it('refuses a live alert or a snapshot with no query input rather than restore half', () => {
    const noQuery = (v: Record<string, unknown>) => {
      (v.analyzer as { input: unknown[] }).input = [{ key: 'threshold', value: '5' }];
      return v;
    };
    assert.throws(() => restoreValue(noQuery(editedLive()), liveDetector()), /live alert has no query input/);
    assert.throws(() => restoreValue(editedLive(), noQuery(liveDetector())), /snapshot has no query input/);
  });
});

describe('selectPublished', () => {
  const manifest: ManifestBatch[] = [
    { batch: 'batch-01', notebookId: 'nb-1', detectors: [{ objectId: 'A', title: 'a' }, { objectId: 'MOVED', title: 'moved' }, { objectId: 'S', title: 's' }] },
    { batch: 'batch-02', notebookId: 'nb-2', detectors: [{ objectId: 'B', title: 'b' }, { objectId: 'MOVED', title: 'moved' }, { objectId: 'V', title: 'v' }] },
    { batch: 'batch-03', detectors: [{ objectId: 'U', title: 'u' }] },
  ];
  const rows = new Map<string, Record<string, string>>([
    ['A', { name: 'Alert A', status: 'promoted', decision: 'Published' }],
    ['MOVED', { name: 'Alert moved', status: 'Promoted ', decision: 'Published' }],
    ['S', { name: 'Alert S', status: 'staged', decision: 'Ready To Publish' }],
    ['B', { name: 'Alert B', status: 'promoted', decision: 'Published' }],
    ['V', { name: 'Alert V', status: 'verified', decision: 'Published' }],
    ['HAND', { name: 'Hand-applied', status: 'promoted', decision: 'Published' }],
  ]);
  const ids = (r: ReturnType<typeof selectPublished>) => r.targets.map((t) => t.objectId);

  it('takes every row with one of the statuses, in sheet order, when no filter is given', () => {
    const r = selectPublished(rows, manifest, { statuses: ['promoted'] });
    assert.deepEqual(ids(r), ['A', 'MOVED', 'B', 'HAND']);
    assert.deepEqual(r.targets[0], { objectId: 'A', title: 'Alert A', batch: 'batch-01', status: 'promoted' });
    assert.equal(r.targets[3]!.batch, undefined, 'an alert in no batch still counts');
  });

  it('takes several statuses', () => {
    assert.deepEqual(ids(selectPublished(rows, manifest, { statuses: ['promoted', 'verified'] })), ['A', 'MOVED', 'B', 'V', 'HAND']);
  });

  it('reads batch membership from the manifest: an alert belongs to the last published batch that lists it', () => {
    assert.deepEqual(ids(selectPublished(rows, manifest, { statuses: ['promoted'], batches: ['batch-01'] })), ['A']);
    assert.deepEqual(ids(selectPublished(rows, manifest, { statuses: ['promoted'], batches: ['batch-02'] })), ['MOVED', 'B'], 'in sheet order');
  });

  it('narrows by ids, and intersects ids with batches', () => {
    assert.deepEqual(ids(selectPublished(rows, manifest, { statuses: ['promoted'], ids: ['HAND', 'B'] })), ['B', 'HAND']);
    assert.deepEqual(ids(selectPublished(rows, manifest, { statuses: ['promoted'], batches: ['batch-02'], ids: ['B'] })), ['B']);
  });

  it('reports batches the manifest does not have as published', () => {
    assert.deepEqual(selectPublished(rows, manifest, { statuses: ['promoted'], batches: ['batch-03', 'batch-09', 'batch-01'] }).unknownBatches, ['batch-03', 'batch-09']);
  });

  it('says why each named id was left out', () => {
    const r = selectPublished(rows, manifest, { statuses: ['promoted'], batches: ['batch-01'], ids: ['A', 'NOPE', 'S', 'B', 'V'] });
    assert.deepEqual(ids(r), ['A']);
    assert.deepEqual(Object.fromEntries(r.notSelected.map((n) => [n.id, n.reason])), {
      NOPE: 'not on the alerts sheet',
      S: 'status is "staged", not promoted',
      B: 'its review card is in batch-02, not in batch-01',
      V: 'status is "verified", not promoted',
    });
  });

  it('falls back to the manifest title, then the id, for a row with no name', () => {
    const r = selectPublished(new Map([['A', { status: 'promoted' }], ['X', { status: 'promoted' }]]), manifest, { statuses: ['promoted'] });
    assert.deepEqual(r.targets.map((t) => t.title), ['a', 'X']);
  });
});
