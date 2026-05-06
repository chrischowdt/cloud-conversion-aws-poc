import { renderHook } from '@testing-library/react';
import { useDql } from '@dynatrace-sdk/react-hooks';

import { useCloudAccountInventory } from './useConnectionInventory';

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
    refetch: jest.fn(),
    cancel: jest.fn(),
  };
}

/**
 * Route mock responses by query content.
 * Each query string is unique enough to identify the provider + direction.
 */
function setupDqlMock({
  awsClassicResult = makeDqlResult([]),
  azureClassicResult = makeDqlResult([]),
  gcpClassicResult = makeDqlResult([]),
  awsNewResult = makeDqlResult([]),
  azureNewResult = makeDqlResult([]),
  gcpNewResult = makeDqlResult([]),
  awsMetricStreamsResult = makeDqlResult([]),
} = {}) {
  mockUseDql.mockImplementation(({ query }: { query: string }) => {
    if (query.includes('aws_credentials')) return awsClassicResult;
    if (query.includes('azure_credentials')) return azureClassicResult;
    if (query.includes('gcp:project')) return gcpClassicResult;
    if (query.includes('AWS_ACCOUNT')) return awsNewResult;
    if (query.includes('AZURE_MICROSOFT')) return azureNewResult;
    if (query.includes('GCP_CLOUDRESOURCE')) return gcpNewResult;
    if (query.includes('AWS Metric Streams')) return awsMetricStreamsResult;
    return makeDqlResult([]);
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useCloudAccountInventory', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('status badge derivation', () => {
    it('assigns Classic to accounts with only a classic connection', () => {
      setupDqlMock({
        awsClassicResult: makeDqlResult([
          { id: 'AWS_CRED-1', 'entity.name': 'Prod AWS', awsAccountId: '111111111111' },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      const awsAccount = result.current.accounts.find((a) => a.provider === 'AWS');
      expect(awsAccount).toBeDefined();
      expect(awsAccount!.status).toBe('Classic');
      expect(awsAccount!.accountId).toBe('111111111111');
      expect(awsAccount!.name).toBe('Prod AWS');
    });

    it('assigns New to accounts with only a Smartscape new connection', () => {
      setupDqlMock({
        awsNewResult: makeDqlResult([
          { id: 'AWS_ACCOUNT-1', name: 'New AWS Account', 'aws.account.id': '222222222222' },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      const awsAccount = result.current.accounts.find((a) => a.provider === 'AWS');
      expect(awsAccount).toBeDefined();
      expect(awsAccount!.status).toBe('New');
      expect(awsAccount!.accountId).toBe('222222222222');
      expect(awsAccount!.entityId).toBeNull();
    });

    it('assigns Parallel when the same AWS account ID appears in both classic and new', () => {
      setupDqlMock({
        awsClassicResult: makeDqlResult([
          { id: 'AWS_CRED-1', 'entity.name': 'My AWS Cred', awsAccountId: '123456789012' },
        ]),
        awsNewResult: makeDqlResult([
          { id: 'AWS_ACCOUNT-1', name: 'My AWS Account', 'aws.account.id': '123456789012' },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      const awsAccounts = result.current.accounts.filter((a) => a.provider === 'AWS');
      // Classic credential row should be marked Parallel; new-only row should not appear
      expect(awsAccounts).toHaveLength(1);
      expect(awsAccounts[0].status).toBe('Parallel');
    });

    it('assigns Parallel for Azure when subscription UUID matches', () => {
      const subUuid = 'aaaa-bbbb-cccc-dddd';
      setupDqlMock({
        azureClassicResult: makeDqlResult([
          {
            id: 'AZURE_CRED-1',
            'entity.name': 'My Azure Cred',
            sub_id: 'AZURE_SUB-1',
            'sub.azureSubscriptionUuid': subUuid,
          },
        ]),
        azureNewResult: makeDqlResult([
          { id: 'AZURE_SS-1', name: 'My Azure Sub', 'azure.subscription': subUuid },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      const azureAccounts = result.current.accounts.filter((a) => a.provider === 'Azure');
      expect(azureAccounts).toHaveLength(1);
      expect(azureAccounts[0].status).toBe('Parallel');
    });

    it('assigns Parallel for GCP when gcp.project.id matches entity.name', () => {
      setupDqlMock({
        gcpClassicResult: makeDqlResult([
          { id: 'GCP_PROJ-1', 'entity.name': 'my-gcp-project' },
        ]),
        gcpNewResult: makeDqlResult([
          { id: 'GCP_SS-1', name: 'My GCP Project Display', 'gcp.project.id': 'my-gcp-project' },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      const gcpAccounts = result.current.accounts.filter((a) => a.provider === 'GCP');
      expect(gcpAccounts).toHaveLength(1);
      expect(gcpAccounts[0].status).toBe('Parallel');
    });
  });

  describe('Azure null subscription edge case', () => {
    it('includes an Azure classic credential with null sub.azureSubscriptionUuid, with accountId set to null', () => {
      setupDqlMock({
        azureClassicResult: makeDqlResult([
          {
            id: 'AZURE_CRED-LEGACY',
            'entity.name': 'Legacy Azure Cred',
            sub_id: null,
            'sub.azureSubscriptionUuid': null, // no linked subscription
          },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      const azureAccounts = result.current.accounts.filter((a) => a.provider === 'Azure');
      expect(azureAccounts).toHaveLength(1);
      expect(azureAccounts[0].accountId).toBeNull();
      expect(azureAccounts[0].status).toBe('Classic');
      expect(azureAccounts[0].name).toBe('Legacy Azure Cred');
    });
  });

  describe('duplicate AWS account IDs edge case', () => {
    it('emits both rows and flags hasDuplicateAccountId on each', () => {
      setupDqlMock({
        awsClassicResult: makeDqlResult([
          { id: 'AWS_CRED-1', 'entity.name': 'Cred One', awsAccountId: '999999999999' },
          { id: 'AWS_CRED-2', 'entity.name': 'Cred Two', awsAccountId: '999999999999' },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      const awsAccounts = result.current.accounts.filter((a) => a.provider === 'AWS');
      expect(awsAccounts).toHaveLength(2);
      expect(awsAccounts[0].hasDuplicateAccountId).toBe(true);
      expect(awsAccounts[1].hasDuplicateAccountId).toBe(true);
    });

    it('does not flag hasDuplicateAccountId when account IDs are unique', () => {
      setupDqlMock({
        awsClassicResult: makeDqlResult([
          { id: 'AWS_CRED-1', 'entity.name': 'Cred One', awsAccountId: '111111111111' },
          { id: 'AWS_CRED-2', 'entity.name': 'Cred Two', awsAccountId: '222222222222' },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      const awsAccounts = result.current.accounts.filter((a) => a.provider === 'AWS');
      expect(awsAccounts).toHaveLength(2);
      awsAccounts.forEach((a) => expect(a.hasDuplicateAccountId).toBe(false));
    });
  });

  describe('new-only accounts do not appear as duplicate rows', () => {
    it('does not add a New-only row when the account ID already has a Classic row', () => {
      setupDqlMock({
        awsClassicResult: makeDqlResult([
          { id: 'AWS_CRED-1', 'entity.name': 'My Classic Cred', awsAccountId: '777777777777' },
        ]),
        awsNewResult: makeDqlResult([
          { id: 'AWS_ACCOUNT-1', name: 'Smartscape Account', 'aws.account.id': '777777777777' },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      const awsAccounts = result.current.accounts.filter((a) => a.provider === 'AWS');
      // Should be one row (Classic credential, marked Parallel) — not two rows
      expect(awsAccounts).toHaveLength(1);
      expect(awsAccounts[0].status).toBe('Parallel');
    });
  });

  describe('loading state', () => {
    it('reports isLoading true when any query is in-flight', () => {
      setupDqlMock({ awsClassicResult: makeLoadingResult() });

      const { result } = renderHook(() => useCloudAccountInventory());

      expect(result.current.isLoading).toBe(true);
    });

    it('reports isLoading false when all seven queries are complete', () => {
      setupDqlMock(); // all default to makeDqlResult([]) — isLoading: false

      const { result } = renderHook(() => useCloudAccountInventory());

      expect(result.current.isLoading).toBe(false);
    });
  });

  describe('per-provider error state', () => {
    it('surfaces an error on aws.error when an AWS query fails', () => {
      setupDqlMock({
        awsClassicResult: makeErrorResult('AWS DQL failed'),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      expect(result.current.aws.error).not.toBeNull();
      expect(result.current.aws.error?.message).toBe('AWS DQL failed');
    });

    it('keeps azure and gcp data intact when only AWS errors', () => {
      setupDqlMock({
        awsClassicResult: makeErrorResult('AWS error'),
        azureClassicResult: makeDqlResult([
          {
            id: 'AZURE_CRED-1',
            'entity.name': 'Azure Cred',
            sub_id: 'AZURE_SUB-1',
            'sub.azureSubscriptionUuid': 'sub-uuid-1',
          },
        ]),
        gcpClassicResult: makeDqlResult([
          { id: 'GCP_PROJ-1', 'entity.name': 'my-project' },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      expect(result.current.aws.error).not.toBeNull();
      expect(result.current.azure.error).toBeNull();
      expect(result.current.gcp.error).toBeNull();

      const azureAccounts = result.current.accounts.filter((a) => a.provider === 'Azure');
      const gcpAccounts = result.current.accounts.filter((a) => a.provider === 'GCP');
      expect(azureAccounts).toHaveLength(1);
      expect(gcpAccounts).toHaveLength(1);
    });
  });

  describe('per-provider inventory shape', () => {
    it('populates aws.data with classicConnections and newConnections', () => {
      setupDqlMock({
        awsClassicResult: makeDqlResult([
          { id: 'AWS_CRED-1', 'entity.name': 'Classic AWS', awsAccountId: '100000000001' },
        ]),
        awsNewResult: makeDqlResult([
          { id: 'AWS_SS-1', name: 'New AWS', 'aws.account.id': '100000000002' },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      expect(result.current.aws.data?.classicConnections).toHaveLength(1);
      expect(result.current.aws.data?.newConnections).toHaveLength(1);
    });

    it('sets parallelIngestion on aws.data when account IDs overlap', () => {
      const sharedId = '555555555555';
      setupDqlMock({
        awsClassicResult: makeDqlResult([
          { id: 'AWS_CRED-1', 'entity.name': 'Parallel AWS', awsAccountId: sharedId },
        ]),
        awsNewResult: makeDqlResult([
          { id: 'AWS_SS-1', name: 'Parallel New', 'aws.account.id': sharedId },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      expect(result.current.aws.data?.parallelIngestion?.overlappingAccountIds).toContain(sharedId);
    });
  });

  describe('isMigrationBlocked — AWS Metric Streams detection', () => {
    it('flags isMigrationBlocked on a classic AWS row when its account ID appears in Metric Streams results', () => {
      setupDqlMock({
        awsClassicResult: makeDqlResult([
          { id: 'AWS_CRED-1', 'entity.name': 'Streams Account', awsAccountId: '123000000000' },
        ]),
        awsMetricStreamsResult: makeDqlResult([
          { 'aws.account.id': '123000000000', cnt: 100 },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      const awsAccount = result.current.accounts.find((a) => a.provider === 'AWS');
      expect(awsAccount).toBeDefined();
      expect(awsAccount!.isMigrationBlocked).toBe(true);
    });

    it('does not flag isMigrationBlocked when the account ID is absent from Metric Streams results', () => {
      setupDqlMock({
        awsClassicResult: makeDqlResult([
          { id: 'AWS_CRED-1', 'entity.name': 'Polling Account', awsAccountId: '444000000000' },
        ]),
        awsMetricStreamsResult: makeDqlResult([
          { 'aws.account.id': '999000000000', cnt: 50 }, // different account
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      const awsAccount = result.current.accounts.find((a) => a.provider === 'AWS');
      expect(awsAccount!.isMigrationBlocked).toBe(false);
    });

    it('does not flag isMigrationBlocked when Metric Streams query returns empty results', () => {
      setupDqlMock({
        awsClassicResult: makeDqlResult([
          { id: 'AWS_CRED-1', 'entity.name': 'Polling Account', awsAccountId: '444000000000' },
        ]),
        // awsMetricStreamsResult defaults to makeDqlResult([])
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      const awsAccount = result.current.accounts.find((a) => a.provider === 'AWS');
      expect(awsAccount!.isMigrationBlocked).toBe(false);
    });

    it('does not flag isMigrationBlocked on non-AWS rows', () => {
      setupDqlMock({
        azureClassicResult: makeDqlResult([
          {
            id: 'AZURE_CRED-1',
            'entity.name': 'Azure Cred',
            sub_id: 'AZURE_SUB-1',
            'sub.azureSubscriptionUuid': 'sub-uuid-azure',
          },
        ]),
        gcpClassicResult: makeDqlResult([
          { id: 'GCP_PROJ-1', 'entity.name': 'my-gcp-project' },
        ]),
      });

      const { result } = renderHook(() => useCloudAccountInventory());

      const nonAwsAccounts = result.current.accounts.filter((a) => a.provider !== 'AWS');
      nonAwsAccounts.forEach((a) => expect(a.isMigrationBlocked).toBe(false));
    });

    it('reports isLoading true while the Metric Streams query is in-flight', () => {
      setupDqlMock({ awsMetricStreamsResult: makeLoadingResult() });

      const { result } = renderHook(() => useCloudAccountInventory());

      expect(result.current.isLoading).toBe(true);
    });
  });

  describe('timeframe parameter', () => {
    it('defaults to 12h timeframe', () => {
      setupDqlMock();
      const queriesUsed: string[] = [];
      mockUseDql.mockImplementation(({ query }: { query: string }) => {
        queriesUsed.push(query);
        return makeDqlResult([]);
      });

      renderHook(() => useCloudAccountInventory());

      expect(queriesUsed.some((q) => q.includes('now()-12h'))).toBe(true);
    });

    it('uses the provided timeframe in all queries', () => {
      setupDqlMock();
      const queriesUsed: string[] = [];
      mockUseDql.mockImplementation(({ query }: { query: string }) => {
        queriesUsed.push(query);
        return makeDqlResult([]);
      });

      renderHook(() => useCloudAccountInventory('7d'));

      const allUse7d = queriesUsed.every((q) => q.includes('now()-7d'));
      expect(allUse7d).toBe(true);
    });
  });
});
