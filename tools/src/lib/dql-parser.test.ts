import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { combineSeries, parseTimeseriesRecord } from './dql-parser.ts';

describe('parseTimeseriesRecord', () => {
  it('parses ISO interval and ISO timeframe', () => {
    const record = {
      timeframe: { start: '2026-04-30T00:00:00Z', end: '2026-04-30T00:15:00Z' },
      interval: 'PT5M',
      val: [1, 2, 3],
    };
    const series = parseTimeseriesRecord(record);
    assert.equal(series.length, 1);
    const s = series[0]!;
    assert.equal(s.label, 'val');
    assert.equal(s.points.length, 3);
    assert.equal(s.points[0]!.ts, Date.parse('2026-04-30T00:00:00Z'));
    assert.equal(s.points[1]!.ts, Date.parse('2026-04-30T00:05:00Z'));
    assert.equal(s.points[2]!.ts, Date.parse('2026-04-30T00:10:00Z'));
    assert.deepEqual(
      s.points.map((p) => p.value),
      [1, 2, 3]
    );
  });

  it('parses nanosecond interval', () => {
    const record = {
      timeframe: { start: '2026-04-30T00:00:00Z', end: '2026-04-30T00:10:00Z' },
      // 60_000_000_000 ns = 60s = 60_000 ms
      interval: 60_000_000_000,
      val: [10, 20, 30, null],
    };
    const [s] = parseTimeseriesRecord(record);
    assert.ok(s);
    assert.equal(s.points.length, 4);
    assert.equal(s.points[1]!.ts - s.points[0]!.ts, 60_000);
    assert.equal(s.points[3]!.value, null);
  });

  it('treats non-array fields as dimensions and labels them', () => {
    const record = {
      timeframe: { start: '2026-04-30T00:00:00Z', end: '2026-04-30T00:10:00Z' },
      interval: 'PT5M',
      val: [1, 2],
      'dt.entity.aws_credentials': 'AWS_CREDENTIALS-1234',
      Region: 'us-east-1',
    };
    const [s] = parseTimeseriesRecord(record);
    assert.ok(s);
    assert.match(s.label, /val \[/);
    assert.match(s.label, /Region=us-east-1/);
    assert.equal(s.dimensions['Region'], 'us-east-1');
  });

  it('returns multiple series when the record has multiple value arrays', () => {
    const record = {
      timeframe: { start: '2026-04-30T00:00:00Z', end: '2026-04-30T00:10:00Z' },
      interval: 'PT5M',
      classic: [1, 2],
      newkey: [10, 20],
    };
    const series = parseTimeseriesRecord(record);
    assert.equal(series.length, 2);
    assert.deepEqual(
      series.map((s) => s.label).sort(),
      ['classic', 'newkey']
    );
  });

  it('preferredSeriesName filters to a single series when present', () => {
    const record = {
      timeframe: { start: '2026-04-30T00:00:00Z', end: '2026-04-30T00:10:00Z' },
      interval: 'PT5M',
      classic: [1, 2],
      newkey: [10, 20],
    };
    const series = parseTimeseriesRecord(record, 'classic');
    assert.equal(series.length, 1);
    assert.equal(series[0]!.label, 'classic');
  });

  it('returns empty when timeframe or interval are missing', () => {
    const noStart = { interval: 'PT5M', val: [1, 2] };
    assert.equal(parseTimeseriesRecord(noStart).length, 0);
    const noInterval = { timeframe: { start: '2026-04-30T00:00:00Z', end: '...' }, val: [1, 2] };
    assert.equal(parseTimeseriesRecord(noInterval).length, 0);
  });
});

describe('combineSeries', () => {
  it('returns single series unchanged', () => {
    const points = [
      { ts: 1, value: 10 },
      { ts: 2, value: 20 },
    ];
    const out = combineSeries([{ label: 'a', dimensions: {}, points }]);
    assert.deepEqual(out, points);
  });

  it('averages overlapping timestamps from multiple series', () => {
    const a = { label: 'a', dimensions: {}, points: [{ ts: 1, value: 10 }, { ts: 2, value: 20 }] };
    const b = { label: 'b', dimensions: {}, points: [{ ts: 1, value: 30 }, { ts: 2, value: 40 }] };
    const out = combineSeries([a, b]);
    assert.deepEqual(out, [
      { ts: 1, value: 20 },
      { ts: 2, value: 30 },
    ]);
  });

  it('handles disjoint timestamps', () => {
    const a = { label: 'a', dimensions: {}, points: [{ ts: 1, value: 10 }] };
    const b = { label: 'b', dimensions: {}, points: [{ ts: 2, value: 20 }] };
    const out = combineSeries([a, b]);
    assert.deepEqual(out, [
      { ts: 1, value: 10 },
      { ts: 2, value: 20 },
    ]);
  });
});
