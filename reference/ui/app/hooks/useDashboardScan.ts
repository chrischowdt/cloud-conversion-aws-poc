import { useCallback, useRef, useState } from 'react';
import { documentsClient } from '@dynatrace-sdk/client-document';
import { getDocumentLink } from '@dynatrace-sdk/navigation';
import { getEnvironmentUrl } from '@dynatrace-sdk/app-environment';

import type { CloudProvider } from '../types/connection';
import type { DashboardScanResult, DashboardScanState, ScanPhase } from '../types/dashboard';
import {
  detectClassicMetricPatterns,
  detectClassicEntityPatterns,
} from '../utils/classicPatterns';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The AppEngine host (*.apps.dynatrace.com) differs from the classic tenant host
 * (*.dynatrace.com). Strip the ".apps" segment to get the classic API base URL.
 * Works for both prod (*.apps.dynatrace.com) and dev (*.apps.dynatracelabs.com).
 */
function getClassicBaseUrl(): string {
  return getEnvironmentUrl()
    .replace(/\/$/, '')
    .replace('.apps.dynatrace', '.dynatrace');
}

function classicDashboardUrl(id: string): string {
  return `${getEnvironmentUrl().replace(/\/$/, '')}/ui/apps/dynatrace.classic.dashboards/#dashboard;gtf=-2h;gf=all;id=${id}`;
}

// ─── New dashboard scanning ───────────────────────────────────────────────────

const CLOUDS_APP_ID = 'dynatrace.clouds';

async function scanNewDashboards(
  provider: CloudProvider,
  includePresetAndReadyMade: boolean,
  signal: AbortSignal,
): Promise<DashboardScanResult[]> {
  const results: DashboardScanResult[] = [];

  // Paginate through all documents of type 'dashboard'
  let pageKey: string | undefined = undefined;
  do {
    if (signal.aborted) return results;

    // eslint-disable-next-line no-await-in-loop
    const page = await documentsClient.listDocuments({
      filter: "type = 'dashboard'",
      pageSize: 1000,
      adminAccess: true,
      addFields: 'userContext.lastAccessedTime',
      ...(pageKey ? { pageKey } : {}),
    });

    for (const doc of page.documents ?? []) {
      if (signal.aborted) return results;
      // Skip ready-made dashboards from the Clouds App when not requested. Consider preview releases on internal environments that have additional postfixes or prefixes in the originAppId. AC #3: exclude all documents with originAppId containing 'dynatrace.clouds' to be safe.
      if (!includePresetAndReadyMade && (doc.originAppId === CLOUDS_APP_ID || doc.originAppId?.includes(CLOUDS_APP_ID))) continue;
      try {
        const resp = await documentsClient.getDocument({ id: doc.id, adminAccess: true });
        if (!resp.content) continue;

        const text = await resp.content.get('text');
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(text) as Record<string, unknown>;
        } catch {
          continue; // malformed JSON — skip silently (AC #6)
        }

        const patterns: string[] = [];

        // Walk all tiles and extract DQL query strings
        const tiles = (parsed.tiles ?? {}) as Record<string, unknown>;
        for (const tile of Object.values(tiles)) {
          if (!tile || typeof tile !== 'object') continue;
          const t = tile as Record<string, unknown>;

          // DQL query string in data tiles
          const query = typeof t.query === 'string' ? t.query : '';
          if (query) {
            patterns.push(...detectClassicMetricPatterns(query, provider));
            patterns.push(...detectClassicEntityPatterns(query, provider));
          }

          // Some tile structures nest queries inside a queries array
          const queries = Array.isArray(t.queries) ? t.queries : [];
          for (const q of queries) {
            if (typeof q?.query === 'string') {
              patterns.push(...detectClassicMetricPatterns(q.query as string, provider));
              patterns.push(...detectClassicEntityPatterns(q.query as string, provider));
            }
          }
        }

        const unique = Array.from(new Set(patterns));
        if (unique.length === 0) continue;

        results.push({
          id: doc.id,
          name: doc.name,
          url: getDocumentLink(doc.id),
          format: 'new',
          ownership: doc.originAppId ? 'ready-made' : 'custom',
          classicPatterns: unique,
          owner: doc.owner ?? null,
          lastModified: doc.modificationInfo?.lastModifiedTime ?? null,
          lastOpened: doc.userContext?.lastAccessedTime ?? null,
        });
      } catch {
        // Permission error or network failure — skip silently (AC #6)
      }
    }

    pageKey = page.nextPageKey;
  } while (pageKey);

  return results;
}

// ─── Classic dashboard scanning ───────────────────────────────────────────────

type ClassicDashboardStub = { id: string; name: string; owner: string };

type ClassicTile = Record<string, unknown>;

