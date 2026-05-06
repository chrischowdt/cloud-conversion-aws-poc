import React, { useMemo, useState } from 'react';

import { Button } from '@dynatrace/strato-components/buttons';
import { Chip, EmptyState, MessageContainer, ProgressCircle } from '@dynatrace/strato-components/content';
import { Flex } from '@dynatrace/strato-components/layouts';
import { DataTable, type DataTableColumnDef } from '@dynatrace/strato-components/tables';
import { Paragraph } from '@dynatrace/strato-components/typography';

import { AlertDetailPanel } from './AlertDetailPanel';
import { useAlertScan } from '../hooks/useAlertScan';
import { isMigratable, hasEndOfLifeMetrics } from '../utils/metricKeyMapping';
import type { CloudProvider } from '../types/connection';
import type { AlertResult } from '../types/alert';

// ─── Alert type display maps ──────────────────────────────────────────────────

const ALERT_TYPE_LABELS: Record<string, string> = {
  'metric-event': 'Metric Event',
  'infrastructure-detection': 'Infrastructure Detection',
  'davis-ai': 'Davis AI',
};

const ALERT_TYPE_COLORS: Record<string, 'primary' | 'neutral' | 'success'> = {
  'metric-event': 'primary',
  'infrastructure-detection': 'neutral',
  'davis-ai': 'success',
};

// ─── Component ────────────────────────────────────────────────────────────────

export const AlertsTab = ({
  provider,
}: {
  provider: CloudProvider;
}) => {
  const { results, phase, error, partialFailures, run } = useAlertScan({ provider });
  const [selectedAlert, setSelectedAlert] = useState<AlertResult | null>(null);

  const ALERT_COLUMNS = useMemo<DataTableColumnDef<AlertResult>[]>(
    () => [
      {
        id: 'name',
        header: 'Alert Name',
        accessor: 'name',
        cell: ({ value }) => (
          <DataTable.DefaultCell>{value as string}</DataTable.DefaultCell>
        ),
      },
      {
        id: 'alertType',
        header: 'Type',
        accessor: (row: AlertResult) => row,
        width: 180,
        cell: ({ value }) => {
          const alert = value as AlertResult;
          let label = ALERT_TYPE_LABELS[alert.alertType] ?? String(alert.alertType);
          if (alert.alertType === 'metric-event' && alert.metricEventQueryType) {
            label =
              alert.metricEventQueryType === 'METRIC_KEY'
                ? 'Metric Event · Key'
                : 'Metric Event · Expression';
          }
          return (
            <DataTable.DefaultCell>
              <Chip color={ALERT_TYPE_COLORS[alert.alertType] ?? 'neutral'} size="condensed">
                {label}
              </Chip>
            </DataTable.DefaultCell>
          );
        },
      },
      {
        id: 'migrationAssessment',
        header: 'Migration Assessment',
        accessor: (row: AlertResult) => row,
        width: 170,
        cell: ({ value }) => {
          const alert = value as AlertResult;
          if (alert.alertType === 'infrastructure-detection' || provider === 'GCP') {
            return (
              <DataTable.DefaultCell>
                <Chip color="warning" size="condensed">Review Required</Chip>
              </DataTable.DefaultCell>
            );
          }
          if (hasEndOfLifeMetrics(alert.classicPatterns, provider)) {
            return (
              <DataTable.DefaultCell>
                <Chip color="critical" size="condensed">End of Life</Chip>
              </DataTable.DefaultCell>
            );
          }
          const migratable = isMigratable(alert.classicPatterns, provider);
          return (
            <DataTable.DefaultCell>
              <Chip color={migratable ? 'success' : 'warning'} size="condensed">
                {migratable ? 'Migratable' : 'Review Required'}
              </Chip>
            </DataTable.DefaultCell>
          );
        },
      },
      {
        id: 'enabled',
        header: 'Status',
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
    [provider],
  );

  // ── Idle state ──────────────────────────────────────────────────────────────
  if (phase === 'idle') {
    return (
      <Flex flexDirection="column" gap={16} padding={16}>
        <div>
          <Button variant="emphasized" color="primary" onClick={() => void run()}>
            Scan for alerts
          </Button>
        </div>
      </Flex>
    );
  }

  // ── Scanning state ──────────────────────────────────────────────────────────
  if (phase === 'scanning') {
    return (
      <Flex flexDirection="column" alignItems="center" padding={32} gap={12}>
        <ProgressCircle value="indeterminate" aria-label="Scanning alert configurations" />
        <Paragraph>Scanning alert configurations for classic {provider} references…</Paragraph>
      </Flex>
    );
  }

  // ── Results state ───────────────────────────────────────────────────────────

  // Full error: all sub-scans failed
  if (error) {
    return (
      <Flex flexDirection="column" gap={12} padding={16}>
        <MessageContainer variant="critical">
          <MessageContainer.Title>Scan failed</MessageContainer.Title>
          <MessageContainer.Description>
            {error}
          </MessageContainer.Description>
        </MessageContainer>
        <div>
          <Button variant="default" color="neutral" size="condensed" onClick={() => void run()}>
            Retry
          </Button>
        </div>
      </Flex>
    );
  }

  // Build partial warning message (one banner for all failed sources per compliance standard)
  const partialWarningMessage = partialFailures
    .map((source) => {
      if (source === 'Custom Metric Events')
        return 'Custom metric events could not be loaded. Results may be incomplete.';
      if (source === 'Infrastructure Detection')
        return 'Infrastructure anomaly detection settings could not be loaded. Results may be incomplete.';
      if (source === 'Davis AI')
        return 'Davis AI detectors could not be scanned — the app may not be installed in this environment.';
      return `${source} could not be scanned. Results may be incomplete.`;
    })
    .join(' ');

  return (
    <Flex flexDirection="column" gap={12} padding={16}>
      {/* 1. Partial warning banner — shown before the table so user knows data may be incomplete */}
      {partialFailures.length > 0 && (
        <MessageContainer variant="warning">
          <MessageContainer.Title>Some alert sources could not be scanned</MessageContainer.Title>
          <MessageContainer.Description>{partialWarningMessage}</MessageContainer.Description>
        </MessageContainer>
      )}

      {/* 2. Re-scan toolbar — right-aligned above table/empty state */}
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
          <EmptyState.Title>No classic alert dependencies found</EmptyState.Title>
          <EmptyState.Details>
            No alert configurations referencing classic {provider} metrics or entity types were
            detected.
          </EmptyState.Details>
        </EmptyState>
      ) : (
        <DataTable
          columns={ALERT_COLUMNS}
          data={results}
          sortable
          resizable
          interactiveRows={{ autoActivate: false }}
          rowId={(row) => row.id}
          activeRow={selectedAlert?.id ?? null}
          onActiveRowChange={(activeRowId) =>
            setSelectedAlert(activeRowId ? (results.find((r) => r.id === activeRowId) ?? null) : null)
          }
        />
      )}

      {selectedAlert && (
        <AlertDetailPanel
          alert={selectedAlert}
          provider={provider}
          onClose={() => setSelectedAlert(null)}
        />
      )}
    </Flex>
  );
};
