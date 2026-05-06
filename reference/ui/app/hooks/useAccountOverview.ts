import { useMemo } from 'react';
import { useDql } from '@dynatrace-sdk/react-hooks';

import type { CloudProvider } from '../types/connection';
import { CLASSIC_ENTITY_TYPES, CLASSIC_METRIC_PREFIXES } from '../utils/classicPatterns';

// ─── Types ────────────────────────────────────────────────────────────────────

export type EntityTypeSummary = {
  entityType: string;
  count: number;
};

export type UseAccountOverviewResult = {
  entities: EntityTypeSummary[];
  entityLoading: boolean;
  entityError: Error | null;
  refetchEntities: () => void;
  metricKeyCount: number;
  metricLoading: boolean;
  metricError: Error | null;
  refetchMetrics: () => void;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

// ─── Query builders ───────────────────────────────────────────────────────────

// AWS built-in types that support accessible_by[dt.entity.aws_credentials].
// ebs_volume is excluded because the field is absent — it goes to fallbackQuery instead.
// See docs/dql-patterns.md §6 preamble for accessible_by availability notes.
const AWS_SCOPED_TYPES = CLASSIC_ENTITY_TYPES.AWS.filter((t) => t !== 'ebs_volume');

function buildAwsBuiltInQuery(credentialEntityId: string | null): string {
  if (!credentialEntityId) return '';

  const credFilter = `in("${credentialEntityId}", accessible_by[\`dt.entity.aws_credentials\`])`;
  const [first, ...rest] = AWS_SCOPED_TYPES;
  let q = `fetch dt.entity.${first}\n| filter ${credFilter}`;
  for (const type of rest) {
    q += `\n| append [\n    fetch dt.entity.${type}\n    | filter ${credFilter}\n  ]`;
  }
  q += '\n| summarize count(), by:{entity.type}';
  return q;
}

function buildAzureBuiltInQuery(subscriptionEntityId: string | null): string {
  if (!subscriptionEntityId) return '';

  const subFilter = `in("${subscriptionEntityId}", accessible_by[\`dt.entity.azure_subscription\`])`;
  const [first, ...rest] = CLASSIC_ENTITY_TYPES.Azure;
  let q = `fetch dt.entity.${first}\n| filter ${subFilter}`;
  for (const type of rest) {
    q += `\n| append [\n    fetch dt.entity.${type}\n    | filter ${subFilter}\n  ]`;
  }
  q += '\n| summarize count(), by:{entity.type}';
  return q;
}

function buildCustomDeviceQuery(
  provider: CloudProvider,
  credentialEntityId: string | null,
  subscriptionEntityId: string | null,
  accountId: string | null,
): string {
  if (provider === 'AWS') {
    if (!credentialEntityId) return '';
    return (
      `fetch dt.entity.custom_device\n` +
      `| filter contains(toString(entity.type), "cloud:aws")\n` +
      `    AND in("${credentialEntityId}", accessible_by[\`dt.entity.aws_credentials\`])\n` +
      `| summarize cnt=count(), by:{entity.type}\n| sort cnt desc`
    );
  }
  if (provider === 'Azure') {
    if (!subscriptionEntityId) return '';
    return (
      `fetch dt.entity.custom_device\n` +
      `| filter contains(toString(entity.type), "cloud:azure")\n` +
      `    AND in("${subscriptionEntityId}", accessible_by[\`dt.entity.azure_subscription\`])\n` +
      `| summarize cnt=count(), by:{entity.type}\n| sort cnt desc`
    );
  }
  if (provider === 'GCP') {
    if (!accountId) return '';
    return (
      `fetch dt.entity.custom_device\n` +
      `| filter contains(toString(entity.type), "cloud:gcp")\n` +
      `    AND project_id == "${accountId}"\n` +
      `| summarize cnt=count(), by:{entity.type}\n| sort cnt desc`
    );
  }
  return '';
}

function buildMetricCountQuery(provider: CloudProvider): string {
  const prefixes = CLASSIC_METRIC_PREFIXES[provider];
  const filterClause = prefixes
    .map((p) => `startsWith(metric.key, "${p}")`)
    .join('\n    OR ');
  // Group by metric.key so each record = one distinct key. Client reads records.length
  // to get the total count of distinct classic metric keys ingested in the last 2 hours.
  return `fetch metric.series, from:now()-2h\n| filter ${filterClause}\n| summarize count(), by:{metric.key}`;
}

/**
 * Builds a DQL query that lists distinct classic metric keys for use in the
 * Notebooks app via intent navigation.
 *
 * NOTE: metric.series does not support filtering by credential entity ID — this
 * query returns ALL classic metric keys for the provider globally, not just for
 * the specific account. This is a platform limitation; document in the UI if
 * shown to end users.
 */
export function buildMetricKeyListQuery(provider: CloudProvider): string {
  const prefixes = CLASSIC_METRIC_PREFIXES[provider];
  const filterClause = prefixes
    .map((p) => `startsWith(metric.key, "${p}")`)
    .join('\n    OR ');
  return (
    `fetch metric.series, from:now()-2h\n` +
    `| filter ${filterClause}\n` +
    `| filterOut contains(dt.da.source, "metric-poller") \n` +
    `| summarize count(), by:{metric.key}\n` +
    `| sort metric.key asc`
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAccountOverview({
  provider,
  credentialEntityId,
  subscriptionEntityId,
  accountId,
}: {
  provider: CloudProvider;
  credentialEntityId: string | null;
  subscriptionEntityId: string | null;
  accountId: string | null;
}): UseAccountOverviewResult {
  // ── Build query strings ────────────────────────────────────────────────────

  const builtInQuery = useMemo(() => {
    if (provider === 'AWS') return buildAwsBuiltInQuery(credentialEntityId);
    if (provider === 'Azure') return buildAzureBuiltInQuery(subscriptionEntityId);
    // GCP: all classic entities are custom_device sub-types; no built-in DT entity types
    return '';
  }, [provider, credentialEntityId, subscriptionEntityId]);

    // AWS only: ebs_volume — accessible_by is absent on this entity type directly,
  // but ebs_volume has belongs_to[dt.entity.ec2_instance], and ec2_instance carries
  // accessible_by[dt.entity.aws_credentials]. Traverse the relationship:
  // EBS → EC2 → credential, keeping only EBS volumes whose EC2 is in this account.
  // See: https://docs.dynatrace.com/docs/semantic-dictionary/model/dt-entities#aws-ebs-volume-classic
  const fallbackQuery = useMemo(() => {
    if (provider === 'AWS' && credentialEntityId) {
      return (
        `fetch dt.entity.ebs_volume\n` +
        `| fieldsAdd ec2 = belongs_to[\`dt.entity.ec2_instance\`][0]\n` +
        `| lookup [\n` +
        `    fetch dt.entity.ec2_instance\n` +
        `    | filter in("${credentialEntityId}", accessible_by[\`dt.entity.aws_credentials\`])\n` +
        `    | fields id\n` +
        `  ], sourceField:ec2, lookupField:id, prefix:"linkedEc2."\n` +
        `| filter isNotNull(linkedEc2.id)\n` +
        `| summarize count(), by:{entity.type}`
      );
    }
    return '';
  }, [provider, credentialEntityId]);

  const customDeviceQuery = useMemo(
    () => buildCustomDeviceQuery(provider, credentialEntityId, subscriptionEntityId, accountId),
    [provider, credentialEntityId, subscriptionEntityId, accountId],
  );

  const metricCountQuery = useMemo(() => buildMetricCountQuery(provider), [provider]);

  // ── Fire queries (all unconditional — React rules of hooks) ───────────────

  const builtInDql = useDql({ query: builtInQuery }, { enabled: builtInQuery !== '' });
  const fallbackDql = useDql({ query: fallbackQuery }, { enabled: fallbackQuery !== '' });
  const customDeviceDql = useDql({ query: customDeviceQuery }, { enabled: customDeviceQuery !== '' });
  const metricCountDql = useDql({ query: metricCountQuery }, { enabled: metricCountQuery !== '' });

  // ── Collect entity results per source (no cross-source merging) ─────────────
  //
  // Each query flavour (built-in, fallback, custom-device) may return different
  // technical entity type strings for what conceptually looks like the same resource.
  // We keep them as individual rows so the UI can show both and never silently merge
  // a "builtin" flavour count with a "non-builtin" flavour count.

  const entities = useMemo((): EntityTypeSummary[] => {
    // Built-in types: summarize count(), by:{entity.type} → fields: count(), entity.type
    const builtIn: EntityTypeSummary[] = (builtInDql.data?.records ?? [])
      .map((r) => ({ entityType: asString(r['entity.type']), count: asNumber(r['count()']) }))
      .filter((e) => e.entityType !== '');

    // Fallback (ebs_volume join traversal): same DQL field names as built-in
    const fallback: EntityTypeSummary[] = (fallbackDql.data?.records ?? [])
      .map((r) => ({ entityType: asString(r['entity.type']), count: asNumber(r['count()']) }))
      .filter((e) => e.entityType !== '');

    // Custom devices: summarize cnt=count(), by:{entity.type} → fields: cnt, entity.type
    const customDevice: EntityTypeSummary[] = (customDeviceDql.data?.records ?? [])
      .map((r) => ({ entityType: asString(r['entity.type']), count: asNumber(r['cnt']) }))
      .filter((e) => e.entityType !== '');

    return [...builtIn, ...fallback, ...customDevice];
  }, [builtInDql.data, fallbackDql.data, customDeviceDql.data]);

  // ── Metric key count ───────────────────────────────────────────────────────

  const metricKeyCount = useMemo((): number => {
    const records = metricCountDql.data?.records ?? [];
    // Each record represents one distinct metric key (query groups by metric.key)
    return records.length;
  }, [metricCountDql.data]);

  // ── Aggregate loading / error states ──────────────────────────────────────

  const entityLoading =
    builtInDql.isLoading || fallbackDql.isLoading || customDeviceDql.isLoading;
  const entityError: Error | null =
    (builtInDql.error as Error | null) ??
    (fallbackDql.error as Error | null) ??
    (customDeviceDql.error as Error | null);

  const metricLoading = metricCountDql.isLoading;
  const metricError: Error | null = (metricCountDql.error as Error | null) ?? null;

  function refetchEntities() {
    void builtInDql.refetch();
    void fallbackDql.refetch();
    void customDeviceDql.refetch();
  }

  function refetchMetrics() {
    void metricCountDql.refetch();
  }

  return {
    entities,
    entityLoading,
    entityError,
    refetchEntities,
    metricKeyCount,
    metricLoading,
    metricError,
    refetchMetrics,
  };
}
