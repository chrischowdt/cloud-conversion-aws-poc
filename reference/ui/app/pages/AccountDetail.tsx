import React from 'react';
import { useLocation, useParams, Link } from 'react-router-dom';

import { Chip } from '@dynatrace/strato-components/content';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Text } from '@dynatrace/strato-components/typography';

import { StatusBadge } from '../components/StatusBadge';
import { OverviewTab } from '../components/OverviewTab';
import type { CloudProvider, ConnectionStatus } from '../types/connection';

// ─── Route state shape ────────────────────────────────────────────────────────

type AccountDetailState = {
  provider: CloudProvider;
  status: ConnectionStatus;
  connectionName: string;
  entityId: string | null;
  subscriptionEntityId: string | null;
} | null;

// ─── Main component ───────────────────────────────────────────────────────────

export const AccountDetail = () => {
  const { accountId } = useParams<{ accountId: string }>();
  const location = useLocation();
  const state = (location.state as AccountDetailState) ?? null;

  const provider: CloudProvider = state?.provider ?? 'AWS';
  const connectionName = state?.connectionName ?? accountId ?? 'Unknown';
  const status = state?.status;

  return (
    <Flex flexDirection="column" gap={16} padding={24}>
      {/* Back link + title */}
      <Flex flexDirection="row" alignItems="center" gap={8}>
        <Link to="/">← Back to Inventory</Link>
      </Flex>

      <Flex flexDirection="row" alignItems="center" gap={12} flexWrap="wrap">
        <Flex flexDirection="column" gap={2}>
          <Flex flexDirection="row" alignItems="center" gap={8}>
            <Heading level={2} style={{ margin: 0 }}>{accountId ?? connectionName}</Heading>
            {status && <StatusBadge status={status} />}
            <Chip color="neutral" size="condensed">{provider}</Chip>
          </Flex>
          {accountId && (
            <Text textStyle="small" style={{ color: 'var(--dt-color-text-subdued)' }}>
              {connectionName}
            </Text>
          )}
        </Flex>
      </Flex>

      <OverviewTab
        provider={provider}
        credentialEntityId={state?.entityId ?? null}
        subscriptionEntityId={state?.subscriptionEntityId ?? null}
        accountId={accountId ?? null}
      />
    </Flex>
  );
};
