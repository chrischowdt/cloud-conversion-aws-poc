import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractNotebookQueries, extractDetectorQueries } from './asset-extractors.ts';

describe('extractNotebookQueries', () => {
  it('pulls DQL from sections[].state.input.value', () => {
    const content = {
      sections: [
        { id: 'a', type: 'markdown', state: { text: 'hello world notes' } },
        {
          id: 'b',
          type: 'dql',
          state: {
            input: { value: 'timeseries avg(cloud.aws.ec2.cpu_utilization), by:{dt.entity.custom_device}' },
          },
        },
      ],
    };
    const qs = extractNotebookQueries(content);
    assert.equal(qs.length, 1);
    assert.match(qs[0]!.query, /cloud\.aws\.ec2\.cpu_utilization/);
    assert.match(qs[0]!.location, /section\[1\]:dql/);
  });

  it('ignores non-DQL prose and empty content', () => {
    assert.deepEqual(extractNotebookQueries({ sections: [{ state: { input: { value: 'just a note' } } }] }), []);
    assert.deepEqual(extractNotebookQueries(null), []);
    assert.deepEqual(extractNotebookQueries({}), []);
  });

  it('dedupes a query that appears in both the canonical slot and the sweep', () => {
    const q = 'fetch logs | filter dt.entity.aws_lambda_function == "x"';
    const qs = extractNotebookQueries({ sections: [{ type: 'dql', state: { input: { value: q } } }] });
    assert.equal(qs.length, 1);
  });
});

describe('extractDetectorQueries', () => {
  it('pulls DQL from analyzer.input[] key=="query"', () => {
    const value = {
      title: 'MSK offline partitions',
      analyzer: {
        name: 'StaticThresholdAnomalyDetectionAnalyzer',
        input: [
          { key: 'query', value: 'timeseries avg(cloud.aws.kafka.offline_partitions_count), by:{dt.entity.custom_device}' },
          { key: 'violatingSamples', value: '3' },
        ],
      },
    };
    const qs = extractDetectorQueries(value);
    assert.equal(qs.length, 1);
    assert.equal(qs[0]!.field, 'query');
    assert.match(qs[0]!.query, /offline_partitions_count/);
  });

  it('returns nothing when there is no analyzer input', () => {
    assert.deepEqual(extractDetectorQueries({ title: 'x' }), []);
    assert.deepEqual(extractDetectorQueries(null), []);
  });

  it('ignores short/non-DQL input values', () => {
    const value = { analyzer: { input: [{ key: 'query', value: '5' }] } };
    assert.deepEqual(extractDetectorQueries(value), []);
  });
});
