import { renderHook, act } from '@testing-library/react';
import { documentsClient } from '@dynatrace-sdk/client-document';
import { httpClient } from '@dynatrace-sdk/http-client';
import { getEnvironmentUrl } from '@dynatrace-sdk/app-environment';
import { getDocumentLink } from '@dynatrace-sdk/navigation';

import { useDashboardScan } from './useDashboardScan';

// ─── Module mocks ─────────────────────────────────────────────────────────────

jest.mock('@dynatrace-sdk/client-document', () => ({
  documentsClient: {
    listDocuments: jest.fn(),
    getDocument: jest.fn(),
  },
}));

jest.mock('@dynatrace-sdk/http-client', () => ({
  httpClient: {
    send: jest.fn(),
  },
}));

jest.mock('@dynatrace-sdk/app-environment', () => ({
  getEnvironmentUrl: jest.fn(),
}));

jest.mock('@dynatrace-sdk/navigation', () => ({
  getDocumentLink: jest.fn(),
}));

const mockListDocuments = documentsClient.listDocuments as jest.MockedFunction<typeof documentsClient.listDocuments>;
const mockGetDocument = documentsClient.getDocument as jest.MockedFunction<typeof documentsClient.getDocument>;
const mockHttpSend = httpClient.send as jest.MockedFunction<typeof httpClient.send>;
const mockGetEnvironmentUrl = getEnvironmentUrl as jest.MockedFunction<typeof getEnvironmentUrl>;
const mockGetDocumentLink = getDocumentLink as jest.MockedFunction<typeof getDocumentLink>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDocContent(text: string) {
  return {
    get: jest.fn().mockResolvedValue(text),
  };
}

function makeDashboardContent(tiles: Record<string, unknown>): string {
  return JSON.stringify({ tiles });
}

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    name: 'My Dashboard',
    originAppId: null,
    owner: 'user@example.com',
    modificationInfo: { lastModifiedTime: new Date('2026-01-01'), lastModifiedBy: 'u', createdBy: 'u', createdTime: new Date('2026-01-01') },
    userContext: { lastAccessedTime: new Date('2026-02-01') },
    ...overrides,
  };
}

function setupNewDashboardScan(docs: ReturnType<typeof makeDoc>[], tilesByDocId: Record<string, Record<string, unknown>> = {}) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockListDocuments.mockResolvedValue({ documents: docs, nextPageKey: undefined } as any);
  mockGetDocument.mockImplementation(async ({ id }: { id: string }) => {
    const tiles = tilesByDocId[id] ?? {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { content: makeDocContent(makeDashboardContent(tiles)) } as any;
  });
  mockGetDocumentLink.mockReturnValue('https://example.dynatrace.com/doc/doc-1');
  mockGetEnvironmentUrl.mockReturnValue('https://example.dynatrace.com');
}

