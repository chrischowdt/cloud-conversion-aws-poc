/**
 * Tiny self-tests for compareAligned. Run with:
 *   node --experimental-strip-types --no-warnings=ExperimentalWarning \
 *     --test src/lib/stats.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { compareAligned, fitScaleAndResidual, type TimeSeriesPoint } from './stats.ts';

const ts = (i: number): number => 1_700_000_000_000 + i * 60_000;

const pts = (vals: Array<number | null>): TimeSeriesPoint[] =>
  vals.map((v, i) => ({ ts: ts(i), value: v }));

describe('compareAligned', () => {
  it('verdicts identical when series match', () => {
    const a = pts([1, 2, 3, 4, 5]);
    const b = pts([1, 2, 3, 4, 5]);
    const r = compareAligned(a, b);
    assert.equal(r.verdict, 'identical');
    assert.equal(r.alignedPoints, 5);
    assert.equal(r.unalignedPoints, 0);
    assert.ok(r.smape !== null && r.smape < 0.001);
  });

  it('verdicts scaled when series are linearly related with same mean', () => {
    const a = pts([10, 20, 30, 40, 50]);
    const b = pts([12, 22, 32, 42, 50]);
    const r = compareAligned(a, b);
    assert.ok(r.pearsonR !== null && r.pearsonR > 0.99);
    assert.equal(r.verdict, 'scaled');
  });

  it('verdicts different when series are uncorrelated', () => {
    const a = pts([1, 100, 2, 99, 3, 98, 4]);
    const b = pts([50, 50, 50, 50, 50, 50, 50]);
    const r = compareAligned(a, b);
    assert.equal(r.verdict, 'different');
  });

  it('counts unaligned timestamps when one side has extra points', () => {
    const a = [
      { ts: ts(0), value: 1 },
      { ts: ts(1), value: 2 },
      { ts: ts(2), value: 3 },
      { ts: ts(3), value: 4 },
    ];
    const b = [
      { ts: ts(0), value: 1 },
      // ts(1) missing
      { ts: ts(2), value: 3 },
      { ts: ts(3), value: 4 },
      { ts: ts(4), value: 5 }, // extra on b side
    ];
    const r = compareAligned(a, b);
    assert.equal(r.alignedPoints, 3);
    assert.equal(r.unalignedPoints, 2); // ts(1) on a-only, ts(4) on b-only
  });

  it('returns no-data verdict when fewer than 3 aligned points', () => {
    const a = pts([1, 2]);
    const b = pts([1, 2]);
    const r = compareAligned(a, b);
    assert.equal(r.verdict, 'no-data');
  });

  it('ignores null values when aligning', () => {
    const a = pts([1, null, 3, null, 5]);
    const b = pts([1, 2, 3, 4, 5]);
    const r = compareAligned(a, b);
    assert.equal(r.alignedPoints, 3);
    assert.equal(r.unalignedPoints, 2);
  });

  it('aligns by timestamp not by index (different resolutions)', () => {
    // Classic resolution 1m, new resolution 2m — only every other timestamp lines up.
    const classic = pts([1, 2, 3, 4, 5, 6]);
    const newSide = [
      { ts: ts(0), value: 1 },
      { ts: ts(2), value: 3 },
      { ts: ts(4), value: 5 },
    ];
    const r = compareAligned(classic, newSide);
    assert.equal(r.alignedPoints, 3);
    assert.equal(r.unalignedPoints, 3);
    assert.equal(r.verdict, 'identical');
  });
});

describe('fitScaleAndResidual', () => {
  it('finds the scale factor for a perfectly scaled series', () => {
    // classic = 14 * new (no noise)
    const newSide: TimeSeriesPoint[] = [
      { ts: 1, value: 10 },
      { ts: 2, value: 20 },
      { ts: 3, value: 30 },
      { ts: 4, value: 40 },
    ];
    const classic: TimeSeriesPoint[] = newSide.map((p) => ({ ts: p.ts, value: p.value! * 14 }));
    const r = fitScaleAndResidual(classic, newSide);
    assert.ok(r.scale !== null);
    assert.ok(Math.abs(r.scale! - 14) < 1e-6);
    assert.ok(r.residualSmape !== null && r.residualSmape < 1e-6);
    assert.ok(r.pearsonR !== null && r.pearsonR > 0.9999);
  });

  it('reports nonzero residual when shape doesnt match', () => {
    const newSide: TimeSeriesPoint[] = [
      { ts: 1, value: 10 },
      { ts: 2, value: 20 },
      { ts: 3, value: 30 },
      { ts: 4, value: 40 },
    ];
    const classic: TimeSeriesPoint[] = [
      { ts: 1, value: 5 },
      { ts: 2, value: 100 },
      { ts: 3, value: 1 },
      { ts: 4, value: 80 },
    ];
    const r = fitScaleAndResidual(classic, newSide);
    assert.ok(r.scale !== null);
    assert.ok(r.residualSmape !== null && r.residualSmape > 0.3);
  });

  it('returns no-data for fewer than 3 aligned points', () => {
    const r = fitScaleAndResidual(
      [{ ts: 1, value: 1 }],
      [{ ts: 1, value: 2 }]
    );
    assert.equal(r.scale, null);
    assert.equal(r.residualSmape, null);
  });
});
