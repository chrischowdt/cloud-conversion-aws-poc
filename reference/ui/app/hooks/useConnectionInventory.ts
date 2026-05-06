import { useMemo } from 'react';
import { useDql } from '@dynatrace-sdk/react-hooks';

import type {
  AwsInventory,
  AzureInventory,
  GcpInventory,
  CloudAccount,
  ClassicAwsConnection,
  NewAwsConnection,
  ClassicAzureConnection,
  NewAzureConnection,
  ClassicGcpConnection,
  NewGcpConnection,
  InventoryTimeframe,
} from '../types/connection';

// ─── Query string builders ────────────────────────────────────────────────────
// All query strings are built inside the hook as useMemo values so they update
// when the user changes the timeframe. useDql re-executes whenever the query
// string value changes.

// ─── Return types ─────────────────────────────────────────────────────────────

type ProviderState<T> = {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
};

export type CloudAccountInventory = {
  /** Per-provider state — consumed by Home.tsx */
  aws: ProviderState<AwsInventory>;
  azure: ProviderState<AzureInventory>;
  gcp: ProviderState<GcpInventory>;
  /** Flat merged list of all cloud accounts — consumed by Inventory.tsx */
  accounts: CloudAccount[];
  /** True if ANY of the 6 queries is still in-flight */
  isLoading: boolean;
  refetch: () => void;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useCloudAccountInventory(timeframe: InventoryTimeframe = '12h'): CloudAccountInventory {
  // ── Query strings (recomputed only when timeframe changes) ───────────────────
  // §11.1 — AWS classic
  const awsClassicQuery = useMemo(
    () => `fetch dt.entity.aws_credentials, from:now()-${timeframe}
| fieldsAdd awsAccountId, entity.name, id, lifetime
| fieldsRemove can_access`,
    [timeframe]
  );

  // §11.2 — Azure classic: inline lookup to resolve subscription UUID
  const azureClassicQuery = useMemo(
    () => `fetch dt.entity.azure_credentials, from:now()-${timeframe}
| fieldsAdd entity.name, id, belongs_to
| fieldsRemove can_access
| fieldsAdd sub_id = belongs_to[\`dt.entity.azure_subscription\`][0]
| lookup [fetch dt.entity.azure_subscription | fieldsAdd azureSubscriptionUuid],
    sourceField:sub_id, lookupField:id, prefix:"sub."
| fields entity.name, id, sub_id, sub.azureSubscriptionUuid`,
    [timeframe]
  );

  // §11.3 — GCP classic
  const gcpClassicQuery = useMemo(
    () => `fetch \`dt.entity.cloud:gcp:project\`, from:now()-${timeframe}
| fields entity.name, id, lifetime`,
    [timeframe]
  );

  // §12.1 — AWS new: Smartscape entity
  const awsNewQuery = useMemo(
    () => `smartscapeNodes AWS_ACCOUNT, from:now()-${timeframe}
| fields id, name, \`aws.account.id\``,
    [timeframe]
  );

  // §12.2 — Azure new: Smartscape entity
  const azureNewQuery = useMemo(
    () => `smartscapeNodes AZURE_MICROSOFT_RESOURCES_SUBSCRIPTIONS, from:now()-${timeframe}
| fields id, name, \`azure.subscription\``,
    [timeframe]
  );

  // §12.3 — GCP new: gcp.project.id is the slug (join key); name is the display name
  const gcpNewQuery = useMemo(
    () => `smartscapeNodes GCP_CLOUDRESOURCEMANAGER_GOOGLEAPIS_COM_PROJECT, from:now()-${timeframe}
| fields id, name, \`gcp.project.id\``,
    [timeframe]
  );

  // §1.3 — AWS Metric Streams detection: per-account IDs with active Metric Streams traffic.
  // aws.account.id is a confirmed dimension on metric.series records (dtctl-verified 2026-04-09).
  // Note: uses the same timeframe as other queries — if the Firehose was paused longer than the
  // selected window, no accounts will be flagged (intentional: "omit if no evidence" rule).
  const awsMetricStreamsQuery = useMemo(
    () => `fetch metric.series, from:now()-${timeframe}
| filter dt.source == "AWS Metric Streams"
| summarize cnt=count(), by:\`aws.account.id\``,
    [timeframe]
  );

  // All seven queries fire in parallel on mount — hooks must be called unconditionally
  const awsClassicDql = useDql({ query: awsClassicQuery });
  const azureClassicDql = useDql({ query: azureClassicQuery });
  const gcpClassicDql = useDql({ query: gcpClassicQuery });
  const awsNewDql = useDql({ query: awsNewQuery });
  const azureNewDql = useDql({ query: azureNewQuery });
  const gcpNewDql = useDql({ query: gcpNewQuery });
  const awsMetricStreamsDql = useDql({ query: awsMetricStreamsQuery });

  // ── Parse classic connections ──────────────────────────────────────────────

  const awsClassicConnections = useMemo((): ClassicAwsConnection[] => {
    return (awsClassicDql.data?.records ?? []).map((r) => ({
      entityId: asString(r['id']),
      name: asString(r['entity.name']),
      accountId: asStringOrNull(r['awsAccountId']),
    }));
  }, [awsClassicDql.data]);

  const azureClassicConnections = useMemo((): ClassicAzureConnection[] => {
    return (azureClassicDql.data?.records ?? []).map((r) => ({
      entityId: asString(r['id']),
      name: asString(r['entity.name']),
      accountId: asStringOrNull(r['sub.azureSubscriptionUuid']),
      subscriptionEntityId: asStringOrNull(r['sub_id']),
    }));
  }, [azureClassicDql.data]);

  const gcpClassicConnections = useMemo((): ClassicGcpConnection[] => {
    return (gcpClassicDql.data?.records ?? []).map((r) => ({
      entityId: asString(r['id']),
      // entity.name IS the GCP project ID for dt.entity.cloud:gcp:project
      name: asString(r['entity.name']),
      accountId: asString(r['entity.name']),
    }));
  }, [gcpClassicDql.data]);

  // ── Parse new connections (Smartscape) ────────────────────────────────────

  const awsNewConnections = useMemo((): NewAwsConnection[] => {
    return (awsNewDql.data?.records ?? []).map((r) => ({
      entityId: asString(r['id']),
      name: asString(r['name']),
      accountId: asString(r['aws.account.id']),
    }));
  }, [awsNewDql.data]);

  const azureNewConnections = useMemo((): NewAzureConnection[] => {
    return (azureNewDql.data?.records ?? []).map((r) => ({
      entityId: asString(r['id']),
      name: asString(r['name']),
      accountId: asString(r['azure.subscription']),
    }));
  }, [azureNewDql.data]);

  const gcpNewConnections = useMemo((): NewGcpConnection[] => {
    return (gcpNewDql.data?.records ?? []).map((r) => ({
      entityId: asString(r['id']),
      name: asString(r['name']),
      // gcp.project.id is the slug (join key); NOT the name field
      accountId: asString(r['gcp.project.id']),
    }));
  }, [gcpNewDql.data]);

  // ── Build per-provider inventories ────────────────────────────────────────

  const awsInventory = useMemo((): AwsInventory | null => {
    const hasData = awsClassicDql.data !== undefined || awsNewDql.data !== undefined;
    const hasError = !!awsClassicDql.error || !!awsNewDql.error;
    if (!hasData && !hasError) return null;

    const classicIds = new Set(
      awsClassicConnections.map((c) => c.accountId).filter((id): id is string => id !== null)
    );
    const newIds = new Set(awsNewConnections.map((c) => c.accountId));
    const overlappingAccountIds = [...classicIds].filter((id) => newIds.has(id));

    return {
      classicConnections: awsClassicConnections,
      newConnections: awsNewConnections,
      parallelIngestion: overlappingAccountIds.length > 0 ? { overlappingAccountIds } : undefined,
    };
  }, [
    awsClassicConnections,
    awsNewConnections,
    awsClassicDql.data,
    awsNewDql.data,
    awsClassicDql.error,
    awsNewDql.error,
  ]);

  const azureInventory = useMemo((): AzureInventory | null => {
    const hasData = azureClassicDql.data !== undefined || azureNewDql.data !== undefined;
    const hasError = !!azureClassicDql.error || !!azureNewDql.error;
    if (!hasData && !hasError) return null;

    const classicIds = new Set(
      azureClassicConnections.map((c) => c.accountId).filter((id): id is string => id !== null)
    );
    const newIds = new Set(azureNewConnections.map((c) => c.accountId));
    const overlappingAccountIds = [...classicIds].filter((id) => newIds.has(id));

    return {
      classicConnections: azureClassicConnections,
      newConnections: azureNewConnections,
      parallelIngestion: overlappingAccountIds.length > 0 ? { overlappingAccountIds } : undefined,
    };
  }, [
    azureClassicConnections,
    azureNewConnections,
    azureClassicDql.data,
    azureNewDql.data,
    azureClassicDql.error,
    azureNewDql.error,
  ]);

  const gcpInventory = useMemo((): GcpInventory | null => {
    const hasData = gcpClassicDql.data !== undefined || gcpNewDql.data !== undefined;
    const hasError = !!gcpClassicDql.error || !!gcpNewDql.error;
    if (!hasData && !hasError) return null;

    const classicIds = new Set(gcpClassicConnections.map((c) => c.accountId));
    const newIds = new Set(gcpNewConnections.map((c) => c.accountId));
    const overlappingAccountIds = [...classicIds].filter((id) => newIds.has(id));

    return {
      classicConnections: gcpClassicConnections,
      newConnections: gcpNewConnections,
      parallelIngestion: overlappingAccountIds.length > 0 ? { overlappingAccountIds } : undefined,
    };
  }, [
    gcpClassicConnections,
    gcpNewConnections,
    gcpClassicDql.data,
    gcpNewDql.data,
    gcpClassicDql.error,
    gcpNewDql.error,
  ]);

  // ── Build flat CloudAccount list ──────────────────────────────────────────

  // Metric Streams: set of AWS account IDs with active Metric Streams traffic in the window.
  // Query failure is treated as empty set (safe default under "omit if no evidence" rule).
  const metricStreamsAccountIds = useMemo((): Set<string> => {
    return new Set(
      (awsMetricStreamsDql.data?.records ?? [])
        .map((r) => asString(r['aws.account.id']))
        .filter((id) => id !== '')
    );
  }, [awsMetricStreamsDql.data]);

  const accounts = useMemo((): CloudAccount[] => {
    const result: CloudAccount[] = [];

    // AWS: detect duplicate account IDs across classic credentials
    const awsAccountIdCount = new Map<string, number>();
    for (const c of awsClassicConnections) {
      if (c.accountId) {
        awsAccountIdCount.set(c.accountId, (awsAccountIdCount.get(c.accountId) ?? 0) + 1);
      }
    }
    const awsNewIds = new Set(awsNewConnections.map((c) => c.accountId));
    const awsClassicIds = new Set(
      awsClassicConnections.map((c) => c.accountId).filter((id): id is string => id !== null)
    );

    // Classic AWS rows (possibly with parallel status)
    for (const c of awsClassicConnections) {
      const isParallel = c.accountId !== null && awsNewIds.has(c.accountId);
      result.push({
        provider: 'AWS',
        name: c.name,
        accountId: c.accountId,
        status: isParallel ? 'Parallel' : 'Classic',
        entityId: c.entityId,
        subscriptionEntityId: null,
        hasDuplicateAccountId: c.accountId !== null && (awsAccountIdCount.get(c.accountId) ?? 0) > 1,
        isMigrationBlocked: c.accountId !== null && metricStreamsAccountIds.has(c.accountId),
      });
    }

    // New-only AWS rows (no matching classic credential)
    for (const c of awsNewConnections) {
      if (!awsClassicIds.has(c.accountId)) {
        result.push({
          provider: 'AWS',
          name: c.name,
          accountId: c.accountId,
          status: 'New',
          entityId: null,
          subscriptionEntityId: null,
          hasDuplicateAccountId: false,
          isMigrationBlocked: false,
        });
      }
    }

    // Azure
    const azureNewIds = new Set(azureNewConnections.map((c) => c.accountId));
    const azureClassicIds = new Set(
      azureClassicConnections.map((c) => c.accountId).filter((id): id is string => id !== null)
    );

    for (const c of azureClassicConnections) {
      const isParallel = c.accountId !== null && azureNewIds.has(c.accountId);
      result.push({
        provider: 'Azure',
        name: c.name,
        accountId: c.accountId,
        status: isParallel ? 'Parallel' : 'Classic',
        entityId: c.entityId,
        subscriptionEntityId: c.subscriptionEntityId,
        hasDuplicateAccountId: false,
        isMigrationBlocked: false,
      });
    }

    for (const c of azureNewConnections) {
      if (!c.accountId || !azureClassicIds.has(c.accountId)) {
        result.push({
          provider: 'Azure',
          name: c.name,
          accountId: c.accountId || null,
          status: 'New',
          entityId: null,
          subscriptionEntityId: null,
          hasDuplicateAccountId: false,
          isMigrationBlocked: false,
        });
      }
    }

    // GCP
    const gcpNewIds = new Set(gcpNewConnections.map((c) => c.accountId));
    const gcpClassicIds = new Set(gcpClassicConnections.map((c) => c.accountId));

    for (const c of gcpClassicConnections) {
      const isParallel = gcpNewIds.has(c.accountId);
      result.push({
        provider: 'GCP',
        name: c.name,
        accountId: c.accountId,
        status: isParallel ? 'Parallel' : 'Classic',
        entityId: c.entityId,
        subscriptionEntityId: null,
        hasDuplicateAccountId: false,
        isMigrationBlocked: false,
      });
    }

    for (const c of gcpNewConnections) {
      if (!gcpClassicIds.has(c.accountId)) {
        result.push({
          provider: 'GCP',
          name: c.name,
          accountId: c.accountId,
          status: 'New',
          entityId: null,
          subscriptionEntityId: null,
          hasDuplicateAccountId: false,
          isMigrationBlocked: false,
        });
      }
    }

    return result;
  }, [
    awsClassicConnections,
    awsNewConnections,
    azureClassicConnections,
    azureNewConnections,
    gcpClassicConnections,
    gcpNewConnections,
    metricStreamsAccountIds,
  ]);

  // ── Aggregate states ──────────────────────────────────────────────────────

  const isLoading =
    awsClassicDql.isLoading ||
    azureClassicDql.isLoading ||
    gcpClassicDql.isLoading ||
    awsNewDql.isLoading ||
    azureNewDql.isLoading ||
    gcpNewDql.isLoading ||
    awsMetricStreamsDql.isLoading;

  function refetch() {
    void awsClassicDql.refetch();
    void azureClassicDql.refetch();
    void gcpClassicDql.refetch();
    void awsNewDql.refetch();
    void azureNewDql.refetch();
    void gcpNewDql.refetch();
    void awsMetricStreamsDql.refetch();
  }

  return {
    aws: {
      data: awsInventory,
      isLoading: awsClassicDql.isLoading || awsNewDql.isLoading,
      error: awsClassicDql.error ?? awsNewDql.error,
    },
    azure: {
      data: azureInventory,
      isLoading: azureClassicDql.isLoading || azureNewDql.isLoading,
      error: azureClassicDql.error ?? azureNewDql.error,
    },
    gcp: {
      data: gcpInventory,
      isLoading: gcpClassicDql.isLoading || gcpNewDql.isLoading,
      error: gcpClassicDql.error ?? gcpNewDql.error,
    },
    accounts,
    isLoading,
    refetch,
  };
}