function setupClassicDashboardScan(dashboards: Record<string, unknown>[]) {
  mockGetEnvironmentUrl.mockReturnValue('https://example.dynatrace.com');
  const stubs = dashboards.map((d, i) => ({ id: `classic-${i}`, name: d.name as string }));

  mockHttpSend.mockImplementation(async ({ url }: { url: string; method: string; headers: Record<string, string> }) => {
    if (url.endsWith('/dashboards')) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return { body: jest.fn().mockResolvedValue({ dashboards: stubs }) } as any;
    }
    const idx = stubs.findIndex((s) => url.endsWith(s.id));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { body: jest.fn().mockResolvedValue(dashboards[idx]) } as any;
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useDashboardScan', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default: no new documents, no classic dashboards
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockListDocuments.mockResolvedValue({ documents: [], nextPageKey: undefined } as any);
    mockGetEnvironmentUrl.mockReturnValue('https://example.dynatrace.com');
  });

  // ── AC #1: Idle state ────────────────────────────────────────────────────

  describe('initial state (AC #1)', () => {
    it('starts in idle phase with no results', () => {
      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));
      expect(result.current.phase).toBe('idle');
      expect(result.current.results).toHaveLength(0);
      expect(result.current.error).toBeNull();
    });
  });

  // ── AC #2: Scan transitions ──────────────────────────────────────────────

  describe('scan phase transitions (AC #2)', () => {
    it('moves through scanning → done when run is called', async () => {
      setupNewDashboardScan([]);

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));

      await act(async () => {
        await result.current.run(false);
      });

      expect(result.current.phase).toBe('done');
    });

    it('shows empty results when no matching dashboards are found', async () => {
      setupNewDashboardScan([
        makeDoc({ id: 'doc-1', name: 'Unrelated' }),
      ], {
        'doc-1': { tile1: { query: 'fetch events | fields timestamp' } },
      });

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));

      await act(async () => {
        await result.current.run(false);
      });

      expect(result.current.results).toHaveLength(0);
    });
  });

  // ── AC #2 + #5: New dashboard detection ─────────────────────────────────

  describe('new dashboard pattern detection (AC #2, #5)', () => {
    it('detects dt.cloud.aws. metric key in a new dashboard DQL tile', async () => {
      setupNewDashboardScan(
        [makeDoc({ id: 'doc-1', name: 'AWS Dashboard' })],
        { 'doc-1': { tile1: { query: 'fetch metric.series | filter startsWith(metric.key, "dt.cloud.aws.ec2")' } } },
      );

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));
      await act(async () => { await result.current.run(false); });

      expect(result.current.results).toHaveLength(1);
      expect(result.current.results[0].classicPatterns).toContain('dt.cloud.aws.');
      expect(result.current.results[0].format).toBe('new');
    });

    it('detects classic entity type reference fetch dt.entity.ec2_instance', async () => {
      setupNewDashboardScan(
        [makeDoc({ id: 'doc-1', name: 'EC2 Dashboard' })],
        { 'doc-1': { tile1: { query: 'fetch dt.entity.ec2_instance | fields entity.name' } } },
      );

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));
      await act(async () => { await result.current.run(false); });

      expect(result.current.results[0].classicPatterns).toContain('dt.entity.ec2_instance');
    });

    it('scans queries nested inside a queries array', async () => {
      setupNewDashboardScan(
        [makeDoc({ id: 'doc-1', name: 'Nested Queries' })],
        { 'doc-1': { tile1: { queries: [{ query: 'fetch metric.series | filter startsWith(metric.key, "dt.cloud.aws.")' }] } } },
      );

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));
      await act(async () => { await result.current.run(false); });

      expect(result.current.results[0].classicPatterns).toContain('dt.cloud.aws.');
    });
  });

  // ── AC #3: Ownership classification ─────────────────────────────────────

  describe('ownership classification (AC #3)', () => {
    it('marks a new dashboard without originAppId as custom', async () => {
      setupNewDashboardScan(
        [makeDoc({ id: 'doc-1', originAppId: null })],
        { 'doc-1': { t: { query: 'fetch metric.series | filter startsWith(metric.key, "dt.cloud.aws.")' } } },
      );

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));
      await act(async () => { await result.current.run(false); });

      expect(result.current.results[0].ownership).toBe('custom');
    });

    it('marks a new dashboard with originAppId as ready-made', async () => {
      setupNewDashboardScan(
        [makeDoc({ id: 'doc-1', originAppId: 'dynatrace.some.app' })],
        { 'doc-1': { t: { query: 'fetch metric.series | filter startsWith(metric.key, "dt.cloud.aws.")' } } },
      );

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));
      await act(async () => { await result.current.run(true); });

      expect(result.current.results[0].ownership).toBe('ready-made');
    });

    it('excludes Clouds App ready-made dashboards when includePresetAndReadyMade is false', async () => {
      setupNewDashboardScan(
        [makeDoc({ id: 'doc-1', originAppId: 'dynatrace.clouds' })],
        { 'doc-1': { t: { query: 'dt.cloud.aws.ec2.cpu' } } },
      );

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));
      await act(async () => { await result.current.run(false); });

      expect(result.current.results).toHaveLength(0);
    });

    it('includes Clouds App dashboards when includePresetAndReadyMade is true', async () => {
      setupNewDashboardScan(
        [makeDoc({ id: 'doc-1', originAppId: 'dynatrace.clouds' })],
        { 'doc-1': { t: { query: 'fetch metric.series | filter startsWith(metric.key, "dt.cloud.aws.")' } } },
      );

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));
      await act(async () => { await result.current.run(true); });

      expect(result.current.results).toHaveLength(1);
      expect(result.current.results[0].ownership).toBe('ready-made');
    });
  });

  // ── AC #4: Classic dashboard detection ──────────────────────────────────

  describe('classic dashboard scanning (AC #4)', () => {
    it('detects builtin:cloud.aws. in DATA_EXPLORER tiles', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockListDocuments.mockResolvedValue({ documents: [], nextPageKey: undefined } as any);

      setupClassicDashboardScan([{
        name: 'Classic AWS',
        dashboardMetadata: { preset: false },
        tiles: [{ tileType: 'DATA_EXPLORER', queries: [{ metric: 'builtin:cloud.aws.ec2.cpu' }] }],
      }]);

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: 'dt0c01.fake' }));
      await act(async () => { await result.current.run(false); });

      expect(result.current.results).toHaveLength(1);
      expect(result.current.results[0].classicPatterns).toContain('builtin:cloud.aws.');
      expect(result.current.results[0].format).toBe('classic');
      expect(result.current.results[0].ownership).toBe('custom');
    });

    it('marks classic dashboards with preset:true as preset ownership', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockListDocuments.mockResolvedValue({ documents: [], nextPageKey: undefined } as any);

      setupClassicDashboardScan([{
        name: 'Preset AWS',
        dashboardMetadata: { preset: true },
        tiles: [{ tileType: 'DATA_EXPLORER', queries: [{ metric: 'builtin:cloud.aws.rds.cpu' }] }],
      }]);

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: 'dt0c01.fake' }));
      await act(async () => { await result.current.run(true); });

      expect(result.current.results[0].ownership).toBe('preset');
    });

    it('excludes preset classic dashboards when includePresetAndReadyMade is false', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockListDocuments.mockResolvedValue({ documents: [], nextPageKey: undefined } as any);

      setupClassicDashboardScan([{
        name: 'Preset AWS',
        dashboardMetadata: { preset: true },
        tiles: [{ tileType: 'DATA_EXPLORER', queries: [{ metric: 'builtin:cloud.aws.ec2.cpu' }] }],
      }]);

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: 'dt0c01.fake' }));
      await act(async () => { await result.current.run(false); });

      expect(result.current.results).toHaveLength(0);
    });

    it('detects builtin:cloud.aws. in CUSTOM_CHARTING tiles', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockListDocuments.mockResolvedValue({ documents: [], nextPageKey: undefined } as any);

      setupClassicDashboardScan([{
        name: 'Charting Dashboard',
        dashboardMetadata: { preset: false },
        tiles: [{
          tileType: 'CUSTOM_CHARTING',
          filterConfig: { chartConfig: { series: [{ metric: 'builtin:cloud.aws.elb.requests' }] } },
        }],
      }]);

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: 'dt0c01.fake' }));
      await act(async () => { await result.current.run(false); });

      expect(result.current.results[0].classicPatterns).toContain('builtin:cloud.aws.');
    });

    it('detects classic metric patterns in SLO tiles (AC #4 extension)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockListDocuments.mockResolvedValue({ documents: [], nextPageKey: undefined } as any);

      setupClassicDashboardScan([{
        name: 'SLO Dashboard',
        dashboardMetadata: { preset: false },
        tiles: [{
          tileType: 'SLO',
          sloId: 'some-slo',
          metricExpression: 'builtin:cloud.aws.ec2.cpu:avg:partition("value"):value:auto',
        }],
      }]);

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: 'dt0c01.fake' }));
      await act(async () => { await result.current.run(false); });

      expect(result.current.results).toHaveLength(1);
      expect(result.current.results[0].classicPatterns).toContain('builtin:cloud.aws.');
    });

    it('skips inaccessible classic dashboards silently (AC #6)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockListDocuments.mockResolvedValue({ documents: [], nextPageKey: undefined } as any);
      mockGetEnvironmentUrl.mockReturnValue('https://example.dynatrace.com');

      const stubs = [{ id: 'classic-0', name: 'Good' }, { id: 'classic-1', name: 'Bad' }];
      mockHttpSend.mockImplementation(async ({ url }: { url: string; method: string; headers: Record<string, string> }) => {
        if (url.endsWith('/dashboards')) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return { body: jest.fn().mockResolvedValue({ dashboards: stubs }) } as any;
        }
        if (url.endsWith('classic-0')) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return { body: jest.fn().mockResolvedValue({
            name: 'Good', dashboardMetadata: { preset: false },
            tiles: [{ tileType: 'DATA_EXPLORER', queries: [{ metric: 'builtin:cloud.aws.ec2.cpu' }] }],
          }) } as any;
        }
        throw new Error('403 Forbidden');
      });

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: 'dt0c01.fake' }));
      await act(async () => { await result.current.run(false); });

      // Bad dashboard skipped, good one included
      expect(result.current.results).toHaveLength(1);
      expect(result.current.results[0].id).toBe('classic-0');
    });

    it('skips classic scan and returns no results when token is null', async () => {
      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));
      await act(async () => { await result.current.run(false); });

      expect(mockHttpSend).not.toHaveBeenCalled();
    });
  });

  // ── AC #6: Malformed JSON skipped silently ───────────────────────────────

  describe('malformed dashboard content (AC #6)', () => {
    it('skips new dashboards with malformed JSON content silently', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockListDocuments.mockResolvedValue({ documents: [makeDoc({ id: 'doc-1' })], nextPageKey: undefined } as any);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockGetDocument.mockResolvedValue({ content: makeDocContent('NOT JSON {{{{') } as any);

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));
      await act(async () => { await result.current.run(false); });

      expect(result.current.phase).toBe('done');
      expect(result.current.results).toHaveLength(0);
    });
  });

  // ── AC #9 + sort order ───────────────────────────────────────────────────

  describe('sort order (AC #9)', () => {
    it('sorts custom dashboards before preset before ready-made', async () => {
      setupNewDashboardScan([
        makeDoc({ id: 'ready', name: 'Ready', originAppId: 'some.app' }),
        makeDoc({ id: 'custom', name: 'Custom', originAppId: null }),
      ], {
        ready: { t: { query: 'dt.cloud.aws.ec2.cpu' } },
        custom: { t: { query: 'dt.cloud.aws.ec2.cpu' } },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockListDocuments.mockResolvedValue({ documents: [
        makeDoc({ id: 'ready', name: 'Ready', originAppId: 'some.app' }),
        makeDoc({ id: 'custom', name: 'Custom', originAppId: null }),
      ], nextPageKey: undefined } as any);
      mockGetDocument.mockImplementation(async ({ id }: { id: string }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { content: makeDocContent(JSON.stringify({ tiles: { t: { query: 'fetch metric.series | filter startsWith(metric.key, "dt.cloud.aws.")' } } })) } as any;
      });

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));
      await act(async () => { await result.current.run(true); });

      expect(result.current.results[0].ownership).toBe('custom');
      expect(result.current.results[1].ownership).toBe('ready-made');
    });

    it('within the same ownership group, sorts by pattern count descending', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      mockListDocuments.mockResolvedValue({ documents: [
        makeDoc({ id: 'few', name: 'Few Patterns' }),
        makeDoc({ id: 'many', name: 'Many Patterns' }),
      ], nextPageKey: undefined } as any);
      mockGetDocument.mockImplementation(async ({ id }: { id: string }) => {
        const query = id === 'many'
          ? 'fetch metric.series | filter startsWith(metric.key, "dt.cloud.aws.") OR startsWith(metric.key, "builtin:cloud.aws.") OR startsWith(metric.key, "ext:cloud.aws.")'
          : 'fetch metric.series | filter startsWith(metric.key, "dt.cloud.aws.")';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return { content: makeDocContent(JSON.stringify({ tiles: { t: { query } } })) } as any;
      });

      const { result } = renderHook(() => useDashboardScan({ provider: 'AWS', token: null }));
      await act(async () => { await result.current.run(false); });

      expect(result.current.results[0].classicPatterns.length).toBeGreaterThan(
        result.current.results[1].classicPatterns.length,
      );
    });
  });
});
