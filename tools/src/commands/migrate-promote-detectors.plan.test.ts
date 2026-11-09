import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planOne, type EarlierRecords, type PlanCtx } from './migrate-promote-detectors.ts';
import { buildReviewQuery } from '../lib/detector-notebook.ts';
import { staticColumns, type PublishCandidate } from '../lib/detector-publish.ts';
import { DqlError } from '../dynatrace/dql.ts';
import { SettingsApiError } from '../dynatrace/settings.ts';
import { fakeSettings, type Stored } from './__testing__/fake-settings.ts';

// The planning half of migrate-promote-detectors: every gate that decides
// whether a live alert is overwritten, driven through an injected context (a
// fake Settings API, a scripted DQL runner, an in-memory notebook), so the gate
// order is pinned without a tenant.

const ID = 'A-1';
const CLASSIC = 'timeseries v = avg(cloud.aws.sqs.messages_visible), by:{dt.entity.custom_device}';
const APPROVED = 'timeseries v = avg(cloud.aws.sqs.ApproximateNumberOfMessagesVisible.By.QueueName), by:{dt.smartscape.aws_sqs_queue}';
const NAME_COLUMN = '| fieldsAdd dt.smartscape.aws_sqs_queue.name = getNodeName(dt.smartscape.aws_sqs_queue)';
/** The approved query with the node-name column the classic event text needs. */
const PUBLISHED = `${APPROVED}\n${NAME_COLUMN}`;
const TWO_HOURS = 2 * 36e5;
const SEVEN_DAYS = 7 * 864e5;

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
    analyzer: { name: 'StaticThreshold', input: [{ key: 'query', value: query }, { key: 'threshold', value: threshold }] },
    eventTemplate: { properties: props },
  };
}

const tileOf = (id: string, query: string, classic = CLASSIC) => ({ type: 'dql', state: { input: { value: buildReviewQuery(id, query, classic) } } });

/** One row per call: a record holding every column the query text names. */
const textRows = (q: string): Record<string, unknown>[] => [Object.fromEntries([...staticColumns(q)].map((c) => [c, 'x']))];

interface Fixture {
  /** The approved query in the alert's tile. Default APPROVED. */
  tileQuery?: string;
  /** The notebook's sections, instead of one tile for the alert. */
  sections?: unknown[];
  /** The live alert. Default the classic one. */
  live?: Record<string, unknown>;
  /** What a DQL run returns, or throws. Default `textRows`. */
  rows?: (q: string, windowMs: number) => Record<string, unknown>[] | Error;
  records?: EarlierRecords;
  rolledBack?: { rolledBackAt?: string };
  candidate?: Partial<PublishCandidate>;
  args?: PlanCtx['args'];
  /** Fail the server's validateOnly write. */
  validateError?: unknown;
}

async function plan(f: Fixture = {}) {
  const candidate: PublishCandidate = { objectId: ID, title: 'Queue backlog', batch: 'batch-03', notebookId: 'nb-3', reviewer: 'reviewer-a', status: 'staged', ...f.candidate };
  const store = new Map<string, Stored>([[candidate.objectId, { value: f.live ?? detector(CLASSIC, CLASSIC_PROPS), updateToken: 'tok-0', schemaVersion: '1.2.3' }]]);
  const settings = fakeSettings(store, { putError: () => f.validateError });
  const ran: Array<{ query: string; windowMs: number }> = [];
  const ctx: PlanCtx = {
    args: f.args ?? {},
    index: { byClassicId: new Map(), byDqlClassicKey: new Map() },
    settings,
    run: async (query, windowMs) => {
      ran.push({ query, windowMs });
      const r = (f.rows ?? textRows)(query, windowMs);
      if (r instanceof Error) throw r;
      return { records: r };
    },
    sections: async () => (f.sections ?? [tileOf(ID, f.tileQuery ?? APPROVED)]) as never,
    payload: async () => ({}),
    records: async () => f.records ?? { problems: [] },
    rolledBack: async () => f.rolledBack,
  };
  const outcome = await planOne(candidate, ctx);
  return { outcome, item: outcome.item, ran, settings, store };
}

