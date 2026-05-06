import { useCallback, useEffect, useState } from 'react';
import { settingsObjectsClient } from '@dynatrace-sdk/client-classic-environment-v2';

import type { CloudProvider } from '../types/connection';
import type { AlertResult, AlertScanPhase, AlertScanState } from '../types/alert';
import { detectClassicMetricPatterns, extractClassicMetricKeys } from '../utils/classicPatterns';

// ─── Sub-scan A: Custom Metric Events ────────────────────────────────────────

async function scanMetricEvents(provider: CloudProvider): Promise<AlertResult[]> {
  const results: AlertResult[] = [];
  let nextPageKey: string | undefined;

  do {
    // eslint-disable-next-line no-await-in-loop
    const page = await settingsObjectsClient.getSettingsObjects(
      nextPageKey
        ? { nextPageKey }
        : { schemaIds: 'builtin:anomaly-detection.metric-events' },
    );

    for (const obj of page.items ?? []) {
      const val = obj.value as Record<string, unknown> | undefined;
      if (!val) continue;
      try {
        // The metric reference lives inside queryDefinition, not at the top level.
        // type === "METRIC_KEY"      → queryDefinition.metricKey
        // type === "METRIC_SELECTOR" → queryDefinition.metricSelector
        const qd = val.queryDefinition as Record<string, unknown> | undefined;
        const qdType = typeof qd?.type === 'string' ? qd.type : undefined;
        const metricText =
          (typeof qd?.metricKey === 'string' ? qd.metricKey : '') ||
          (typeof qd?.metricSelector === 'string' ? qd.metricSelector : '');
        if (!metricText) continue;

        // Gate: only include if the text matches a classic pattern
        if (detectClassicMetricPatterns(metricText, provider).length === 0) continue;

        // Store the raw key(s) — metricText for METRIC_KEY is already the exact key;
        // for METRIC_SELECTOR it may be an expression, so extract individual keys from it.
        const keys = extractClassicMetricKeys(metricText, provider);

        // Display name: value.summary is the human-readable label in this schema
        const name =
          typeof val.summary === 'string' && val.summary
            ? val.summary
            : (obj.objectId ?? '');

        // Extract aggregation (METRIC_KEY only) and model type (METRIC_SELECTOR only).
        // METRIC_KEY always implies STATIC_THRESHOLD — no need to read modelProperties for it.
        const metricEventQueryType =
          qdType === 'METRIC_KEY' || qdType === 'METRIC_SELECTOR'
            ? (qdType as 'METRIC_KEY' | 'METRIC_SELECTOR')
            : undefined;

        const metricEventAggregation =
          qdType === 'METRIC_KEY' && typeof qd?.aggregation === 'string'
            ? qd.aggregation
            : undefined;

        const mp = val.modelProperties as Record<string, unknown> | undefined;
        const metricEventModelType =
          qdType === 'METRIC_SELECTOR' && typeof mp?.type === 'string'
            ? mp.type
            : undefined;

        // Capture modelProperties for STATIC_THRESHOLD alerts so we can pre-populate
        // the Davis AI analyzer when the user taps "Create Anomaly Detector".
        // METRIC_KEY always implies STATIC_THRESHOLD; METRIC_SELECTOR may use other types.
        const rawModelProperties: AlertResult['rawModelProperties'] =
          mp && (qdType === 'METRIC_KEY' || mp.type === 'STATIC_THRESHOLD')
            ? {
                threshold: typeof mp.threshold === 'number' ? mp.threshold : undefined,
                alertCondition: typeof mp.alertCondition === 'string' ? mp.alertCondition : undefined,
                violatingSamples: typeof mp.violatingSamples === 'number' ? mp.violatingSamples : undefined,
                dealertingSamples: typeof mp.dealertingSamples === 'number' ? mp.dealertingSamples : undefined,
                alertOnNoData: typeof mp.alertOnNoData === 'boolean' ? mp.alertOnNoData : undefined,
                samples: typeof mp.samples === 'number' ? mp.samples : undefined,
              }
            : undefined;

        results.push({
          id: obj.objectId ?? '',
          name,
          enabled: val.enabled !== false,
          alertType: 'metric-event',
          // Fall back to the raw text if key extraction yields nothing (shouldn't happen)
          classicPatterns: keys.length > 0 ? keys : [metricText],
          rawExpression: metricText,
          metricEventQueryType,
          metricEventAggregation,
          metricEventModelType,
          rawModelProperties,
        });
      } catch {
        // Malformed value — skip silently (AC #8)
      }
    }

    nextPageKey = page.nextPageKey;
  } while (nextPageKey);

  return results;
}

// ─── Sub-scan B: Classic Infrastructure Anomaly Detection (AWS only) ─────────

async function scanInfrastructureDetection(provider: CloudProvider): Promise<AlertResult[]> {
  // No equivalent schema exists for Azure or GCP (AC #5)
  if (provider !== 'AWS') return [];

  const page = await settingsObjectsClient.getSettingsObjects({
    schemaIds: 'builtin:anomaly-detection.infrastructure-aws',
    scopes: 'environment',
  });

  const results: AlertResult[] = [];
  for (const obj of page.items ?? []) {
    // Only customised (non-default) objects are returned — their existence is the signal
    results.push({
      id: obj.objectId ?? '',
      name: 'AWS Infrastructure Anomaly Detection',
      enabled: true,
      alertType: 'infrastructure-detection',
      classicPatterns: ['Classic AWS entity types'],
    });
  }
  return results;
}

