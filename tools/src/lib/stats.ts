/** Numeric helpers for comparing two time series. */

export interface SeriesSummary {
  count: number;
  nonNullCount: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  sum: number | null;
}

export interface TimeSeriesPoint {
  ts: number;
  value: number | null;
}

export function summarize(values: Array<number | null>): SeriesSummary {
  let nonNull = 0;
  let sum = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (v === null || Number.isNaN(v)) continue;
    nonNull++;
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return {
    count: values.length,
    nonNullCount: nonNull,
    min: nonNull > 0 ? min : null,
    max: nonNull > 0 ? max : null,
    mean: nonNull > 0 ? sum / nonNull : null,
    sum: nonNull > 0 ? sum : null,
  };
}

export interface ComparisonResult {
  alignedPoints: number;
  unalignedPoints: number;
  pearsonR: number | null;
  smape: number | null;
  meanRatio: number | null;
  verdict: 'identical' | 'scaled' | 'correlated' | 'different' | 'no-data';
}

export interface ScaledFitResult {
  alignedPoints: number;
  pearsonR: number | null;
  /**
   * Best-fit scalar k such that classic ≈ k * new. Computed via least-squares
   * (no intercept), which is robust to mean-zero series and gives the same
   * answer as `mean(classic) / mean(new)` when both means are nonzero.
   */
  scale: number | null;
  /** sMAPE after applying the scale to the new side. 0 = perfect fit. */
  residualSmape: number | null;
  /** Median absolute relative error after scaling. Robust to outliers. */
  medianRelError: number | null;
}

/**
 * Find the best scale factor `k` such that classic ≈ k * new, then report how
 * well that holds. Useful for "same shape, different reduction" cases where
 * dividing the new side by some count (instances, minutes, etc.) recovers
 * the classic value.
 *
 * No-data when fewer than 3 paired non-null points exist.
 */
export function fitScaleAndResidual(
  classic: TimeSeriesPoint[],
  newSide: TimeSeriesPoint[]
): ScaledFitResult {
  const cMap = new Map<number, number>();
  for (const p of classic) {
    if (p.value !== null && !Number.isNaN(p.value)) cMap.set(p.ts, p.value);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of newSide) {
    if (p.value === null || Number.isNaN(p.value)) continue;
    const c = cMap.get(p.ts);
    if (c !== undefined) {
      xs.push(p.value);
      ys.push(c);
    }
  }
  if (xs.length < 3) {
    return { alignedPoints: xs.length, pearsonR: null, scale: null, residualSmape: null, medianRelError: null };
  }

  // Pearson r.
  const meanX = xs.reduce((s, v) => s + v, 0) / xs.length;
  const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0, denX = 0, denY = 0, dotXY = 0, sumX2 = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
    dotXY += xs[i]! * ys[i]!;
    sumX2 += xs[i]! * xs[i]!;
  }
  const pearsonR = denX === 0 || denY === 0 ? null : num / Math.sqrt(denX * denY);

  // Least-squares scale (no intercept): k = Σxy / Σx²
  const scale = sumX2 === 0 ? null : dotXY / sumX2;

  if (scale === null || !Number.isFinite(scale)) {
    return { alignedPoints: xs.length, pearsonR, scale: null, residualSmape: null, medianRelError: null };
  }

  let sumAbsDiff = 0;
  let sumAbsSum = 0;
  const relErrors: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const fitted = scale * xs[i]!;
    const truth = ys[i]!;
    sumAbsDiff += Math.abs(fitted - truth);
    sumAbsSum += Math.abs(fitted) + Math.abs(truth);
    if (Math.abs(truth) > 1e-12) {
      relErrors.push(Math.abs(fitted - truth) / Math.abs(truth));
    }
  }
  const residualSmape = sumAbsSum === 0 ? 0 : (2 * sumAbsDiff) / sumAbsSum;
  relErrors.sort((a, b) => a - b);
  const medianRelError = relErrors.length === 0 ? null : relErrors[Math.floor(relErrors.length / 2)]!;

  return { alignedPoints: xs.length, pearsonR, scale, residualSmape, medianRelError };
}

/**
 * Compare two time series after aligning by timestamp. Pearson r and sMAPE are
 * computed only over timestamps present on both sides; timestamps present on
 * just one side are counted as `unalignedPoints` (a signal of resolution
 * mismatch or partial coverage).
 */
export function compareAligned(
  a: TimeSeriesPoint[],
  b: TimeSeriesPoint[]
): ComparisonResult {
  const aMap = new Map<number, number>();
  for (const p of a) {
    if (p.value !== null && !Number.isNaN(p.value)) aMap.set(p.ts, p.value);
  }
  const bMap = new Map<number, number>();
  for (const p of b) {
    if (p.value !== null && !Number.isNaN(p.value)) bMap.set(p.ts, p.value);
  }
  const xs: number[] = [];
  const ys: number[] = [];
  let unaligned = 0;
  for (const [ts, av] of aMap) {
    const bv = bMap.get(ts);
    if (bv !== undefined) {
      xs.push(av);
      ys.push(bv);
    } else {
      unaligned++;
    }
  }
  for (const ts of bMap.keys()) {
    if (!aMap.has(ts)) unaligned++;
  }

  if (xs.length < 3) {
    return {
      alignedPoints: xs.length,
      unalignedPoints: unaligned,
      pearsonR: null,
      smape: null,
      meanRatio: null,
      verdict: 'no-data',
    };
  }

  const meanX = xs.reduce((s, v) => s + v, 0) / xs.length;
  const meanY = ys.reduce((s, v) => s + v, 0) / ys.length;
  let num = 0;
  let denX = 0;
  let denY = 0;
  let sumAbsDiff = 0;
  let sumAbsSum = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
    sumAbsDiff += Math.abs(xs[i]! - ys[i]!);
    sumAbsSum += Math.abs(xs[i]!) + Math.abs(ys[i]!);
  }
  const pearsonR = denX === 0 || denY === 0 ? null : num / Math.sqrt(denX * denY);
  const smape = sumAbsSum === 0 ? 0 : (2 * sumAbsDiff) / sumAbsSum;
  const meanRatio = meanY === 0 ? null : meanX / meanY;

  let verdict: ComparisonResult['verdict'];
  if (smape < 0.01) verdict = 'identical';
  else if (pearsonR !== null && pearsonR > 0.95 && Math.abs((meanRatio ?? 1) - 1) < 0.5)
    verdict = 'scaled';
  else if (pearsonR !== null && pearsonR > 0.85) verdict = 'correlated';
  else verdict = 'different';

  return {
    alignedPoints: xs.length,
    unalignedPoints: unaligned,
    pearsonR,
    smape,
    meanRatio,
    verdict,
  };
}