describe('planOne: a rollback newer than the sheet row', () => {
  it('skips an alert rolled back since its row was saved: a stale save shows it Ready again', async () => {
    const { item, outcome, ran, settings } = await plan({ rolledBack: { rolledBackAt: '2026-11-07T10:00:00.000Z' }, candidate: { status: 'staged' } });

    assert.equal(item.result, 'skipped');
    assert.equal(outcome.gate, 'rolled back since the sheet row was saved');
    assert.match(item.reasons[0]!, /^rolled back on 2026-11-07T10:00:00\.000Z; the sheet row looks older than that — re-approve it after the rollback/);
    assert.deepEqual(ran, [], 'no query runs');
    assert.equal(settings.calls.some((c) => c.op === 'put'), false);
  });

  it('plans an alert re-approved after the rollback: its row keeps the status rolled-back', async () => {
    const { item } = await plan({ rolledBack: { rolledBackAt: '2026-11-07T10:00:00.000Z' }, candidate: { status: 'rolled-back' } });
    assert.equal(item.result, 'ready', item.reasons.join(' | '));
  });

  it('says so when the rollback record has no date', async () => {
    const { item } = await plan({ rolledBack: {} });
    assert.match(item.reasons[0]!, /^rolled back on an unknown date;/);
  });
});

describe('planOne: drift against what an earlier apply wrote', () => {
  // Live runs the published query (approved + name column) with event fields
  // that differ from any record, so only the drift check reads the records.
  const live = detector(PUBLISHED, CLASSIC_PROPS);

  it('reads a live query that is no staged copy and no record as the owner’s', async () => {
    const { item, outcome } = await plan({ live });
    assert.equal(item.result, 'skipped');
    assert.match(outcome.gate, /^drift: /);
  });

  it('reads the query of a pending record (a write that may have landed) as already published, not owner drift', async () => {
    const pending = { objectId: ID, pendingAt: '2026-11-07T10:00:00.000Z', value: detector(PUBLISHED, NEW_PROPS) };
    const { item } = await plan({ live, records: { pending, problems: [] } });
    assert.equal(item.result, 'ready', item.reasons.join(' | '));
    assert.match(item.reasons[0]!, /^event-field-only update/);
  });

  it('reads the query the server stored, not the one sent, from a published record', async () => {
    const published = { objectId: ID, publishedAt: '2026-11-07T10:00:00.000Z', value: detector('timeseries sent = avg(x)', NEW_PROPS), storedValue: detector(PUBLISHED, NEW_PROPS) };
    const { item } = await plan({ live, records: { published, problems: [] } });
    assert.equal(item.result, 'ready', item.reasons.join(' | '));
  });

  it('notes a record file that could not be read', async () => {
    const { item } = await plan({ records: { problems: ['the record x could not be read (bad json), so it was left out.'] } });
    assert.ok(item.reasons.includes('the record x could not be read (bad json), so it was left out.'), item.reasons.join(' | '));
  });
});


