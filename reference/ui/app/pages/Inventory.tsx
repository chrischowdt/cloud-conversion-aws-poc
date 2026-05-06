import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@dynatrace/strato-components/buttons';
import { Chip, EmptyState, MessageContainer } from '@dynatrace/strato-components/content';
import { Select } from '@dynatrace/strato-components/forms';
import { Flex } from '@dynatrace/strato-components/layouts';
import { DataTable, type DataTableColumnDef } from '@dynatrace/strato-components/tables';
import { ExternalLink, Heading, Text } from '@dynatrace/strato-components/typography';
import { Tooltip } from '@dynatrace/strato-components/overlays';
import { InformationIcon, WarningIcon } from '@dynatrace/strato-icons';

// ─── Migration status chip ────────────────────────────────────────────────────

const MIGRATION_BLOCKED_TOOLTIP =
  'Account not yet ready for migration: AWS CloudWatch Metric Streams is not yet supported ' +
  'by the new AWS connection. Classic metric polling on this account (built-in, ' +
  'cloud services) can still be migrated independently.';

import { StatusBadge } from '../components/StatusBadge';
import { useCloudAccountInventory } from '../hooks/useConnectionInventory';
import type { CloudAccount, CloudProvider, ConnectionStatus, InventoryTimeframe } from '../types/connection';

// ─── Sort order for status column ─────────────────────────────────────────────

const STATUS_SORT_ORDER: Record<ConnectionStatus, number> = {
  Classic: 0,
  Parallel: 1,
  New: 2,
};

// ─── Timeframe options ────────────────────────────────────────────────────────

const TIMEFRAME_LABELS: Record<InventoryTimeframe, string> = {
  '12h': 'last 12 hours',
  '24h': 'last 24 hours',
  '7d':  'last 7 days',
  '30d': 'last 30 days',
};

const TIMEFRAME_TOOLTIP =
  'Controls how far back the query scans for active connections. ' +
  'Active connections update their entity records continuously and always appear regardless of age. ' +
  'A shorter window may exclude connections that have been inactive for longer than the chosen period. ' +
  'The same window applies to AWS Metric Streams detection — if a Firehose was paused for longer than ' +
  'this period, the migration-blocked indicator will not appear for that account even if Metric Streams ' +
  'was previously active.';

// ─── Column definitions ───────────────────────────────────────────────────────

const columns: DataTableColumnDef<CloudAccount>[] = [
  {
    id: 'provider',
    header: 'Provider',
    accessor: 'provider',
    width: 100,
  },
  {
    id: 'name',
    header: 'Connection Name',
    accessor: 'name',
    cell: ({ value, rowData }) => (
      <DataTable.DefaultCell>
        <Link
          to={`/inventory/${rowData.accountId ?? rowData.name}`}
          state={{ provider: rowData.provider, status: rowData.status, connectionName: rowData.name, entityId: rowData.entityId, subscriptionEntityId: rowData.subscriptionEntityId ?? null }}
        >
          {value as string}
        </Link>
      </DataTable.DefaultCell>
    ),
  },
  {
    id: 'accountId',
    header: 'Account / Subscription / Project ID',
    accessor: 'accountId',
    cell: ({ value, rowData }) => {
      const id = (value as string | null) ?? '—';
      if (rowData.hasDuplicateAccountId) {
        return (
          <DataTable.DefaultCell>
            <Tooltip text="Multiple credentials share this account ID. Review your AWS connection configuration.">
              <Flex flexDirection="row" alignItems="center" gap={4} as="span">
                {id}
                <WarningIcon />
              </Flex>
            </Tooltip>
          </DataTable.DefaultCell>
        );
      }
      return (
        <DataTable.DefaultCell>
          {id}
        </DataTable.DefaultCell>
      );
    },
  },
  {
    id: 'status',
    header: 'Cloud Connection',
    accessor: 'status',
    sortType: (valueA: ConnectionStatus, valueB: ConnectionStatus) =>
      STATUS_SORT_ORDER[valueA] - STATUS_SORT_ORDER[valueB],
    cell: ({ value }) => (
      <DataTable.DefaultCell>
        <StatusBadge status={value as ConnectionStatus} />
      </DataTable.DefaultCell>
    ),
  },
  {
    id: 'migrationStatus',
    header: 'Status',
    accessor: 'isMigrationBlocked',
    cell: ({ value }) =>
      value ? (
        <DataTable.DefaultCell>
          <Tooltip text={MIGRATION_BLOCKED_TOOLTIP}>
            <Chip color="critical" size="condensed">
              Not yet ready (Metric Streams)
            </Chip>
          </Tooltip>
        </DataTable.DefaultCell>
      ) : (
        <DataTable.DefaultCell />
      ),
  },
];

