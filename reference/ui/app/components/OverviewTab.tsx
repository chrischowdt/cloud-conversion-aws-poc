import React, { useMemo } from 'react';

import { Button, IntentButton } from '@dynatrace/strato-components/buttons';
import { SingleValue } from '@dynatrace/strato-components/charts';
import { MessageContainer } from '@dynatrace/strato-components/content';
import { Flex } from '@dynatrace/strato-components/layouts';
import { DataTable, type DataTableColumnDef } from '@dynatrace/strato-components/tables';
import { Heading, Text } from '@dynatrace/strato-components/typography';
import { ExternalLinkIcon } from '@dynatrace/strato-icons';
import { sendIntent } from '@dynatrace-sdk/navigation';
import type { IntentPayload } from '@dynatrace-sdk/navigation';

import type { CloudProvider } from '../types/connection';
import {
  useAccountOverview,
  buildMetricKeyListQuery,
  type EntityTypeSummary,
} from '../hooks/useAccountOverview';
import { entityTypeLabel } from '../utils/entityTypeLabels';

// ─── Column definitions ───────────────────────────────────────────────────────

const ENTITY_COLUMNS: DataTableColumnDef<EntityTypeSummary>[] = [
  {
    id: 'label',
    header: 'Type',
    accessor: 'entityType',
    cell: ({ value }) => (
      <DataTable.DefaultCell>{entityTypeLabel(value as string)}</DataTable.DefaultCell>
    ),
  },
  {
    id: 'entityType',
    header: 'Entity Type (technical)',
    accessor: 'entityType',
    cell: ({ value }) => (
      <DataTable.DefaultCell>
        <Text as="span" fontStyle="code">{value as string}</Text>
      </DataTable.DefaultCell>
    ),
  },
  {
    id: 'count',
    header: 'Count',
    accessor: 'count',
    columnType: 'number',
    sortDescFirst: true,
  },
];

// ─── Helper: build Clouds App drill-down DQL query ────────────────────────────

function buildCloudsAppQuery(
  entityType: string,
  provider: CloudProvider,
  credentialEntityId: string | null,
  subscriptionEntityId: string | null,
  accountId: string | null,
): string {
  // Custom device sub-types contain ':' (e.g. "cloud:aws:s3", "CUSTOM_DEVICE").
  // Note: `fetch \`dt.entity.cloud:aws:s3\`` with backticks is valid DQL, but querying
  // via custom_device + entity.type filter is simpler and consistent with the count queries.
  const isCustomDevice = entityType.includes(':') || entityType === 'CUSTOM_DEVICE';

  if (isCustomDevice) {
    if (provider === 'AWS' && credentialEntityId) {
      return (
        `fetch dt.entity.custom_device\n` +
        `| filter entity.type == "${entityType}"\n` +
        `    AND in("${credentialEntityId}", accessible_by[\`dt.entity.aws_credentials\`])\n` +
        `| fields entity.name, entity.type`
      );
    }
    if (provider === 'Azure' && subscriptionEntityId) {
      return (
        `fetch dt.entity.custom_device\n` +
        `| filter entity.type == "${entityType}"\n` +
        `    AND in("${subscriptionEntityId}", accessible_by[\`dt.entity.azure_subscription\`])\n` +
        `| fields entity.name, entity.type`
      );
    }
    if (provider === 'GCP' && accountId) {
      return (
        `fetch dt.entity.custom_device\n` +
        `| filter entity.type == "${entityType}" AND entity.name == "${accountId}"\n` +
        `| fields entity.name, entity.type`
      );
    }
    return `fetch dt.entity.custom_device\n| filter entity.type == "${entityType}"\n| fields entity.name, entity.type`;
  }

  // Built-in types: DQL results return uppercase (e.g. EC2_INSTANCE), fetch requires lowercase.
  const fetchType = entityType.toLowerCase();

  if (provider === 'AWS' && credentialEntityId) {
    return (
      `fetch dt.entity.${fetchType}\n` +
      `| filter in("${credentialEntityId}", accessible_by[\`dt.entity.aws_credentials\`])\n` +
      `| fields entity.name, entity.type`
    );
  }
  if (provider === 'Azure' && subscriptionEntityId) {
    return (
      `fetch dt.entity.${fetchType}\n` +
      `| filter in("${subscriptionEntityId}", accessible_by[\`dt.entity.azure_subscription\`])\n` +
      `| fields entity.name, entity.type`
    );
  }
  // if (provider === 'GCP' && accountId) {
  //   return (
  //     `fetch dt.entity.custom_device\n` +
  //     `| filter entity.type == "${entityType}" AND project_id == "${accountId}"\n` +
  //     `| fields entity.name, entity.type`
  //   );
  // }
  // Fallback: unscoped (single-account environments)
  return `fetch dt.entity.${fetchType}\n| fields entity.name, entity.type`;
}