describe('planOne: an alert already published (I1)', () => {
  const published = { objectId: ID, publishedAt: '2026-11-07T10:00:00.000Z', approvedQuery: APPROVED, value: detector(PUBLISHED, NEW_PROPS), storedValue: detector(PUBLISHED, NEW_PROPS) };
  const live = detector(PUBLISHED, NEW_PROPS, '250'); // the owner changed the threshold since: not a published part

  it('records it at once when the live alert still has its published record’s query and event fields: no gate runs', async () => {
    // Today's tile would fail lint; the publish is already out, so nothing is rebuilt from it.
    const tileQuery = 'timeseries v=avg(`cloud.aws.emr_ec2.HDFSUtilization.By.JobFlowId`), by:{dt.smartscape.aws_emr_cluster}';
    const { item, outcome, ran, settings } = await plan({ live, tileQuery, records: { published, problems: [] } });

    assert.equal(item.result, 'recorded');
    assert.equal(outcome.gate, 'already published, recorded only');
    assert.equal(outcome.recordedFrom, 'published');
    assert.match(item.reasons[0]!, /^already published \(2026-11-07T10:00:00\.000Z\): /);
    assert.deepEqual(ran, [], 'no query runs');
    assert.deepEqual(settings.calls.map((c) => c.op), ['get'], 'one read, no validation write');
    assert.equal(outcome.payload, undefined, 'no payload is rebuilt');
  });

  it('says so when the review tile changed since the publish', async () => {
    const { item } = await plan({ live, tileQuery: `${APPROVED}\n| filter v > 10`, records: { published, problems: [] } });
    assert.equal(item.result, 'recorded');
    assert.ok(item.reasons.includes('the review tile has changed since this alert was published; re-stage it if the change should go out'), item.reasons.join(' | '));
  });

  it('adds no such note while the tile still holds the query it was published from', async () => {
    const { item } = await plan({ live, records: { published, problems: [] } });
    assert.equal(item.reasons.length, 1, item.reasons.join(' | '));
  });

  it('still records it when the tile is gone, and says the tile could not be checked', async () => {
    const { item } = await plan({ live, sections: [], records: { published, problems: [] } });
    assert.equal(item.result, 'recorded');
    assert.ok(item.reasons.some((r) => /review tile could not be checked \(query tile not found\)/.test(r)), item.reasons.join(' | '));
  });

  it('records an alert whose live value is its pending record: a write that landed', async () => {
    const pending = { objectId: ID, pendingAt: '2026-11-07T09:00:00.000Z', approvedQuery: APPROVED, value: detector(PUBLISHED, NEW_PROPS) };
    const { item, outcome } = await plan({ live, records: { pending, problems: [] } });
    assert.equal(item.result, 'recorded');
    assert.equal(outcome.recordedFrom, 'pending');
    assert.deepEqual(outcome.liveValue, live, 'kept for the published record the apply makes of it');
  });

  it('compares with what the server stored, not what was sent', async () => {
    const storedOnly = { ...published, value: detector('timeseries sent = avg(x)', NEW_PROPS) };
    assert.equal((await plan({ live, records: { published: storedOnly, problems: [] } })).item.result, 'recorded');
  });

  it('goes through every gate when the live alert no longer has the published parts', async () => {
    const { item, ran } = await plan({ live: detector(PUBLISHED, [{ key: 'event.name', value: 'owner text' }]), records: { published, problems: [] } });
    assert.notEqual(item.result, 'recorded');
    assert.ok(ran.length > 0);
  });

  it('keeps today’s behaviour for an alert applied by hand: no record, live equals the approved query; recorded only when nothing would change', async () => {
    const handProps: Prop[] = [
      { key: 'event.name', value: 'Backlog on {dims:dt.smartscape.aws_sqs_queue}' },
      { key: 'dt.smartscape_source.id', value: '{dt.smartscape.aws_sqs_queue}' },
    ];
    const same = await plan({ live: detector(APPROVED, handProps) });
    assert.equal(same.item.result, 'recorded');
    assert.equal(same.outcome.recordedFrom, undefined);
    assert.ok(same.ran.length > 0, 'the gates ran: there is no record to trust');

    const fieldsOnly = await plan({ live: detector(APPROVED, [{ key: 'event.name', value: 'Backlog on {dims:dt.entity.custom_device}' }]) });
    assert.equal(fieldsOnly.item.result, 'ready');
    assert.match(fieldsOnly.item.reasons[0]!, /^event-field-only update/);
  });
});

describe('planOne: the entity column must survive to the output (I2)', () => {
  it('skips a query whose run shows no entity column: a later fields drops it', async () => {
    const tileQuery = `${APPROVED}\n| fields timeframe, v`;
    const { item, outcome } = await plan({ tileQuery, rows: () => [{ timeframe: 1, v: 2 }] });

    assert.equal(item.result, 'skipped');
    assert.equal(outcome.gate, 'the output drops its entity column');
    assert.equal(item.reasons[0], "the query's output drops its entity column (dt.smartscape.aws_sqs_queue); keep it in the final fields");
  });

  it('does not hold a query with no data to it: its columns come from the text', async () => {
    const { item } = await plan({ rows: () => [] });
    assert.equal(item.result, 'ready', item.reasons.join(' | '));
    assert.ok(item.reasons.some((r) => /columns the query text names/.test(r)));
  });

  it('passes a run that has the entity column', async () => {
    const { item } = await plan({ rows: () => [{ timeframe: 1, v: 2, 'dt.smartscape.aws_sqs_queue': 'SQS-1', 'dt.smartscape.aws_sqs_queue.name': 'q' }] });
    assert.equal(item.result, 'ready', item.reasons.join(' | '));
  });
});

const dqlError = (msg: string) => new DqlError(400, 'https://example/query', JSON.stringify({ error: { message: msg } }));
const runsOf = (ran: Array<{ query: string; windowMs: number }>) => ran.map((r) => [r.query, r.windowMs === TWO_HOURS ? '2h' : r.windowMs === SEVEN_DAYS ? '7d' : String(r.windowMs)]);

