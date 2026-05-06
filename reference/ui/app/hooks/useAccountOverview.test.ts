import { renderHook } from '@testing-library/react';
import { useDql } from '@dynatrace-sdk/react-hooks';

import { useAccountOverview, buildMetricKeyListQuery } from './useAccountOverview';
import { CLASSIC_ENTITY_TYPES, CLASSIC_METRIC_PREFIXES } from '../utils/classicPatterns';

// ─── Module mock ─────────────────────────────────────────────────────────────

jest.mock('@dynatrace-sdk/react-hooks', () => ({
  useDql: jest.fn(),
}));

const mockUseDql = useDql as jest.MockedFunction<typeof useDql>;

// ─── Helpers ──────────────────────────────────────────────────────────────────

type DqlRecord = Record<string, unknown>;

function makeDqlResult(records: DqlRecord[]) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { records, metadata: {}, types: [] } as any,
    isLoading: false,
    error: null,
    isPending: false,
    refetch: jest.fn(),
    cancel: jest.fn(),
  };
}

function makeLoadingResult() {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: undefined as any,
    isLoading: true,
    error: null,
    isPending: true,
    refetch: jest.fn(),
    cancel: jest.fn(),
  };
}

function makeErrorResult(message: string) {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: undefined as any,
    isLoading: false,
    error: new Error(message),
    isPending: false,
    refetch: jest.fn(),
    cancel: jest.fn(),
  };
}

/**
 * Route useDql calls by inspecting the query string.
 * Each query builder produces distinguishable content.
 */