// ─── Main component ───────────────────────────────────────────────────────────

export const Inventory = () => {
  const [timeframe, setTimeframe] = useState<InventoryTimeframe>('12h');
  const { accounts, isLoading, aws, azure, gcp, refetch } = useCloudAccountInventory(timeframe);
  const [providerFilter, setProviderFilter] = useState<string[]>([]);

  const filteredAccounts = useMemo(() => {
    if (providerFilter.length === 0) return accounts;
    return accounts.filter((a) => providerFilter.includes(a.provider));
  }, [accounts, providerFilter]);

  const allQueriesDone = !isLoading;
  const hasNoAccounts = allQueriesDone && filteredAccounts.length === 0 && providerFilter.length === 0;

  const erroredProviders: string[] = [];
  if (aws.error && !aws.isLoading) erroredProviders.push('AWS');
  if (azure.error && !azure.isLoading) erroredProviders.push('Azure');
  if (gcp.error && !gcp.isLoading) erroredProviders.push('GCP');

  return (
    <Flex flexDirection="column" padding={32} gap={16}>
      <Flex flexDirection="row" alignItems="baseline" gap={8}>
        <Heading>Cloud Account Inventory</Heading>
        <Tooltip text={TIMEFRAME_TOOLTIP}>
          <Flex flexDirection="row" alignItems="center" gap={4} as="span">
            <Text color="neutral">Showing connections active in the {TIMEFRAME_LABELS[timeframe]}</Text>
            <InformationIcon />
          </Flex>
        </Tooltip>
      </Flex>

      {/* Per-provider error banners */}
      {erroredProviders.map((provider) => (
        <MessageContainer key={provider} variant="warning">
          <MessageContainer.Title>
            Could not load {provider} connections. Results may be incomplete.
          </MessageContainer.Title>
          <MessageContainer.Actions>
            <Button size="condensed" onClick={refetch}>
              Retry
            </Button>
          </MessageContainer.Actions>
        </MessageContainer>
      ))}

      {/* Full-page empty state when no connections found at all */}
      {hasNoAccounts ? (
        <EmptyState>
          <EmptyState.VisualPreset context="table" type="something-missing" />
          <EmptyState.Title>No cloud connections found</EmptyState.Title>
          <EmptyState.Details>
            No AWS, Azure, or GCP connections were detected in this environment.
            Classic and new connections are both checked automatically.
          </EmptyState.Details>
          <EmptyState.Actions>
            <ExternalLink href="https://www.dynatrace.com/hub/detail/clouds/">
              Set up a connection in the Clouds app
            </ExternalLink>
          </EmptyState.Actions>
        </EmptyState>
      ) : (
        <DataTable
          data={filteredAccounts}
          columns={columns}
          fontStyle={{ accountId: 'code' }}
          loading={isLoading}
          sortable
          resizable
          interactiveRows
          fullWidth
          defaultSortBy={[{ id: 'status', desc: false }]}
          rowId={(row) => `${row.provider}-${row.entityId ?? row.accountId ?? row.name}`}
        >
          <DataTable.TableActions>
            <Select
              multiple
              value={providerFilter as CloudProvider[]}
              onChange={(v) => setProviderFilter((v as string[]) ?? [])}
            >
              <Select.Trigger placeholder="Filter by provider" />
              <Select.Content>
                <Select.Option value="AWS">AWS</Select.Option>
                <Select.Option value="Azure">Azure</Select.Option>
                <Select.Option value="GCP">GCP</Select.Option>
              </Select.Content>
            </Select>
            <Select
              value={timeframe}
              onChange={(v) => { if (v) setTimeframe(v as InventoryTimeframe); }}
            >
              <Select.Trigger placeholder="Time window" />
              <Select.Content>
                <Select.Option value="12h">Last 12 hours</Select.Option>
                <Select.Option value="24h">Last 24 hours</Select.Option>
                <Select.Option value="7d">Last 7 days</Select.Option>
                <Select.Option value="30d">Last 30 days</Select.Option>
              </Select.Content>
            </Select>
          </DataTable.TableActions>

          <DataTable.EmptyState>
            No connections match the selected filter.{' '}
            <Button
              variant="default"
              size="condensed"
              onClick={() => setProviderFilter([])}
            >
              Clear filter
            </Button>
          </DataTable.EmptyState>
        </DataTable>
      )}
    </Flex>
  );
};
