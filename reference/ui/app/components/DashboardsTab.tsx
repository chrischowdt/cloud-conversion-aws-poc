import React, { useEffect, useState } from 'react';

import { Button } from '@dynatrace/strato-components/buttons';
import { Chip, EmptyState, MessageContainer, ProgressCircle } from '@dynatrace/strato-components/content';
import { Switch } from '@dynatrace/strato-components/forms';
import { Flex } from '@dynatrace/strato-components/layouts';
import { DataTable, type DataTableColumnDef } from '@dynatrace/strato-components/tables';
import { ExternalLink, Paragraph } from '@dynatrace/strato-components/typography';

import { useDashboardScan } from '../hooks/useDashboardScan';
import type { CloudProvider } from '../types/connection';
import type { DashboardScanResult } from '../types/dashboard';

// ─── Dashboard table column definitions ──────────────────────────────────────

const DASHBOARD_COLUMNS: DataTableColumnDef<DashboardScanResult>[] = [
  {
    id: 'name',
    header: 'Dashboard',
    accessor: 'name',
    cell: ({ value, rowData }) => (
      <DataTable.DefaultCell>
        <ExternalLink href={rowData.url}>{value as string}</ExternalLink>
      </DataTable.DefaultCell>
    ),
  },
  {
    id: 'format',
    header: 'Format',
    accessor: 'format',
    width: 100,
    cell: ({ value }) => (
      <DataTable.DefaultCell>
        <Chip color="neutral" size="condensed">
          {value === 'classic' ? 'Classic' : 'New'}
        </Chip>
      </DataTable.DefaultCell>
    ),
  },
  {
    id: 'ownership',
    header: 'Ownership',
    accessor: 'ownership',
    width: 130,
    cell: ({ value }) => {
      const label =
        value === 'custom' ? 'Custom' : value === 'preset' ? 'Preset' : 'Ready-made';
      const color: 'warning' | 'success' | 'primary' =
        value === 'custom' ? 'warning' : value === 'preset' ? 'primary' : 'success';
      return (
        <DataTable.DefaultCell>
          <Chip color={color} size="condensed">
            {label}
          </Chip>
        </DataTable.DefaultCell>
      );
    },
  },
  {
    id: 'classicPatterns',
    header: 'Classic Patterns Detected',
    accessor: 'classicPatterns',
    cell: ({ value }) => (
      <DataTable.DefaultCell>
        <span style={{ fontFamily: 'monospace', fontSize: '0.85em', wordBreak: 'break-all' }}>
          {(value as string[]).join(', ')}
        </span>
      </DataTable.DefaultCell>
    ),
  },
  {
    id: 'owner',
    header: 'Owner',
    accessor: 'owner',
    cell: ({ value }) => (
      <DataTable.DefaultCell>
        {(value as string | null) ?? '—'}
      </DataTable.DefaultCell>
    ),
  },
  {
    id: 'lastOpened',
    header: 'Last Opened',
    accessor: 'lastOpened',
    sortType: (a: Date | null, b: Date | null) =>
      (b?.getTime() ?? -1) - (a?.getTime() ?? -1),
    cell: ({ value }) => (
      <DataTable.DefaultCell>
        {(value as Date | null)?.toLocaleString() ?? '—'}
      </DataTable.DefaultCell>
    ),
  },
  {
    id: 'lastModified',
    header: 'Last Modified',
    accessor: 'lastModified',
    sortType: (a: Date | null, b: Date | null) =>
      (b?.getTime() ?? -1) - (a?.getTime() ?? -1),
    cell: ({ value }) => (
      <DataTable.DefaultCell>
        {(value as Date | null)?.toLocaleString() ?? '—'}
      </DataTable.DefaultCell>
    ),
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

export const DashboardsTab = ({
  provider,
  token,
}: {
  provider: CloudProvider;
  token: string | null;
}) => {
  const { results, phase, error, run } = useDashboardScan({ provider, token });

  // Filter toggle — local state; reset to false when provider changes (AC #5)
  const [includePresetAndReadyMade, setIncludePresetAndReadyMade] = useState(false);
  useEffect(() => {
    setIncludePresetAndReadyMade(false);
  }, [provider]);

  const filterSummary = includePresetAndReadyMade
    ? 'Showing all dashboards including preset & ready-made'
    : 'Showing custom dashboards only — preset & ready-made (dynatrace.clouds) excluded';

  const filteredResults = results;

  // ── Idle state ──────────────────────────────────────────────────────────────
  if (phase === 'idle') {
    return (
      <Flex flexDirection="column" gap={16} padding={16}>
        {!token && (
          <MessageContainer variant="warning">
            <MessageContainer.Title>Classic scan requires an API token</MessageContainer.Title>
            <MessageContainer.Description>
              Classic (Config API v1) dashboards will be skipped. Enter the API token above to
              include them.
            </MessageContainer.Description>
          </MessageContainer>
        )}
        <Switch value={includePresetAndReadyMade} onChange={setIncludePresetAndReadyMade}>
          Include preset &amp; ready-made dashboards
        </Switch>
        <div>
          <Button variant="emphasized" color="primary" onClick={() => void run(includePresetAndReadyMade)}>
            Scan Dashboards
          </Button>
        </div>
      </Flex>
    );
  }

  // ── Scanning state ──────────────────────────────────────────────────────────
  if (phase === 'scanning') {
    return (
      <Flex flexDirection="column" alignItems="center" padding={32} gap={12}>
        <ProgressCircle value="indeterminate" aria-label="Scanning dashboards" />
        <Paragraph>Scanning dashboards for classic {provider} references…</Paragraph>
      </Flex>
    );
  }

  // ── Results state ───────────────────────────────────────────────────────────

  if (error) {
    return (
      <Flex flexDirection="column" gap={12} padding={16}>
        <MessageContainer variant="critical">
          <MessageContainer.Title>Scan error</MessageContainer.Title>
          <MessageContainer.Description>{error}</MessageContainer.Description>
        </MessageContainer>
        <div>
          <Button variant="default" color="neutral" size="condensed" onClick={() => void run(includePresetAndReadyMade)}>
            Retry
          </Button>
        </div>
      </Flex>
    );
  }

  return (
    <Flex flexDirection="column" gap={12} padding={16}>
      {/* Toolbar: filter toggle + summary + re-scan */}
      <Flex flexDirection="row" alignItems="center" gap={16} flexWrap="wrap">
        <Switch value={includePresetAndReadyMade} onChange={setIncludePresetAndReadyMade}>
          Include preset &amp; ready-made dashboards
        </Switch>
        <Paragraph style={{ flex: 1, margin: 0 }}>{filterSummary}</Paragraph>
        <Button variant="default" color="neutral" size="condensed" onClick={() => void run(includePresetAndReadyMade)}>
          Re-scan
        </Button>
      </Flex>

      {/* Results / empty state */}
      {filteredResults.length === 0 ? (
        <EmptyState>
          <EmptyState.Title>No dependent dashboards found</EmptyState.Title>
          <EmptyState.Details>
            {includePresetAndReadyMade
              ? `No dashboards referencing classic ${provider} metrics or entity types were detected.`
              : `No custom dashboards referencing classic ${provider} metrics were detected. Enable "Include preset & ready-made dashboards" to broaden the search.`}
          </EmptyState.Details>
        </EmptyState>
      ) : (
        <DataTable columns={DASHBOARD_COLUMNS} data={filteredResults} sortable />
      )}
    </Flex>
  );
};
