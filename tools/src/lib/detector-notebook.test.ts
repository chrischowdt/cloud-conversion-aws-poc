import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReviewQuery,
  parseReviewQuery,
  buildDetectorNotebook,
  buildDetectorMarkdown,
  chunk,
  type DetectorReviewItem,
  buildReviewCard,
  parseReviewCard,
  collectReviewCards,
  REVIEW_STATUSES,
  STATUS_TO_DECISION,
} from './detector-notebook.ts';

function item(over: Partial<DetectorReviewItem> = {}): DetectorReviewItem {
  return {
    objectId: 'abc-123',
    title: 'RDS Deadlocks is High',
    original: 'timeseries avg(cloud.aws.rds.deadlocks), by:{dt.entity.custom_device}',
    rewritten: 'timeseries avg(cloud.aws.rds.Deadlocks.By.DBInstanceIdentifier), by:{dt.smartscape.aws_rds_dbinstance}',
    nodeType: 'AWS_RDS_DBINSTANCE',
    targetDim: 'dt.smartscape.aws_rds_dbinstance',
    thresholdAction: { kind: 'unchanged', reason: 'no rescaling recipe' },
    eventTemplateChanges: [{ field: 'dt.source_entity', before: '{dims:dt.entity.custom_device}', after: '{dims:dt.smartscape.aws_rds_dbinstance}' }],
    warnings: [],
    bucket: 'soft',
    ...over,
  };
}

describe('buildReviewQuery / parseReviewQuery round-trip', () => {
  it('embeds the objectId marker and the original as comments, runnable query in the middle', () => {
    const v = buildReviewQuery('abc-123', 'timeseries avg(m.By.X)', 'timeseries avg(m)\n| filter y == 1');
    assert.match(v, /^\/\/ \[CCT-DETECTOR objectId=abc-123\]/);
    assert.match(v, /\/\/ \[CCT-ORIGINAL\]/);
    // original lines are commented
    assert.match(v, /\/\/ timeseries avg\(m\)/);
    assert.match(v, /\/\/ \| filter y == 1/);
    // rewritten query present verbatim
    assert.match(v, /timeseries avg\(m\.By\.X\)/);
  });

  it('reads the objectId + clean query back, stripping scaffold', () => {
    const v = buildReviewQuery('abc-123', 'timeseries avg(m.By.X)\n| fields a', 'timeseries avg(m)');
    const { objectId, query } = parseReviewQuery(v);
    assert.equal(objectId, 'abc-123');
    assert.equal(query, 'timeseries avg(m.By.X)\n| fields a');
  });

  it('read-back survives the reviewer editing the query body', () => {
    const v = buildReviewQuery('det-9', 'timeseries avg(bad)', 'timeseries avg(orig)');
    // simulate an edit: replace the query line
    const edited = v.replace('timeseries avg(bad)', 'timeseries avg(fixed.By.Dim), by:{dt.smartscape.aws_sqs_queue}');
    const { objectId, query } = parseReviewQuery(edited);
    assert.equal(objectId, 'det-9');
    assert.equal(query, 'timeseries avg(fixed.By.Dim), by:{dt.smartscape.aws_sqs_queue}');
  });

  it('returns no objectId for an un-marked value', () => {
    const { objectId, query } = parseReviewQuery('smartscapeNodes AWS_SQS_QUEUE | limit 1');
    assert.equal(objectId, undefined);
    assert.equal(query, 'smartscapeNodes AWS_SQS_QUEUE | limit 1');
  });
});

describe('buildDetectorMarkdown', () => {
  it('surfaces node, threshold, binding, and warnings', () => {
    const md = buildDetectorMarkdown(
      item({
        thresholdAction: { kind: 'rescaled', reason: 'metric rescales ×2', from: 10, to: 5, scale: 2 },
        warnings: [{ kind: 'classic-selector-note', text: 'assumed aws context' } as any],
      })
    );
    assert.match(md, /AWS_RDS_DBINSTANCE/);
    assert.match(md, /auto-rescaled 10 → 5/);
    assert.match(md, /binding rewritten/i);
    assert.match(md, /assumed aws context/);
  });

  it('flags a blocked-threshold detector prominently', () => {
    const md = buildDetectorMarkdown(
      item({ thresholdAction: { kind: 'blocked', reason: 'aggregation flips avg()→sum()', metric: 'x' } })
    );
    assert.match(md, /NOT converted/);
    assert.match(md, /Reset it manually/);
  });
});