describe('planOne: the gates, in order (I5)', () => {
  it('runs every gate for a clean alert: the approved query over 2 hours, its columns over 7 days, the final query, then server validation', async () => {
    const { item, outcome, ran, settings } = await plan();

    assert.equal(item.result, 'ready', item.reasons.join(' | '));
    assert.deepEqual(runsOf(ran), [
      [APPROVED, '2h'],
      [APPROVED, '7d'],
      [PUBLISHED, '2h'],
    ]);
    assert.equal(item.entityColumn, 'dt.smartscape.aws_sqs_queue');
    assert.deepEqual(item.stagedFrom, ['tile']);
    const validate = settings.calls.filter((c) => c.op === 'put');
    assert.equal(validate.length, 1);
    assert.equal(validate[0]!.validateOnly, true, 'planning never writes');
    assert.equal(validate[0]!.body!.updateToken, 'tok-0');
    assert.deepEqual(outcome.payload!.value, detector(PUBLISHED, NEW_PROPS));
    assert.equal(outcome.payload!.approvedQuery, APPROVED);
    assert.equal(outcome.payload!.liveQuery, CLASSIC);
  });

  it('checks for an empty tile before drift: an empty query never reads as already published against an empty live query', async () => {
    const { item, outcome, ran } = await plan({ tileQuery: '   ', live: detector('', CLASSIC_PROPS) });
    assert.equal(outcome.gate, 'empty query');
    assert.equal(item.result, 'skipped');
    assert.deepEqual(ran, []);

    const commented = await plan({ tileQuery: `// ${APPROVED}`, live: detector(`${CLASSIC}\n| filter v > 1`, CLASSIC_PROPS) });
    assert.equal(commented.outcome.gate, 'empty query', 'empty is reported before the drift');
  });

  it('skips an owner edit before running anything, naming the copies it compared with', async () => {
    const { item, outcome, ran, settings } = await plan({ live: detector(`${CLASSIC}\n| filter v > 1`, CLASSIC_PROPS) });
    assert.equal(outcome.gate, 'drift: owner changed the alert after review');
    assert.match(item.reasons[0]!, /compared with the notebook tile; it matches none/);
    assert.deepEqual(ran, []);
    assert.deepEqual(settings.calls.map((c) => c.op), ['get']);
  });

  it('tells an owner migration and an unknown staged version from an owner edit', async () => {
    const migrated = await plan({ live: detector(`${APPROVED}\n| filter v > 3`, CLASSIC_PROPS) });
    assert.equal(migrated.outcome.gate, 'drift: owner already migrated it');

    const noBlock = { type: 'dql', state: { input: { value: `// [CCT-DETECTOR objectId=${ID}]\n${APPROVED}\n` } } };
    const unknown = await plan({ sections: [noBlock] });
    assert.equal(unknown.outcome.gate, 'drift: staged version unknown');
  });

  it('publishes a drifted alert named by --force with --ids, saying so', async () => {
    const { item } = await plan({ live: detector(`${CLASSIC}\n| filter v > 1`, CLASSIC_PROPS), args: { force: true, ids: [ID] } });
    assert.equal(item.result, 'ready', item.reasons.join(' | '));
    assert.ok(item.reasons.some((r) => /published anyway: --force with --ids names it/.test(r)), item.reasons.join(' | '));

    const notNamed = await plan({ live: detector(`${CLASSIC}\n| filter v > 1`, CLASSIC_PROPS), args: { force: true, ids: ['other'] } });
    assert.equal(notNamed.item.result, 'skipped', '--force covers only the alerts --ids names');
  });

  it('skips a blocking lint finding before any run', async () => {
    const tileQuery = 'timeseries v=avg(`cloud.aws.emr_ec2.HDFSUtilization.By.JobFlowId`), by:{dt.smartscape.aws_emr_cluster}';
    const { item, outcome, ran } = await plan({ tileQuery });
    assert.equal(outcome.gate, 'blocking lint');
    assert.match(item.reasons[0]!, /emr-ec2-namespace/);
    assert.deepEqual(ran, []);
  });

  it('skips an approved query that fails over the last 2 hours, before the entity check', async () => {
    const tileQuery = 'timeseries v = avg(cloud.aws.sqs.ApproximateNumberOfMessagesVisible.By.QueueName), by:{QueueName}';
    const { item, outcome, ran } = await plan({ tileQuery, rows: (q, w) => (q === tileQuery && w === TWO_HOURS ? dqlError('subquery read too much data') : textRows(q)) });
    assert.equal(outcome.gate, 'the query fails on the tenant');
    assert.match(item.reasons[0]!, /^the approved query fails on the tenant over the last 2 hours: subquery read too much data/);
    assert.deepEqual(runsOf(ran), [[tileQuery, '2h']], 'no binding check ran');
  });

  describe('the entity', () => {
    const NO_ENTITY = 'timeseries v = avg(cloud.aws.sqs.ApproximateNumberOfMessagesVisible.By.QueueName), by:{QueueName}';
    const BOUND = 'timeseries v = avg(cloud.aws.sqs.ApproximateNumberOfMessagesVisible.By.QueueName), by:{QueueName, dt.smartscape_source.id}';

    it('adds dt.smartscape_source.id when the 7-day count is unchanged, and publishes that query', async () => {
      const { item, outcome, ran } = await plan({ tileQuery: NO_ENTITY });
      assert.equal(item.result, 'ready', item.reasons.join(' | '));
      assert.equal(item.entityColumn, 'dt.smartscape_source.id');
      assert.ok(item.reasons.some((r) => /added `dt\.smartscape_source\.id` to the split; the series count is unchanged/.test(r)), item.reasons.join(' | '));
      const final = `${BOUND}\n| fieldsAdd dt.smartscape_source.id.name = getNodeName(dt.smartscape_source.id)`;
      assert.equal(outcome.payload!.liveQuery, CLASSIC);
      assert.equal(((outcome.payload!.value.analyzer as { input: Prop[] }).input[0]!).value, final);
      assert.deepEqual(runsOf(ran), [
        [NO_ENTITY, '2h'],
        [NO_ENTITY, '7d'],
        [BOUND, '7d'],
        [BOUND, '2h'],
        [final, '2h'],
      ]);
    });

    it('sends back an alert that would fire per resource, before the series cap is counted', async () => {
      const rows = (q: string, w: number) => (q === BOUND && w === SEVEN_DAYS ? [{}, {}, {}] : q === BOUND ? dqlError('must not run') : textRows(q));
      const { item, outcome, ran } = await plan({ tileQuery: NO_ENTITY, rows });
      assert.equal(outcome.gate, 'no entity: would fire per resource, back for review');
      assert.match(item.reasons[0]!, /Set publish_override/);
      assert.equal(ran.some((r) => r.query === BOUND && r.windowMs === TWO_HOURS), false, 'the 2-hour cap run never happens');
    });

    it('skips an alert published without entity whose event text is nothing but entity placeholders', async () => {
      const live = detector(CLASSIC, [
        { key: 'event.name', value: '{dims:dt.entity.custom_device.name}' },
        { key: 'dt.source_entity', value: '{dims:dt.entity.custom_device}' },
      ]);
      const { item, outcome } = await plan({ tileQuery: NO_ENTITY, live, candidate: { override: 'without-entity' } });
      assert.equal(outcome.gate, 'removing the entity placeholders leaves a field empty');
      assert.equal(item.reasons[0], 'removing the entity placeholders leaves event.name empty; reword it in the detector');
    });

    it('publishes without entity when text is left once the placeholders are removed', async () => {
      const live = detector(CLASSIC, [{ key: 'event.name', value: 'Backlog on {dims:dt.entity.custom_device.name}' }]);
      const { item, outcome } = await plan({ tileQuery: NO_ENTITY, live, candidate: { override: 'without-entity' } });
      assert.equal(item.result, 'ready', item.reasons.join(' | '));
      assert.deepEqual((outcome.payload!.value.eventTemplate as { properties: Prop[] }).properties, [{ key: 'event.name', value: 'Backlog on' }]);
    });

    it('publishes it per resource under the reviewer’s override', async () => {
      const rows = (q: string, w: number) => (q === BOUND && w === SEVEN_DAYS ? [{ 'dt.smartscape_source.id': 1 }, { 'dt.smartscape_source.id': 2 }, { 'dt.smartscape_source.id': 3 }] : textRows(q));
      const { item } = await plan({ tileQuery: NO_ENTITY, rows, candidate: { override: 'per-resource' } });
      assert.equal(item.result, 'ready', item.reasons.join(' | '));
      assert.equal(item.override, 'per-resource');
    });
  });

  it('skips more than 10,000 series over 2 hours before checking the event fields', async () => {
    const many = Array.from({ length: 10_001 }, () => ({}));
    const live = detector(CLASSIC, [{ key: 'event.name', value: 'Backlog {dims:no_such_column}' }]);
    const { item, outcome } = await plan({ live, rows: (q, w) => (w === TWO_HOURS ? many : textRows(q)) });
    assert.equal(outcome.gate, 'over the series cap');
    assert.equal(item.series, 10_001);
  });

  it('skips an event field that names a column the query does not emit, before the final query runs', async () => {
    const live = detector(CLASSIC, [{ key: 'event.name', value: '{dims:dt.entity.custom_device.name}: {dims:no_such_column}' }]);
    const { item, outcome, ran } = await plan({ live });
    assert.equal(outcome.gate, 'event field names a column the query does not emit');
    assert.match(item.reasons[0]!, /\{dims:no_such_column\} \(in event\.name\)/);
    assert.equal(ran.some((r) => r.query === PUBLISHED), false, 'the query with the name column never ran');
  });

  it('skips when the final query, with the columns added for the event fields, fails over 2 hours', async () => {
    const { item, outcome, ran } = await plan({ rows: (q) => (q === PUBLISHED ? dqlError('getNodeName is not allowed here') : textRows(q)) });
    assert.equal(outcome.gate, 'the query fails on the tenant');
    assert.match(item.reasons[0]!, /^the query to publish fails on the tenant over the last 2 hours: getNodeName is not allowed here/);
    assert.deepEqual(runsOf(ran).at(-1), [PUBLISHED, '2h']);
  });

  it('skips a value the server refuses to validate, keeping the payload for the report', async () => {
    const { item, outcome } = await plan({ validateError: new SettingsApiError(400, 'https://example/settings', '{"error":{"message":"bad value"}}') });
    assert.equal(outcome.gate, 'server validation failed');
    assert.match(item.reasons[0]!, /^server validation failed: HTTP 400: bad value/);
    assert.ok(outcome.payload);
  });

  it('appends the node-name and alias columns the event fields read, and runs that query once before it can go out', async () => {
    const classicMsk = 'timeseries lag = max(cloud.aws.kafka.sum_offset_lag), by:{dt.entity.custom_device, cluster_name}';
    const approved = 'timeseries lag = max(cloud.aws.kafka.SumOffsetLag.By.Cluster_Name), by:{dt.smartscape.aws_msk_cluster, `Cluster Name`}';
    const live = detector(classicMsk, [
      { key: 'event.name', value: 'Lag on {dims:cluster_name} ({dims:dt.entity.custom_device.name})' },
      { key: 'dt.source_entity', value: '{dims:dt.entity.custom_device}' },
    ]);
    const { item, outcome, ran } = await plan({ live, sections: [tileOf(ID, approved, classicMsk)] });

    const final =
      `${approved}\n| fieldsAdd dt.smartscape.aws_msk_cluster.name = getNodeName(dt.smartscape.aws_msk_cluster)` + '\n| fieldsAdd Cluster_Name = `Cluster Name`';
    assert.equal(item.result, 'ready', item.reasons.join(' | '));
    assert.equal(((outcome.payload!.value.analyzer as { input: Prop[] }).input[0]!).value, final);
    assert.deepEqual((outcome.payload!.value.eventTemplate as { properties: Prop[] }).properties, [
      { key: 'event.name', value: 'Lag on {dims:Cluster_Name} ({dims:dt.smartscape.aws_msk_cluster.name})' },
      { key: 'dt.smartscape_source.id', value: '{dt.smartscape.aws_msk_cluster}' },
    ]);
    assert.equal(ran.filter((r) => r.query === final).length, 1);
    assert.deepEqual(runsOf(ran).at(-1), [final, '2h'], 'the final query is the last one run');
    assert.ok(item.reasons.some((r) => /`Cluster Name` as Cluster_Name/.test(r)), item.reasons.join(' | '));
  });

  it('skips both alerts of a tile that carries two alerts’ markers (one tile pasted into another, the other deleted)', async () => {
    const merged = { type: 'dql', state: { input: { value: buildReviewQuery('A-1', APPROVED, CLASSIC) + buildReviewQuery('B-1', 'timeseries b = avg(m)', 'classic b') } } };
    for (const objectId of ['A-1', 'B-1']) {
      const { item, outcome, ran } = await plan({ sections: [merged], candidate: { objectId } });
      assert.equal(item.result, 'skipped', objectId);
      assert.equal(outcome.gate, 'tile carries markers for several alerts', objectId);
      assert.deepEqual(ran, [], objectId);
    }
  });
});