// ─── Sub-scan C: Davis AI Custom Detectors ───────────────────────────────────

async function scanDavisDetectors(provider: CloudProvider): Promise<AlertResult[]> {
  const results: AlertResult[] = [];
  let nextPageKey: string | undefined;

  try {
    do {
      // eslint-disable-next-line no-await-in-loop
      const page = await settingsObjectsClient.getSettingsObjects(
        nextPageKey
          ? { nextPageKey }
          : { schemaIds: 'builtin:davis.anomaly-detectors' },
      );

      for (const obj of page.items ?? []) {
        const val = obj.value as Record<string, unknown> | undefined;
        if (!val) continue;
        try {
          // Scan all analyzer input field values for classic metric patterns.
          // The schema stores the DQL/metric expression as key-value pairs inside
          // value.analyzer.input[]. Each entry has { key: string, value: string }.
          const textsToScan: string[] = [];
          const analyzer = val.analyzer as Record<string, unknown> | undefined;
          if (analyzer) {
            const inputFields = Array.isArray(analyzer.input) ? analyzer.input : [];
            for (const field of inputFields) {
              if (field && typeof field === 'object') {
                const f = field as Record<string, unknown>;
                if (typeof f.value === 'string' && f.value) {
                  textsToScan.push(f.value);
                }
              }
            }
          }

          if (textsToScan.length === 0) continue;

          // Gate on prefix match; store extracted key tokens (not prefix labels)
          const allKeys: string[] = [];
          const matchingInputs: string[] = [];
          for (const text of textsToScan) {
            if (detectClassicMetricPatterns(text, provider).length > 0) {
              allKeys.push(...extractClassicMetricKeys(text, provider));
              matchingInputs.push(text);
            }
          }
          const unique = Array.from(new Set(allKeys));
          if (unique.length === 0) continue;

          const name =
            typeof val.title === 'string' && val.title
              ? val.title
              : typeof val.name === 'string' && val.name
                ? val.name
                : (obj.objectId ?? '');

          // Capture the full analyzer for pre-populating a new Davis AI detector.
          const rawAnalyzer: AlertResult['rawAnalyzer'] =
            analyzer && typeof analyzer.name === 'string'
              ? {
                  name: analyzer.name,
                  input: Array.isArray(analyzer.input)
                    ? (analyzer.input as unknown[]).filter(
                        (f): f is { key: string; value: string } =>
                          f !== null &&
                          typeof f === 'object' &&
                          typeof (f as Record<string, unknown>).key === 'string' &&
                          typeof (f as Record<string, unknown>).value === 'string',
                      )
                    : [],
                }
              : undefined;

          results.push({
            id: obj.objectId ?? '',
            name,
            enabled: val.enabled !== false,
            alertType: 'davis-ai',
            classicPatterns: unique,
            rawAnalyzerInputs: matchingInputs,
            rawAnalyzer,
          });
        } catch {
          // Malformed value — skip silently (AC #8)
        }
      }

      nextPageKey = page.nextPageKey;
    } while (nextPageKey);
  } catch {
    // Schema not found (older environment without Davis AI app) — treat as no results (AC #8)
    return results;
  }

  return results;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export type UseAlertScanOptions = {
  provider: CloudProvider;
};

export function useAlertScan({ provider }: UseAlertScanOptions): AlertScanState {
  const [results, setResults] = useState<AlertResult[]>([]);
  const [phase, setPhase] = useState<AlertScanPhase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [partialFailures, setPartialFailures] = useState<string[]>([]);

  // Reset to idle when the provider changes
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

    // Run all three sub-scans in parallel; failures are isolated (AC #8)
    const [metricEventOutcome, infraOutcome, davisOutcome] = await Promise.allSettled([
      scanMetricEvents(provider),
      scanInfrastructureDetection(provider),
      scanDavisDetectors(provider),
    ]);

    const allResults: AlertResult[] = [];
    const failures: string[] = [];

    if (metricEventOutcome.status === 'fulfilled') {
      allResults.push(...metricEventOutcome.value);
    } else {
      failures.push('Custom Metric Events');
    }

    if (infraOutcome.status === 'fulfilled') {
      allResults.push(...infraOutcome.value);
    } else {
      failures.push('Infrastructure Detection');
    }

    if (davisOutcome.status === 'fulfilled') {
      allResults.push(...davisOutcome.value);
    } else {
      failures.push('Davis AI');
    }

    if (failures.length === 3) {
      // All sub-scans failed — full error state
      setError(
        'Alert configurations could not be loaded. Verify that the settings:objects:read scope is granted, then retry.',
      );
      setPhase('done');
    } else {
      setResults(allResults);
      setPartialFailures(failures);
      setError(null);
      setPhase('done');
    }
  }, [provider]);

  return { results, phase, error, partialFailures, run };
}
