import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planOne, type EarlierRecords, type PlanCtx } from './migrate-promote-detectors.ts';
import { buildReviewQuery } from '../lib/detector-notebook.ts';
import { staticColumns, type PublishCandidate } from '../lib/detector-publish.ts';
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
  const store = new Map<string, Stored>([[ID, { value: f.live ?? detector(CLASSIC, CLASSIC_PROPS), updateToken: 'tok-0', schemaVersion: '1.2.3' }]]);
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
  const candidate: PublishCandidate = { objectId: ID, title: 'Queue backlog', batch: 'batch-03', notebookId: 'nb-3', reviewer: 'reviewer-a', status: 'staged', ...f.candidate };
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

