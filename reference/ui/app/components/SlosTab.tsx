import React, { useMemo } from 'react';

import { Button } from '@dynatrace/strato-components/buttons';
import { Chip, EmptyState, MessageContainer, ProgressCircle } from '@dynatrace/strato-components/content';
import { Flex } from '@dynatrace/strato-components/layouts';
import { DataTable, type DataTableColumnDef } from '@dynatrace/strato-components/tables';
import { Paragraph } from '@dynatrace/strato-components/typography';

import { useToken } from '../context/TokenContext';
import { useSloScan } from '../hooks/useSloScan';
import type { CloudProvider } from '../types/connection';
import type { SloResult, SloStatus } from '../types/slo';

// ─── Display maps ─────────────────────────────────────────────────────────────

const SLO_TYPE_COLORS: Record<string, 'primary' | 'neutral'> = {
  Classic: 'primary',
  New: 'neutral',
};

type ChipColor = 'success' | 'warning' | 'critical' | 'neutral' | 'primary';

const STATUS_CHIP_COLOR: Record<SloStatus, ChipColor> = {
  SUCCESS: 'success',
  WARNING: 'warning',
  FAILURE: 'critical',
  DEGRADED: 'warning',
  DISABLED: 'neutral',
  UNKNOWN: 'neutral',
};

// Severity order for sorting — lower index = higher severity (shown first)
const STATUS_SEVERITY: Record<SloStatus, number> = {
  FAILURE: 0,
  DEGRADED: 1,
  WARNING: 2,
  UNKNOWN: 3,
  SUCCESS: 4,
  DISABLED: 5,
};

// ─── Component ────────────────────────────────────────────────────────────────