// ─── Component ────────────────────────────────────────────────────────────────

type OverviewTabProps = {
  provider: CloudProvider;
  credentialEntityId: string | null;
  subscriptionEntityId: string | null;
  accountId: string | null;
};

export const OverviewTab = ({
  provider,
  credentialEntityId,
  subscriptionEntityId,
  accountId,
}: OverviewTabProps) => {
  const {
    entities,
    entityLoading,
    entityError,
    refetchEntities,
    metricKeyCount,
    metricLoading,
    metricError,
    refetchMetrics,
  } = useAccountOverview({ provider, credentialEntityId, subscriptionEntityId, accountId });

  // Filter zero-count rows before passing to DataTable (AC #2 — do not filter inside rendering)
  const nonZeroEntities = useMemo(
    () => entities.filter((e) => e.count > 0),
    [entities],
  );

  // Build the Notebooks intent payload (memoized — only changes when provider changes)
  const notebooksPayload: IntentPayload = useMemo(
    () => ({ 'dt.query': buildMetricKeyListQuery(provider) }),
    [provider],
  );

  return (
    <Flex flexDirection="column" gap={24} padding={16}>

      {/* Azure warning: subscriptionEntityId absent — entity queries will be empty */}
      {provider === 'Azure' && !subscriptionEntityId && (
        <MessageContainer variant="warning">
          <MessageContainer.Title>Subscription entity ID unavailable</MessageContainer.Title>
          <MessageContainer.Description>
            This Azure credential has no linked subscription. Entity counts cannot be scoped to a
            specific subscription and will not be shown.
          </MessageContainer.Description>
        </MessageContainer>
      )}

      {/* ── Classic Entities ─────────────────────────────────────────────────── */}
      <Flex flexDirection="column" gap={8}>
        <Heading level={4}>Classic Entities</Heading>

        {entityError ? (
          <Flex flexDirection="column" gap={8} alignItems="flex-start">
            <Text>Could not load entity data. Check your permissions or try again.</Text>
            <Button variant="default" onClick={refetchEntities}>
              Retry
            </Button>
          </Flex>
        ) : (
          <DataTable
            data={nonZeroEntities}
            columns={ENTITY_COLUMNS}
            rowId={(row) => row.entityType}
            sortable
            defaultSortBy={[{ id: 'count', desc: true }]}
            loading={entityLoading}
            fullWidth
          >
            {/* <DataTable.RowActions>
              {(row: EntityTypeSummary) => (
                <Button
                  variant="default"
                  onClick={() => {
                    const query = buildCloudsAppQuery(
                      row.entityType,
                      provider,
                      credentialEntityId,
                      subscriptionEntityId,
                      accountId,
                    );
                    // OQ #3: Using dt.query with recommendedAppId: 'dynatrace.clouds'.
                    // If the Clouds App does not declare a dt.query intent handler, the
                    // platform shows an "Open with…" picker — Notebooks is the fallback.
                    // Verify intent ID in a live environment before v1 release.
                    sendIntent(
                      { 'dt.query': query } as IntentPayload,
                      { recommendedAppId: 'dynatrace.clouds', recommendedIntentId: 'view-entities' },
                    );
                  }}
                >
                  <Button.Prefix>
                    <ExternalLinkIcon />
                  </Button.Prefix>
                  View in Clouds App
                </Button>
              )}
            </DataTable.RowActions> */}

            <DataTable.EmptyState>
              No classic entities detected for this account.
            </DataTable.EmptyState>
          </DataTable>
        )}
      </Flex>

      {/* ── Classic Metric Keys ─────────────────────────────────────────────── */}
      <Flex flexDirection="column" gap={8}>
        <Heading level={4}>Classic Metric Keys</Heading>

        {metricError ? (
          <Flex flexDirection="column" gap={8} alignItems="flex-start">
            <Text>Could not load metric key data. Try again.</Text>
            <Button variant="default" onClick={refetchMetrics}>
              Retry
            </Button>
          </Flex>
        ) : metricKeyCount === 0 && !metricLoading ? (
          <Text>No classic metric keys detected in recent data (last 2 hours).</Text>
        ) : (
          <Flex flexDirection="column" gap={12} alignItems="flex-start">
            {/* Fixed-width container — SingleValue is a KPI, not a full-width chart */}
            <div style={{ width: 240 }}>
              <SingleValue
                data={metricKeyCount}
                label="Classic metric keys actively ingested (last 2 hours)"
                loading={metricLoading}
              />
            </div>

            {metricKeyCount > 0 && !metricLoading && (
              <IntentButton
                payload={notebooksPayload}
                options={{
                  recommendedAppId: 'dynatrace.notebooks',
                  recommendedIntentId: 'view-query',
                }}
                variant="emphasized"
              >
                Explore in Notebooks
              </IntentButton>
            )}
          </Flex>
        )}
      </Flex>

    </Flex>
  );
};
