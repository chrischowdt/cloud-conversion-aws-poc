import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { batchOfDetectors, deriveOwner, keepsBatchLabel, nextStatus } from './refresh-alert-tracker.ts';

describe('refresh must not rewind work already done', () => {
  // The first run against the team workbook reset status=staged -> candidate and
  // overwrote the batch label in `reasons` for all 55 staged alerts: a refresh
  // re-derives confidence, but staging is real progress recorded by another command.
  it('leaves in-flight statuses alone', () => {
    for (const s of ['staged', 'in-review', 'promoted', 'verified']) {
      assert.equal(nextStatus(s, 'medium'), s);
      assert.equal(nextStatus(s, 'blocked'), s, 'even if confidence now says blocked');
    }
  });

  it('still re-evaluates the two not-yet-started states, so the queue can move', () => {
    assert.equal(nextStatus('blocked', 'medium'), 'candidate', 'a detector the rewriter can now convert');
    assert.equal(nextStatus('candidate', 'blocked'), 'blocked', 'and the reverse');
    assert.equal(nextStatus('candidate', 'medium'), 'candidate');
  });

  it('sets the status for a row the sheet has never seen', () => {
    assert.equal(nextStatus(undefined, 'medium'), 'candidate');
    assert.equal(nextStatus('', 'blocked'), 'blocked');
    assert.equal(nextStatus('   ', 'medium'), 'candidate');
  });

  it('keeps a batch label in `reasons`, which is the only record of the review notebook', () => {
    assert.equal(keepsBatchLabel('review batch batch-01'), true);
    assert.equal(keepsBatchLabel('review batch batch-12'), true);
  });

  it('overwrites `reasons` when it holds confidence text rather than a batch', () => {
    assert.equal(keepsBatchLabel('soft warnings: mapped-no-recipe'), false);
    assert.equal(keepsBatchLabel(''), false);
    assert.equal(keepsBatchLabel(undefined), false);
    assert.equal(keepsBatchLabel('no review batch'), false, 'needs a label after the words');
  });
});

describe('nextStatus and the publish statuses', () => {
  // Publishing (later tasks) writes these. A refresh re-derives confidence from a
  // fresh scan and must never pull a published alert back to candidate/blocked.
  it('nextStatus leaves publish statuses alone', () => {
    for (const s of ['promoted', 'verified', 'rolled-back']) {
      assert.equal(nextStatus(s, 'blocked'), s);
    }
  });
});

describe('batchOfDetectors', () => {
  it('maps published batches only', () => {
    const map = batchOfDetectors({
      batches: [
        { batch: 'batch-01', notebookId: 'nb-1', detectors: [{ objectId: 'A' }, { objectId: 'B' }] },
        // Never published (a prepare run, or a failed create): its ids are not in any notebook.
        { batch: 'batch-02', detectors: [{ objectId: 'C' }] },
        { batch: 'batch-03', notebookId: 'nb-3', detectors: [{ objectId: 'D' }] },
      ],
    });
    assert.equal(map.get('A'), 'batch-01');
    assert.equal(map.get('B'), 'batch-01');
    assert.equal(map.get('D'), 'batch-03');
    assert.equal(map.has('C'), false, 'a batch without notebookId is ignored');
    assert.equal(map.size, 3);
  });

  it('tolerates a manifest with no batches', () => {
    assert.equal(batchOfDetectors({}).size, 0);
  });
});

describe('deriveOwner', () => {
  it('prefers an applicationci in the query over the title prefix', () => {
    const o = deriveOwner('ABC - something', 'timeseries x | filter aws.tags.applicationci == "bbt"');
    assert.equal(o.team, 'BBT');
    assert.equal(o.source, 'applicationci');
  });

  it('falls back to the title prefix', () => {
    assert.deepEqual(deriveOwner('CWE - Lambda Timeout is High', 'timeseries x'), { team: 'CWE', source: 'title' });
  });

  it('declines to guess when the query names several teams and the title has no code', () => {
    const o = deriveOwner('Amazon ECS CPU', 'filter applicationci == "aaa" or applicationci == "bbb"');
    assert.equal(o.team, '');
    assert.equal(o.source, 'unknown');
  });

  it('marks Dynatrace-shipped templates as belonging to nobody', () => {
    assert.deepEqual(deriveOwner('Amazon ECS CPU utilization [AWS] [Standard]', 'timeseries x'), {
      team: '',
      source: 'platform-default',
    });
  });
});