export const SlosTab = ({
  provider,
}: {
  provider: CloudProvider;
}) => {
  const { token } = useToken();
  const { results, phase, error, partialFailures, run } = useSloScan({ provider, token });

  const SLO_COLUMNS = useMemo<DataTableColumnDef<SloResult>[]>(
    () => [
      {
        id: 'name',
        header: 'Name',
        accessor: 'name',
        cell: ({ value }) => (
          <DataTable.DefaultCell>{value as string}</DataTable.DefaultCell>
        ),
      },
      {
        id: 'sloType',
        header: 'Type',
        accessor: 'sloType',
        width: 100,
        cell: ({ value }) => (
          <DataTable.DefaultCell>
            <Chip color={SLO_TYPE_COLORS[value as string] ?? 'neutral'} size="condensed">
              {value as string}
            </Chip>
          </DataTable.DefaultCell>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        accessor: 'status',
        width: 120,
        comparator: (a, b) =>
          (STATUS_SEVERITY[a.status] ?? 99) - (STATUS_SEVERITY[b.status] ?? 99),
        cell: ({ value }) => (
          <DataTable.DefaultCell>
            <Chip color={STATUS_CHIP_COLOR[value as SloStatus] ?? 'neutral'} size="condensed">
              {value as string}
            </Chip>
          </DataTable.DefaultCell>
        ),
      },
      {
        id: 'enabled',
        header: 'Enabled',
        accessor: 'enabled',
        width: 110,
        cell: ({ value }) => (
          <DataTable.DefaultCell>
            <Chip color={(value as boolean) ? 'success' : 'neutral'} size="condensed">
              {(value as boolean) ? 'Enabled' : 'Disabled'}
            </Chip>
          </DataTable.DefaultCell>
        ),
      },
      {
        id: 'evaluationType',
        header: 'Evaluation Type',
        accessor: 'evaluationType',
        width: 140,
        cell: ({ value }) => (
          <DataTable.DefaultCell>
            <Chip color="neutral" size="condensed">
              {value as string}
            </Chip>
          </DataTable.DefaultCell>
        ),
      },
      {
        id: 'targetSuccess',
        header: 'Target %',
        accessor: 'targetSuccess',
        width: 100,
        cell: ({ value }) => (
          <DataTable.DefaultCell>{(value as number).toFixed(2)}%</DataTable.DefaultCell>
        ),
      },
      {
        id: 'classicPatterns',
        header: 'Classic Dependencies',
        accessor: 'classicPatterns',
        cell: ({ value }) => (
          <DataTable.DefaultCell>
            <span style={{ fontFamily: 'monospace', fontSize: '0.85em', wordBreak: 'break-all' }}>
              {(value as string[]).length > 0 ? (value as string[]).join(', ') : '—'}
            </span>
          </DataTable.DefaultCell>
        ),
      },
    ],
    [],
  );

  // ── Idle state ──────────────────────────────────────────────────────────────
  if (phase === 'idle') {
    return (
      <Flex flexDirection="column" gap={16} padding={16}>
        {token === null && (
          <MessageContainer variant="primary">
            <MessageContainer.Title>API Token recommended</MessageContainer.Title>
            <MessageContainer.Description>
              Classic SLOs require a token with <strong>slo.read</strong> scope. Without a token,
              only new DQL-based SLOs will be scanned.
            </MessageContainer.Description>
          </MessageContainer>
        )}
        <div>
          <Button variant="emphasized" color="primary" onClick={() => void run()}>
            Scan SLOs
          </Button>
        </div>
      </Flex>
    );
  }

  // ── Scanning state ──────────────────────────────────────────────────────────
  if (phase === 'scanning') {
    return (
      <Flex flexDirection="column" alignItems="center" padding={32} gap={12}>
        <ProgressCircle value="indeterminate" aria-label="Scanning SLO configurations" />
        <Paragraph>Scanning SLOs for classic {provider} references…</Paragraph>
      </Flex>
    );
  }

  // ── Results state ───────────────────────────────────────────────────────────

  // Full error: both sub-scans failed (AC #15)
  if (error) {
    return (
      <Flex flexDirection="column" gap={12} padding={16}>
        <MessageContainer variant="critical">
          <MessageContainer.Title>Scan failed</MessageContainer.Title>
          <MessageContainer.Description>{error}</MessageContainer.Description>
        </MessageContainer>
        <div>
          <Button variant="default" color="neutral" size="condensed" onClick={() => void run()}>
            Retry
          </Button>
        </div>
      </Flex>
    );
  }

  // Build partial warning message (AC #16)
  const partialWarningMessage = partialFailures
    .map((source) => {
      if (source === 'Classic SLOs (token required)')
        return 'Classic SLOs were not scanned — provide an API token with slo.read scope to include them.';
      if (source === 'Classic SLOs')
        return 'Classic SLO scan failed — results may be incomplete.';
      if (source === 'New DQL-based SLOs')
        return 'New DQL-based SLO scan failed — results may be incomplete.';
      return `${source} could not be scanned. Results may be incomplete.`;
    })
    .join(' ');

  return (
    <Flex flexDirection="column" gap={12} padding={16}>
      {/* 1. Partial warning banner */}
      {partialFailures.length > 0 && (
        <MessageContainer variant="warning">
          <MessageContainer.Title>Some SLO sources could not be scanned</MessageContainer.Title>
          <MessageContainer.Description>{partialWarningMessage}</MessageContainer.Description>
        </MessageContainer>
      )}

      {/* 2. Re-scan toolbar */}
      <Flex
        flexDirection="row"
        alignItems="center"
        justifyContent="flex-end"
        gap={8}
        style={{ marginBottom: 8 }}
      >
        <Button variant="default" color="neutral" size="condensed" onClick={() => void run()}>
          Re-scan
        </Button>
      </Flex>

      {/* 3. Results table or empty state */}
      {results.length === 0 ? (
        <EmptyState>
          <EmptyState.Title>No classic SLO dependencies detected</EmptyState.Title>
          <EmptyState.Details>
            No SLOs referencing classic {provider} metrics or entity types were found.
          </EmptyState.Details>
        </EmptyState>
      ) : (
        <DataTable
          columns={SLO_COLUMNS}
          data={results}
          sortable
          resizable
          defaultSortBy={[{ id: 'status', desc: false }]}
        />
      )}
    </Flex>
  );
};