function extractPatternsFromClassicTile(tile: ClassicTile, provider: CloudProvider): string[] {
  const patterns: string[] = [];

  const tileType = typeof tile.tileType === 'string' ? tile.tileType : '';

  // SLO tiles — scan the full tile JSON for metric patterns (SLO expressions can
  // contain classic metric selectors, e.g. builtin:cloud.aws.*)
  if (tileType === 'SLO') {
    const tileJson = JSON.stringify(tile);
    patterns.push(...detectClassicMetricPatterns(tileJson, provider));
  }

  // DATA_EXPLORER tiles
  if (tileType === 'DATA_EXPLORER') {
    const queries = Array.isArray(tile.queries) ? tile.queries : [];
    for (const q of queries) {
      const metric = typeof q?.metric === 'string' ? (q.metric as string) : '';
      if (metric) patterns.push(...detectClassicMetricPatterns(metric, provider));
    }
  }

  // CUSTOM_CHARTING tiles
  if (tileType === 'CUSTOM_CHARTING') {
    const filter = tile.filterConfig as Record<string, unknown> | undefined;
    const chart = filter?.chartConfig as Record<string, unknown> | undefined;
    const series = Array.isArray(chart?.series) ? chart!.series : [];
    for (const s of series) {
      const metric = typeof s?.metric === 'string' ? (s.metric as string) : '';
      if (metric) patterns.push(...detectClassicMetricPatterns(metric, provider));
    }
  }

  // HOSTS / SERVICES / APPLICATIONS — scan filterConfig for entity selectors with cloud types
  if (['HOSTS', 'SERVICES', 'APPLICATIONS'].includes(tileType)) {
    const filterStr = JSON.stringify(tile.filterConfig ?? '');
    patterns.push(...detectClassicMetricPatterns(filterStr, provider));
  }

  return patterns;
}

async function classicApiCall(
  path: string,
  token: string,
  signal: AbortSignal,
): Promise<unknown> {
  const resp = await fetch('/api/classic-dashboards', {
    method: 'POST',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, path, classicBaseUrl: getClassicBaseUrl() }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json() as Promise<unknown>;
}

async function scanClassicDashboards(
  provider: CloudProvider,
  token: string,
  includePresetAndReadyMade: boolean,
  signal: AbortSignal,
): Promise<DashboardScanResult[]> {
  const results: DashboardScanResult[] = [];

  // List all classic dashboards
  let stubs: ClassicDashboardStub[] = [];
  try {
    const body = (await classicApiCall('/api/config/v1/dashboards', token, signal)) as { dashboards?: ClassicDashboardStub[] };
    stubs = body.dashboards ?? [];
  } catch {
    // Config API v1 unavailable — skip entire classic scan silently
    return results;
  }

  for (const stub of stubs) {
    if (signal.aborted) return results;

    if (!includePresetAndReadyMade && (stub.owner === 'Dynatrace')) continue;

    try {
      const full = (await classicApiCall(`/api/config/v1/dashboards/${stub.id}`, token, signal)) as Record<string, unknown>;

      const meta = full.dashboardMetadata as Record<string, unknown> | undefined;
      const isPreset = meta?.preset === true;

      // Skip preset dashboards when not requested
      if (!includePresetAndReadyMade && isPreset) continue;

      const patterns: string[] = [];
      const tiles = Array.isArray(full.tiles) ? full.tiles : [];
      for (const tile of tiles) {
        patterns.push(...extractPatternsFromClassicTile(tile as ClassicTile, provider));
      }

      const unique = Array.from(new Set(patterns));
      if (unique.length === 0) continue;

      results.push({
        id: stub.id,
        name: stub.name,
        url: classicDashboardUrl(stub.id),
        format: 'classic',
        ownership: isPreset ? 'preset' : 'custom',
        classicPatterns: unique,
        owner: stub.owner,
        lastModified: null,
        lastOpened: null,
      });
    } catch {
      // Dashboard inaccessible or malformed — skip silently (AC #6)
    }
  }

  return results;
}

// ─── Sort ─────────────────────────────────────────────────────────────────────

const OWNERSHIP_ORDER: Record<string, number> = { custom: 0, preset: 1, 'ready-made': 2 };

function sortResults(results: DashboardScanResult[]): DashboardScanResult[] {
  return [...results].sort((a, b) => {
    // Primary: ownership order (custom first — most action required)
    const ownerDiff = OWNERSHIP_ORDER[a.ownership] - OWNERSHIP_ORDER[b.ownership];
    if (ownerDiff !== 0) return ownerDiff;
    // Secondary: pattern count descending (more patterns = more migration work)
    const patternDiff = b.classicPatterns.length - a.classicPatterns.length;
    if (patternDiff !== 0) return patternDiff;
    // Tertiary: last opened descending (recently used dashboards surface first)
    const aTime = a.lastOpened?.getTime() ?? -1;
    const bTime = b.lastOpened?.getTime() ?? -1;
    return bTime - aTime;
  });
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export type UseDashboardScanOptions = {
  provider: CloudProvider;
  token: string | null;
};

export function useDashboardScan({ provider, token }: UseDashboardScanOptions): DashboardScanState {
  const [results, setResults] = useState<DashboardScanResult[]>([]);
  const [phase, setPhase] = useState<ScanPhase>('idle');
  const [error, setError] = useState<string | null>(null);

  // Abort controller ref — cancelled when a new scan starts
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async (includePresetAndReadyMade: boolean) => {
    // Cancel any in-flight scan
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setResults([]);
    setPhase('scanning');
    setError(null);

    try {
      // Run new and classic scans in parallel; classic only if token is available
      const [newResults, classicResults] = await Promise.all([
        scanNewDashboards(provider, includePresetAndReadyMade, controller.signal),
        token
          ? scanClassicDashboards(provider, token, includePresetAndReadyMade, controller.signal)
          : Promise.resolve([] as DashboardScanResult[]),
      ]);

      if (controller.signal.aborted) return;

      setResults(sortResults([...newResults, ...classicResults]));
      setPhase('done');
      setError(null);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Scan failed');
      setPhase('done');
    }
  }, [provider, token]);

  return { results, phase, error, run };
}