function setupDqlMock({
  builtInResult = makeDqlResult([]),
  fallbackResult = makeDqlResult([]),
  customDeviceResult = makeDqlResult([]),
  metricCountResult = makeDqlResult([]),
}: {
  builtInResult?: ReturnType<typeof makeDqlResult>;
  fallbackResult?: ReturnType<typeof makeDqlResult>;
  customDeviceResult?: ReturnType<typeof makeDqlResult>;
  metricCountResult?: ReturnType<typeof makeDqlResult>;
} = {}) {
  // Capture query string from first argument
  const calls: string[] = [];
  mockUseDql.mockImplementation((params: { query: string } | string) => {
    const query = typeof params === 'string' ? params : params.query;
    calls.push(query);

    // Built-in query: contains 'append' (multi-type chain) OR single built-in entity type fetch
    // but NOT 'custom_device' and NOT 'metric.series'
    if (query.includes('belongs_to') || (query.includes('ebs_volume') && query.includes('lookup'))) {
      return fallbackResult as ReturnType<typeof useDql>;
    }
    if (query.includes('metric.series')) {
      return metricCountResult as ReturnType<typeof useDql>;
    }
    if (query.includes('custom_device')) {
      return customDeviceResult as ReturnType<typeof useDql>;
    }
    // Built-in types (includes 'append' or starts with 'fetch dt.entity.' for built-in type)
    if (query.includes('accessible_by') || query.includes('append')) {
      return builtInResult as ReturnType<typeof useDql>;
    }
    return makeDqlResult([]) as ReturnType<typeof useDql>;
  });
  return calls;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useAccountOverview', () => {
  afterEach(() => jest.clearAllMocks());

  // ── AWS query shape ─────────────────────────────────────────────────────

  describe('AWS query shape', () => {
    it('built-in query includes all 8 scoped entity types (not ebs_volume)', () => {
      const capturedQueries: string[] = [];
      mockUseDql.mockImplementation((params: { query: string } | string) => {
        const q = typeof params === 'string' ? params : params.query;
        capturedQueries.push(q);
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      const builtIn = capturedQueries.find((q) => q.includes('accessible_by') && !q.includes('ebs_volume') && !q.includes('custom_device') && !q.includes('metric.series'));
      expect(builtIn).toBeDefined();

      const awsScopedTypes = CLASSIC_ENTITY_TYPES.AWS.filter((t) => t !== 'ebs_volume');
      for (const type of awsScopedTypes) {
        expect(builtIn).toContain(`dt.entity.${type}`);
      }
      // ebs_volume must NOT be in this query
      expect(builtIn).not.toContain('dt.entity.ebs_volume');
    });

    it('ebs_volume uses belongs_to → lookup traversal in fallback query', () => {
      const capturedQueries: string[] = [];
      mockUseDql.mockImplementation((params: { query: string } | string) => {
        const q = typeof params === 'string' ? params : params.query;
        capturedQueries.push(q);
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      const fallback = capturedQueries.find((q) => q.includes('ebs_volume'));
      expect(fallback).toBeDefined();
      expect(fallback).toContain('belongs_to');
      expect(fallback).toContain('lookup');
      expect(fallback).toContain('ec2_instance');
      expect(fallback).toContain('AWS_CREDENTIALS-ABC123');
    });

    it('custom device query filters by cloud:aws and credential entity ID', () => {
      const capturedQueries: string[] = [];
      mockUseDql.mockImplementation((params: { query: string } | string) => {
        const q = typeof params === 'string' ? params : params.query;
        capturedQueries.push(q);
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      const customDevice = capturedQueries.find((q) => q.includes('custom_device'));
      expect(customDevice).toBeDefined();
      expect(customDevice).toContain('cloud:aws');
      expect(customDevice).toContain('AWS_CREDENTIALS-ABC123');
      expect(customDevice).toContain('accessible_by');
    });

    it('fires exactly 4 useDql calls (built-in, fallback, custom_device, metric count)', () => {
      const capturedQueries: string[] = [];
      mockUseDql.mockImplementation((params: { query: string } | string) => {
        const q = typeof params === 'string' ? params : params.query;
        capturedQueries.push(q);
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      expect(capturedQueries).toHaveLength(4);
    });

    it('disables all entity queries when credentialEntityId is null', () => {
      const capturedOptions: Array<{ enabled?: boolean }> = [];
      mockUseDql.mockImplementation((_params: unknown, options?: { enabled?: boolean }) => {
        capturedOptions.push(options ?? {});
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: null,
        subscriptionEntityId: null,
        accountId: null,
      }));

      // built-in, fallback, and custom device should all be disabled
      const disabledCount = capturedOptions.filter((o) => o.enabled === false).length;
      expect(disabledCount).toBeGreaterThanOrEqual(3);
    });
  });

  // ── Azure query shape ───────────────────────────────────────────────────

  describe('Azure query shape', () => {
    it('built-in query uses subscriptionEntityId in accessible_by filter', () => {
      const capturedQueries: string[] = [];
      mockUseDql.mockImplementation((params: { query: string } | string) => {
        const q = typeof params === 'string' ? params : params.query;
        capturedQueries.push(q);
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      renderHook(() => useAccountOverview({
        provider: 'Azure',
        credentialEntityId: 'AZURE_CREDENTIALS-XYZ',
        subscriptionEntityId: 'AZURE_SUBSCRIPTION-DEF456',
        accountId: 'sub-uuid-1',
      }));

      const builtIn = capturedQueries.find((q) =>
        q.includes('accessible_by') && q.includes('azure_subscription') && !q.includes('custom_device')
      );
      expect(builtIn).toBeDefined();
      expect(builtIn).toContain('AZURE_SUBSCRIPTION-DEF456');
    });

    it('built-in query includes all 12 Azure entity types', () => {
      const capturedQueries: string[] = [];
      mockUseDql.mockImplementation((params: { query: string } | string) => {
        const q = typeof params === 'string' ? params : params.query;
        capturedQueries.push(q);
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      renderHook(() => useAccountOverview({
        provider: 'Azure',
        credentialEntityId: 'AZURE_CREDENTIALS-XYZ',
        subscriptionEntityId: 'AZURE_SUBSCRIPTION-DEF456',
        accountId: 'sub-uuid-1',
      }));

      const builtIn = capturedQueries.find((q) => q.includes('azure_subscription') && !q.includes('custom_device'));
      expect(builtIn).toBeDefined();
      for (const type of CLASSIC_ENTITY_TYPES.Azure) {
        expect(builtIn).toContain(`dt.entity.${type}`);
      }
    });

    it('disables built-in and custom device queries when subscriptionEntityId is null', () => {
      const capturedOptions: Array<{ enabled?: boolean }> = [];
      mockUseDql.mockImplementation((_params: unknown, options?: { enabled?: boolean }) => {
        capturedOptions.push(options ?? {});
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      renderHook(() => useAccountOverview({
        provider: 'Azure',
        credentialEntityId: 'AZURE_CREDENTIALS-XYZ',
        subscriptionEntityId: null,
        accountId: null,
      }));

      const disabledCount = capturedOptions.filter((o) => o.enabled === false).length;
      expect(disabledCount).toBeGreaterThanOrEqual(2);
    });
  });

  // ── GCP query shape ─────────────────────────────────────────────────────

  describe('GCP query shape', () => {
    it('GCP fires no built-in entity query (empty string → disabled)', () => {
      const capturedOptions: Array<{ enabled?: boolean }> = [];
      const capturedQueries: string[] = [];
      mockUseDql.mockImplementation((params: { query: string } | string, options?: { enabled?: boolean }) => {
        const q = typeof params === 'string' ? params : params.query;
        capturedQueries.push(q);
        capturedOptions.push(options ?? {});
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      renderHook(() => useAccountOverview({
        provider: 'GCP',
        credentialEntityId: null,
        subscriptionEntityId: null,
        accountId: 'my-gcp-project',
      }));

      // built-in query should be empty string → disabled
      const builtInCall = capturedOptions[0];
      expect(builtInCall.enabled).toBe(false);
    });

    it('GCP custom device query uses project_id == accountId', () => {
      const capturedQueries: string[] = [];
      mockUseDql.mockImplementation((params: { query: string } | string) => {
        const q = typeof params === 'string' ? params : params.query;
        capturedQueries.push(q);
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      renderHook(() => useAccountOverview({
        provider: 'GCP',
        credentialEntityId: null,
        subscriptionEntityId: null,
        accountId: 'my-gcp-project',
      }));

      const customDevice = capturedQueries.find((q) => q.includes('custom_device'));
      expect(customDevice).toBeDefined();
      expect(customDevice).toContain('cloud:gcp');
      expect(customDevice).toContain('project_id');
      expect(customDevice).toContain('my-gcp-project');
      expect(customDevice).not.toContain('accessible_by');
    });
  });

  // ── Metric count query ─────────────────────────────────────────────────

  describe('metric count query', () => {
    it('metric count query groups by metric.key for distinct key count', () => {
      const capturedQueries: string[] = [];
      mockUseDql.mockImplementation((params: { query: string } | string) => {
        const q = typeof params === 'string' ? params : params.query;
        capturedQueries.push(q);
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      const metricQuery = capturedQueries.find((q) => q.includes('metric.series'));
      expect(metricQuery).toBeDefined();
      expect(metricQuery).toContain('summarize count(), by:{metric.key}');
    });

    it('metric count uses all AWS classic metric prefixes', () => {
      const capturedQueries: string[] = [];
      mockUseDql.mockImplementation((params: { query: string } | string) => {
        const q = typeof params === 'string' ? params : params.query;
        capturedQueries.push(q);
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      const metricQuery = capturedQueries.find((q) => q.includes('metric.series'))!;
      for (const prefix of CLASSIC_METRIC_PREFIXES.AWS) {
        expect(metricQuery).toContain(prefix);
      }
    });

    it('returns metricKeyCount equal to the number of records (one per distinct key)', () => {
      setupDqlMock({
        metricCountResult: makeDqlResult([
          { 'metric.key': 'dt.cloud.aws.ec2.cpu', 'count()': 120 },
          { 'metric.key': 'dt.cloud.aws.lambda.invocations', 'count()': 60 },
          { 'metric.key': 'dt.cloud.aws.rds.connections', 'count()': 80 },
        ]),
      });

      const { result } = renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      expect(result.current.metricKeyCount).toBe(3);
    });

    it('returns metricKeyCount of 0 when metric query returns no records', () => {
      setupDqlMock({ metricCountResult: makeDqlResult([]) });

      const { result } = renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      expect(result.current.metricKeyCount).toBe(0);
    });
  });

  // ── Entity result merging ───────────────────────────────────────────────

  describe('entity result merging', () => {
    it('merges built-in and custom device results into a single entities array', () => {
      setupDqlMock({
        builtInResult: makeDqlResult([
          { 'entity.type': 'EC2_INSTANCE', 'count()': 10 },
          { 'entity.type': 'AWS_LAMBDA_FUNCTION', 'count()': 5 },
        ]),
        customDeviceResult: makeDqlResult([
          { 'entity.type': 'cloud:aws:s3', cnt: 3 },
        ]),
      });

      const { result } = renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      const types = result.current.entities.map((e) => e.entityType);
      expect(types).toContain('EC2_INSTANCE');
      expect(types).toContain('AWS_LAMBDA_FUNCTION');
      expect(types).toContain('cloud:aws:s3');
    });

    it('merges EBS volume count from fallback into entities', () => {
      setupDqlMock({
        builtInResult: makeDqlResult([{ 'entity.type': 'EC2_INSTANCE', 'count()': 10 }]),
        fallbackResult: makeDqlResult([{ 'entity.type': 'EBS_VOLUME', 'count()': 42 }]),
      });

      const { result } = renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      const ebs = result.current.entities.find((e) => e.entityType === 'EBS_VOLUME');
      expect(ebs).toBeDefined();
      expect(ebs!.count).toBe(42);
    });

    it('includes zero-count entities (consumer filters them)', () => {
      setupDqlMock({
        builtInResult: makeDqlResult([
          { 'entity.type': 'EC2_INSTANCE', 'count()': 0 },
          { 'entity.type': 'AWS_LAMBDA_FUNCTION', 'count()': 5 },
        ]),
      });

      const { result } = renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      const zero = result.current.entities.find((e) => e.entityType === 'EC2_INSTANCE');
      expect(zero).toBeDefined();
      expect(zero!.count).toBe(0);
    });
  });

  // ── Loading & error states ──────────────────────────────────────────────

  describe('loading and error states', () => {
    it('reports entityLoading true when any entity query is loading', () => {
      mockUseDql.mockImplementation((params: { query: string } | string) => {
        const q = typeof params === 'string' ? params : params.query;
        if (q.includes('accessible_by') && !q.includes('custom_device') && !q.includes('metric.series') && !q.includes('belongs_to')) {
          return makeLoadingResult() as ReturnType<typeof useDql>;
        }
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      const { result } = renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      expect(result.current.entityLoading).toBe(true);
    });

    it('reports metricLoading true when metric query is loading', () => {
      mockUseDql.mockImplementation((params: { query: string } | string) => {
        const q = typeof params === 'string' ? params : params.query;
        if (q.includes('metric.series')) return makeLoadingResult() as ReturnType<typeof useDql>;
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      const { result } = renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      expect(result.current.metricLoading).toBe(true);
    });

    it('exposes entityError when a DQL query fails', () => {
      mockUseDql.mockImplementation((params: { query: string } | string) => {
        const q = typeof params === 'string' ? params : params.query;
        if (q.includes('accessible_by') && !q.includes('custom_device') && !q.includes('metric.series') && !q.includes('belongs_to')) {
          return makeErrorResult('DQL_ERROR') as ReturnType<typeof useDql>;
        }
        return makeDqlResult([]) as ReturnType<typeof useDql>;
      });

      const { result } = renderHook(() => useAccountOverview({
        provider: 'AWS',
        credentialEntityId: 'AWS_CREDENTIALS-ABC123',
        subscriptionEntityId: null,
        accountId: '123456789012',
      }));

      expect(result.current.entityError).not.toBeNull();
      expect(result.current.entityError?.message).toBe('DQL_ERROR');
    });
  });
});

// ─── buildMetricKeyListQuery ─────────────────────────────────────────────────

describe('buildMetricKeyListQuery', () => {
  it('uses summarize by:{metric.key} (not count) for distinct key listing', () => {
    const q = buildMetricKeyListQuery('AWS');
    expect(q).toContain('summarize by:{metric.key}');
    expect(q).not.toContain('summarize count()');
  });

  it('sorts by metric.key asc', () => {
    const q = buildMetricKeyListQuery('AWS');
    expect(q).toContain('sort metric.key asc');
  });

  it('includes all AWS classic metric prefixes', () => {
    const q = buildMetricKeyListQuery('AWS');
    for (const prefix of CLASSIC_METRIC_PREFIXES.AWS) {
      expect(q).toContain(prefix);
    }
  });

  it('includes all Azure classic metric prefixes', () => {
    const q = buildMetricKeyListQuery('Azure');
    for (const prefix of CLASSIC_METRIC_PREFIXES.Azure) {
      expect(q).toContain(prefix);
    }
  });

  it('includes all GCP classic metric prefixes', () => {
    const q = buildMetricKeyListQuery('GCP');
    for (const prefix of CLASSIC_METRIC_PREFIXES.GCP) {
      expect(q).toContain(prefix);
    }
  });
});