describe('buildDetectorNotebook', () => {
  it('emits a header + a markdown & dql tile per detector, with read-back markers', () => {
    const nb = buildDetectorNotebook('batch-01', [item(), item({ objectId: 'def-456' })]);
    assert.equal(nb.version, '7');
    // 1 header + 2 detectors * (summary + dql + review card) = 7 sections
    assert.equal(nb.sections.length, 7);
    assert.equal(nb.sections[0]!.type, 'markdown');
    const dqls = nb.sections.filter((s) => s.type === 'dql');
    assert.equal(dqls.length, 2);
    for (const d of dqls as any[]) {
      assert.match(d.state.input.value, /\[CCT-DETECTOR objectId=/);
      assert.equal(d.state.visualization, 'table');
    }
    // parse-back the first dql tile
    const first = parseReviewQuery((dqls[0] as any).state.input.value);
    assert.equal(first.objectId, 'abc-123');
  });
});

describe('chunk', () => {
  it('splits into batches of N', () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunk([], 10), []);
  });
});

describe('reviewer verdict card', () => {
  it('is emitted per detector, after the query tile', () => {
    const nb = buildDetectorNotebook('batch-01', [item()]);
    // header + (summary, dql, review) = 4
    assert.equal(nb.sections.length, 4);
    assert.equal(nb.sections[1]!.type, 'markdown');
    assert.equal(nb.sections[2]!.type, 'dql');
    assert.equal(nb.sections[3]!.type, 'markdown');
    assert.equal(nb.sections[3]!.id, 'review-abc-123');
  });

  it('starts at Not Reviewed and reads back as untouched', () => {
    const card = buildReviewCard(item());
    const p = parseReviewCard(card);
    assert.equal(p.objectId, 'abc-123');
    assert.equal(p.status, 'Not Reviewed');
    assert.equal(p.notes, '');
    assert.equal(p.untouched, true, 'a pristine card must not look like an answer');
  });

  it('reads back a filled-in status and notes', () => {
    const filled = buildReviewCard(item())
      .replace('**Status:** Not Reviewed', '**Status:** Converted OK')
      .replace(
        '_(optional — replace this line with anything the migration team should know:',
        'Checked all 3 tables, matches classic.'
      );
    const p = parseReviewCard(filled);
    assert.equal(p.status, 'Converted OK');
    assert.match(p.notes, /Checked all 3 tables/);
    assert.equal(p.untouched, false);
  });

  it('tolerates bold/case/punctuation around the status', () => {
    for (const raw of ['**Needs Fix**', 'needs fix', 'Needs Fix.', '`Needs Fix`']) {
      const card = buildReviewCard(item()).replace('**Status:** Not Reviewed', `**Status:** ${raw}`);
      assert.equal(parseReviewCard(card).status, 'Needs Fix', `failed for ${raw}`);
    }
  });

  it('returns an unrecognized status verbatim rather than coercing it', () => {
    const card = buildReviewCard(item()).replace('**Status:** Not Reviewed', '**Status:** looks fine to me');
    const p = parseReviewCard(card);
    assert.equal(p.status, 'looks fine to me', 'a typo must not silently become an approval');
    assert.ok(!REVIEW_STATUSES.includes(p.status as any));
  });

  it('collects every card from a notebook and keeps ids aligned', () => {
    const nb = buildDetectorNotebook('b', [item(), item({ objectId: 'def-456' })]);
    const cards = collectReviewCards(nb);
    assert.deepEqual(cards.map((c) => c.objectId), ['abc-123', 'def-456']);
    assert.ok(cards.every((c) => c.untouched));
  });

  it('maps every status onto a tracker decision', () => {
    for (const s of REVIEW_STATUSES) assert.ok(STATUS_TO_DECISION[s], `no mapping for ${s}`);
    assert.equal(STATUS_TO_DECISION['Converted OK'], 'Ready To Publish');
  });
});
