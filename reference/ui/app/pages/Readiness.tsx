import React, { useState } from 'react';

import { Button } from '@dynatrace/strato-components/buttons';
import { EmptyState, MessageContainer } from '@dynatrace/strato-components/content';
import { FormField, Label, TextInput, ToggleButtonGroup } from '@dynatrace/strato-components/forms';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Tab, Tabs } from '@dynatrace/strato-components/navigation';
import { Heading } from '@dynatrace/strato-components/typography';

import { AlertsTab } from '../components/AlertsTab';
import { DashboardsTab } from '../components/DashboardsTab';
import { SlosTab } from '../components/SlosTab';
import { useToken } from '../context/TokenContext';
import type { CloudProvider } from '../types/connection';

// ─── Token prompt banner ──────────────────────────────────────────────────────

const TokenBanner = () => {
  const { token, setToken } = useToken();
  const [draft, setDraft] = useState('');

  if (token !== null) {
    return (
      <MessageContainer variant="success">
        <MessageContainer.Description>
          API token set.{' '}
          <button
            onClick={() => setToken(null)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              textDecoration: 'underline',
              padding: 0,
              color: 'inherit',
            }}
          >
            Change
          </button>
        </MessageContainer.Description>
      </MessageContainer>
    );
  }

  return (
    <MessageContainer variant="primary">
      <MessageContainer.Title>Dynatrace API Token required for classic dashboard scan</MessageContainer.Title>
      <MessageContainer.Description>
        Scanning classic (Config API v1) dashboards requires a Dynatrace API token with{' '}
        <strong>ReadConfig</strong> scope. New dashboards are scanned without a token.
      </MessageContainer.Description>
      <MessageContainer.Actions>
        <Flex flexDirection="row" alignItems="flex-end" gap={8}>
          <FormField controlId="api-token-input">
            <Label htmlFor="api-token-input">Dynatrace API Token</Label>
            <TextInput
              type="password"
              value={draft}
              onChange={setDraft}
              placeholder="dt0c01.***"
            />
          </FormField>
          <Button
            variant="accent"
            onClick={() => {
              if (draft.trim()) setToken(draft.trim());
            }}
          >
            Save
          </Button>
        </Flex>
      </MessageContainer.Actions>
    </MessageContainer>
  );
};

// ─── Main component ───────────────────────────────────────────────────────────

export const Readiness = () => {
  const [provider, setProvider] = useState<CloudProvider>('AWS');
  const { token } = useToken();

  return (
    <Flex flexDirection="column" gap={16} padding={24}>
      <Heading level={2} style={{ margin: 0 }}>Migration Assessment</Heading>

      {/* Provider selector */}
      <Flex flexDirection="column" gap={8}>
        <ToggleButtonGroup
          value={provider ?? undefined}
          onChange={(val) => setProvider(val as CloudProvider)}
          aria-label="Select cloud provider"
        >
          <ToggleButtonGroup.Item value="AWS">AWS</ToggleButtonGroup.Item>
          <ToggleButtonGroup.Item value="Azure">Azure</ToggleButtonGroup.Item>
          <ToggleButtonGroup.Item value="GCP">GCP</ToggleButtonGroup.Item>
        </ToggleButtonGroup>
      </Flex>

      {/* Token banner — shown above tabs; relevant for Dashboards tab */}
      <TokenBanner />

      {/* Scan tabs */}
      <Tabs defaultIndex={0}>
        <Tab title="Dashboards">
          {/* key={provider} forces remount on provider change — useDashboardScan has no internal reset */}
          <DashboardsTab key={provider} provider={provider} token={token} />
        </Tab>

        <Tab title="Alerts">
          {/* AlertsTab self-resets via useEffect on provider change */}
          <AlertsTab key={provider} provider={provider} />
        </Tab>

        <Tab title="SLOs">
          <SlosTab key={provider} provider={provider} />
        </Tab>

        <Tab title="Workflows">
          <EmptyState key={provider}>
            <EmptyState.Title>Workflows scan coming soon</EmptyState.Title>
            <EmptyState.Details>
              Workflow scanning will be added in a future story.
            </EmptyState.Details>
          </EmptyState>
        </Tab>
      </Tabs>
    </Flex>
  );
};
