import { useCallback, useEffect, useState } from 'react';
import { serviceLevelObjectivesClient } from '@dynatrace-sdk/client-classic-environment-v2';

import type { CloudProvider } from '../types/connection';
import type { SloResult, SloScanPhase, SloScanState, SloStatus } from '../types/slo';
import {
  detectClassicMetricPatterns,
  detectClassicEntityPatterns,
  detectClassicEntitySelectorPatterns,
} from '../utils/classicPatterns';

// ─── Sub-scan A: Classic SLOs via GET /api/v2/slo ────────────────────────────

async function scanClassicSlos(
  provider: CloudProvider,
  token: string | null,
): Promise<{ results: SloResult[]; tokenMissing: boolean }> {
  if (token === null) {
    return { results: [], tokenMissing: true };
  }

  const results: SloResult[] = [];
  let nextPageKey: string | undefined;

  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await serviceLevelObjectivesClient.getSlo(
      nextPageKey
        ? { nextPageKey }
        : { enabledSlos: 'all', pageSize: 1000 },
    );

    for (const slo of page.slo ?? []) {
      try {
        const metricText = slo.metricExpression ?? '';
        const filterText = slo.filter ?? '';

        const metricMatches = metricText
          ? detectClassicMetricPatterns(metricText, provider)
          : [];
        const entitySelectorMatches = filterText
          ? detectClassicEntitySelectorPatterns(filterText, provider)
          : [];

        const allPatterns = Array.from(new Set([...metricMatches, ...entitySelectorMatches]));
        if (allPatterns.length === 0) continue;

        // Map SDK status to our extended SloStatus; disabled SLOs derive DISABLED from enabled flag
        const rawStatus = slo.status as string;
        let status: SloStatus;
        if (!slo.enabled) {
          status = 'DISABLED';
        } else if (rawStatus === 'FAILURE' || rawStatus === 'SUCCESS' || rawStatus === 'WARNING') {
          status = rawStatus;
        } else {
          status = 'UNKNOWN';
        }

        results.push({
          id: slo.id ?? '',
          name: slo.name ?? '',
          sloType: 'Classic',
          status,
          enabled: slo.enabled,
          // Cast to string: SDK only declares 'AGGREGATE' but runtime may return WINDOW/CUMULATIVE
          evaluationType: (slo.evaluationType as string) as SloResult['evaluationType'] ?? 'AGGREGATE',
          targetSuccess: slo.target ?? 0,
          classicPatterns: allPatterns,
        });
      } catch {
        // Malformed SLO record — skip silently (AC #17)
      }
    }

    nextPageKey = page.nextPageKey;
  } while (nextPageKey);

  return { results, tokenMissing: false };
}

// ─── Sub-scan B: New DQL-based SLOs ──────────────────────────────────────────

// TODO: Implement once the new SLO API surface and required scopes are confirmed
// (Open Questions #1 and #2 from Story 005 remain unresolved — no SDK package installed).
async function scanNewSlos(_provider: CloudProvider): Promise<SloResult[]> {
  return [];
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export type UseSloScanOptions = {
  provider: CloudProvider;
  token: string | null;
};

export function useSloScan({ provider, token }: UseSloScanOptions): SloScanState {
  const [results, setResults] = useState<SloResult[]>([]);
  const [phase, setPhase] = useState<SloScanPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [partialFailures, setPartialFailures] = useState<string[]>([]);

  // Reset to idle when the provider changes (AC #18)
  useEffect(() => {
    setResults([]);
    setPhase('idle');
    setError(null);
    setPartialFailures([]);
  }, [provider]);

  const run = useCallback(async () => {
    setResults([]);
    setPhase('scanning');
    setError(null);
    setPartialFailures([]);

    // Run both sub-scans in parallel; failures are isolated (AC #2)
    const [classicOutcome, newSloOutcome] = await Promise.allSettled([
      scanClassicSlos(provider, token),
      scanNewSlos(provider),
    ]);

    const allResults: SloResult[] = [];
    const failures: string[] = [];

    if (classicOutcome.status === 'fulfilled') {
      if (classicOutcome.value.tokenMissing) {
        // Token absent — partial failure, not a crash (AC #9)
        failures.push('Classic SLOs (token required)');
      } else {
        allResults.push(...classicOutcome.value.results);
      }
    } else {
      failures.push('Classic SLOs');
    }

    if (newSloOutcome.status === 'fulfilled') {
      allResults.push(...newSloOutcome.value);
    } else {
      failures.push('New DQL-based SLOs');
    }

    // Both sub-scans failed (not counting token-absent as failure for "all failed" check)
    const hardFailures = failures.filter((f) => f !== 'Classic SLOs (token required)');
    if (hardFailures.length >= 2) {
      setError(
        'SLO configurations could not be loaded. Verify that the required scopes are granted, then retry.',
      );
      setPhase('done');
    } else {
      setResults(allResults);
      setPartialFailures(failures);
      setError(null);
      setPhase('done');
    }
  }, [provider, token]);

  return { results, phase, error, partialFailures, run };
}
