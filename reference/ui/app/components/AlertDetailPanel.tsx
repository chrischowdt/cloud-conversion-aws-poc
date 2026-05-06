import React, { useMemo } from 'react';

import { Button, IntentButton } from '@dynatrace/strato-components/buttons';
import { Chip, CodeSnippet, MessageContainer, ProgressCircle } from '@dynatrace/strato-components/content';
import { Flex } from '@dynatrace/strato-components/layouts';
import { showToast } from '@dynatrace/strato-components/notifications';
import { Sheet } from '@dynatrace/strato-components/overlays';
import { ExternalLink, Heading, Paragraph } from '@dynatrace/strato-components/typography';
import { useDql } from '@dynatrace-sdk/react-hooks';
import type { IntentPayload } from '@dynatrace-sdk/navigation';

import type { AlertResult } from '../types/alert';
import type { CloudProvider } from '../types/connection';
import {
  isMigratable,
  isServiceSupported,
  lookupMetricKey,
  hasEndOfLifeMetrics,
  getEndOfLifeInfo,
  type EndOfLifeInfo,
} from '../utils/metricKeyMapping';

// ─── DQL suggestion builder ───────────────────────────────────────────────────

interface NotMatchedKey {
  key: string;
  /** CloudWatch namespace (AWS) or ARM resource type (Azure). Null when unavailable. */
  namespace: string | null;
  /** Whether the namespace/service has any recommended metrics in the new connection. */
  namespaceSupported: boolean;
}

interface DqlSuggestion {
  /**
   * The suggested DQL string, or null when suppressed because at least one key has
   * dacMetricKey="not-matched" (no recommended metric available in the new connection).
   */
  dql: string | null;
  /** Classic keys that are not found in the mapping table at all (found=false). */
  unmappedKeys: string[];
  /** Classic keys found in the table but explicitly marked as having no recommended equivalent. */
  notMatchedKeys: NotMatchedKey[];
  /** Resolved DAC metric keys (dacMetricKey values) for all successfully mapped classic keys. */
  mappedKeys: string[];
  /**
   * Classic keys that were resolved via dacAutodiscoveredMetricKey (not the curated recommended set).
   * The DQL substitution is still performed for these keys.
   */
  autodiscoveredKeys: string[];
}

function buildSuggestedDql(
  rawExpression: string,
  classicPatterns: string[],
  provider: CloudProvider,
): DqlSuggestion {
  let dql: string | null = rawExpression;
  const unmappedKeys: string[] = [];
  const notMatchedKeys: NotMatchedKey[] = [];
  const mappedKeys: string[] = [];
  const autodiscoveredKeys: string[] = [];

  for (const classicKey of classicPatterns) {
    const { found, dacMetricKey, namespace, isRecommended } = lookupMetricKey(classicKey, provider);
    if (found && dacMetricKey) {
      // Substitute the classic key with the new DAC metric key in the expression
      if (dql !== null) {
        dql = dql.split(classicKey).join(dacMetricKey);
      }
      mappedKeys.push(dacMetricKey);
      if (!isRecommended) {
        autodiscoveredKeys.push(classicKey);
      }
    } else if (found && dacMetricKey === null) {
      // Key is in the mapping table but both recommended and autodiscovered are "not-matched"
      notMatchedKeys.push({
        key: classicKey,
        namespace,
        namespaceSupported: isServiceSupported(namespace, provider),
      });
      dql = null; // suppress the DQL — it would be misleading without a substitution
    } else {
      // Key not in our mapping table at all — leave it in the expression as-is
      unmappedKeys.push(classicKey);
    }
  }

  // Wrap bare expressions in a minimal timeseries query (only when DQL is not suppressed)
  if (dql !== null) {
    const looksComplete =
      dql.trimStart().toLowerCase().startsWith('timeseries') ||
      dql.includes('\n') ||
      dql.includes('|');
    if (!looksComplete) {
      dql = `timeseries avg(${dql})`;
    }
  }

  return { dql, unmappedKeys, notMatchedKeys, mappedKeys, autodiscoveredKeys };
}

// ─── Anomaly detector intent payload builder ────────────────────────────────
// Constructs the payload for dynatrace.davis.anomalydetection/create_anomaly_detector_in_modal.
// - dt.query: the substituted DQL (required)
// - sourceApplication: this app’s ID (required)
// - davis.anomalydetector: pre-populates title and a default 12-minute queryOffset
// - davis.analyzer (when available):
//     davis-ai alerts     → taken as-is from the captured analyzer, only the embedded DQL is swapped
//     metric-event STATIC_THRESHOLD → reconstructed from rawModelProperties (threshold, alertCondition,
//                                     violatingSamples, samples↔slidingWindow, dealertingSamples)

type AnalyzerInput = { key: string; value: string };

function buildDetectorPayload(dql: string, alert: AlertResult): IntentPayload {
  const base: Record<string, unknown> = {
    'dt.query': dql,
    'sourceApplication': 'my.cloud.migration.helper',
    'davis.anomalydetector': {
      title: alert.name,
      queryOffset: 12,
    },
  };

  // davis-ai alerts: take the existing analyzer verbatim, substituting only the embedded query.
  if (alert.rawAnalyzer) {
    const inputObj: Record<string, string> = Object.fromEntries(
      alert.rawAnalyzer.input.map((inp: AnalyzerInput) => [
        inp.key,
        inp.key === 'query' ? dql : inp.value,
      ]),
    );
    base['davis.analyzer'] = {
      name: alert.rawAnalyzer.name,
      input: inputObj,
      labels: ['system.configurable-as-anomaly-detector'],
    };
    return base as IntentPayload;
  }

  // metric-event STATIC_THRESHOLD: reconstruct the analyzer from captured modelProperties.
  const mp = alert.rawModelProperties;
  if (mp) {
    const inputObj: Record<string, string> = { query: dql };
    if (mp.threshold !== undefined) inputObj.threshold = String(mp.threshold);
    if (mp.alertCondition) inputObj.alertCondition = mp.alertCondition;
    if (mp.alertOnNoData !== undefined) inputObj.alertOnMissingData = String(mp.alertOnNoData);
    if (mp.violatingSamples !== undefined) inputObj.violatingSamples = String(mp.violatingSamples);
    if (mp.samples !== undefined) inputObj.slidingWindow = String(mp.samples);
    if (mp.dealertingSamples !== undefined) inputObj.dealertingSamples = String(mp.dealertingSamples);
    base['davis.analyzer'] = {
      name: 'dt.statistics.ui.anomaly_detection.StaticThresholdAnomalyDetectionAnalyzer',
      input: inputObj,
      labels: ['system.configurable-as-anomaly-detector'],
    };
  }

  return base as IntentPayload;
}

// ─── Short metric name helper ────────────────────────────────────────────────
// Strips the prefix (ext:, builtin:) and the provider cloud prefix (cloud.aws., cloud.azure.)
// so we display e.g. "storagegateway.cachePercentDirtyByRegionShareId" instead of the full key.

function shortMetricName(classicKey: string, provider: CloudProvider): string {
  let key = classicKey;
  for (const prefix of ['ext:', 'builtin:']) {
    if (key.startsWith(prefix)) {
      key = key.slice(prefix.length);
      break;
    }
  }
  if (provider === 'AWS' && key.startsWith('cloud.aws.')) {
    key = key.slice('cloud.aws.'.length);
  } else if (provider === 'Azure' && key.startsWith('cloud.azure.')) {
    key = key.slice('cloud.azure.'.length);
  }
  return key;
}

// ─── Not-matched message helper ───────────────────────────────────────────────
// Renders two dedicated banners:
//   1. Namespace/service support status (green = supported, amber = not supported)
//   2. "Metric not in recommended set" detail — shown only when namespace IS supported

function NotMatchedMessage({
  item,
  provider,
}: {
  item: NotMatchedKey;
  provider: CloudProvider;
}): React.ReactElement {
  const nsCode = item.namespace ? <code>{item.namespace}</code> : null;

  if (provider === 'AWS') {
    const metricLabel = shortMetricName(item.key, 'AWS');
    return (
      <Flex flexDirection="column" gap={4}>
        {/* Banner 1: CloudWatch namespace support status */}
        {item.namespaceSupported ? (
          <MessageContainer variant="success">
            <MessageContainer.Title>CloudWatch namespace supported</MessageContainer.Title>
            <MessageContainer.Description>
              <div style={{ wordBreak: 'break-word' }}>
                The CloudWatch namespace {nsCode} is supported by the new AWS connection. Metrics
                from this namespace that aren&apos;t in the recommended set can be added manually
                as{' '}
                <ExternalLink href="https://docs.dynatrace.com/docs/shortlink/aws-cloudwatch-metrics#advanced-metric-ingest-use-cases">
                  custom CloudWatch metrics
                </ExternalLink>.
              </div>
            </MessageContainer.Description>
          </MessageContainer>
        ) : (
          <MessageContainer variant="warning">
            <MessageContainer.Title>CloudWatch namespace not supported</MessageContainer.Title>
            <MessageContainer.Description>
              <div style={{ wordBreak: 'break-word' }}>
                The CloudWatch namespace {nsCode ?? 'for this metric'} is not currently supported
                by the new AWS connection. You can still monitor any CloudWatch metric by
                configuring it as a{' '}
                <ExternalLink href="https://docs.dynatrace.com/docs/shortlink/aws-cloudwatch-metrics#advanced-metric-ingest-use-cases">
                  custom CloudWatch metric
                </ExternalLink>.
              </div>
            </MessageContainer.Description>
          </MessageContainer>
        )}

        {/* Banner 2: metric not in recommended set — only shown when namespace is supported */}
        {item.namespaceSupported && (
          <MessageContainer variant="neutral">
            <MessageContainer.Title>Metric not in recommended set</MessageContainer.Title>
            <MessageContainer.Description>
              <div style={{ wordBreak: 'break-word' }}>
                <code>{metricLabel}</code>
                {nsCode ? <>{' '}({nsCode})</> : null}{' '}is not included in the{' '}
                <ExternalLink href="https://docs.dynatrace.com/docs/shortlink/aws-cloudwatch-metrics#mcs">
                  recommended metrics
                </ExternalLink>{' '}
                for this CloudWatch namespace. To monitor it, add it as a custom CloudWatch
                metric in your AWS connection settings.
              </div>
            </MessageContainer.Description>
          </MessageContainer>
        )}
      </Flex>
    );
  }

  if (provider === 'Azure') {
    const metricLabel = shortMetricName(item.key, 'Azure');
    return (
      <Flex flexDirection="column" gap={4}>
        {/* Banner 1: Azure service support status */}
        {item.namespaceSupported ? (
          <MessageContainer variant="success">
            <MessageContainer.Title>Azure service supported</MessageContainer.Title>
            <MessageContainer.Description>
              <div style={{ wordBreak: 'break-word' }}>
                The Azure service {nsCode} is supported by the new Azure connection. Metrics from
                this service that aren&apos;t in the recommended set can be added manually as
                custom metrics in your Azure connection settings.
              </div>
            </MessageContainer.Description>
          </MessageContainer>
        ) : (
          <MessageContainer variant="warning">
            <MessageContainer.Title>Azure service not supported</MessageContainer.Title>
            <MessageContainer.Description>
              <div style={{ wordBreak: 'break-word' }}>
                The Azure service {nsCode ?? 'for this metric'} is not currently supported by
                the new Azure connection.
              </div>
            </MessageContainer.Description>
          </MessageContainer>
        )}

        {/* Banner 2: metric not in recommended set — only shown when service is supported */}
        {item.namespaceSupported && (
          <MessageContainer variant="neutral">
            <MessageContainer.Title>Metric not in recommended set</MessageContainer.Title>
            <MessageContainer.Description>
              <div style={{ wordBreak: 'break-word' }}>
                <code>{metricLabel}</code>
                {nsCode ? <>{' '}({nsCode})</> : null}{' '}is not included in the recommended
                metrics for the new Azure connection. To monitor it, add it as a custom metric
                in your Azure connection settings.
              </div>
            </MessageContainer.Description>
          </MessageContainer>
        )}
      </Flex>
    );
  }

  // Fallback for any future provider
  return (
    <MessageContainer variant="warning">
      <MessageContainer.Title>Metric not in recommended set</MessageContainer.Title>
      <MessageContainer.Description>
        <div style={{ wordBreak: 'break-word' }}>
          The classic metric key <code>{item.key}</code> has no known equivalent in the
          recommended metrics of the new connection.
        </div>
      </MessageContainer.Description>
    </MessageContainer>
  );
}

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

interface AlertDetailPanelProps {
  alert: AlertResult;
  provider: CloudProvider;
  onClose: () => void;
}

export const AlertDetailPanel = ({ alert, provider, onClose }: AlertDetailPanelProps) => {
  // ── Migration assessment ───────────────────────────────────────────────────

  const migratable = useMemo(() => {
    if (alert.alertType === 'infrastructure-detection') return false;
    if (provider === 'GCP') return false;
    return isMigratable(alert.classicPatterns, provider);
  }, [alert.alertType, alert.classicPatterns, provider]);

  // ── End-of-life info ───────────────────────────────────────────────────────
  // Collect EOL details (date + announcement URL) for any classic key that
  // resolves to an end-of-life service. De-duplicated by namespace.

  const eolInfoItems = useMemo<Array<{ namespace: string; info: EndOfLifeInfo }>>(() => {
    if (alert.alertType === 'infrastructure-detection' || provider === 'GCP') return [];
    const seen = new Set<string>();
    const items: Array<{ namespace: string; info: EndOfLifeInfo }> = [];
    for (const key of alert.classicPatterns) {
      const { found, endOfLife, namespace } = lookupMetricKey(key, provider);
      if (found && endOfLife && namespace && !seen.has(namespace)) {
        seen.add(namespace);
        const info = getEndOfLifeInfo(namespace, provider);
        if (info) {
          items.push({ namespace, info });
        }
      }
    }
    return items;
  }, [alert.alertType, alert.classicPatterns, provider]);

  const isEndOfLife = eolInfoItems.length > 0 || hasEndOfLifeMetrics(alert.classicPatterns, provider);

  // ── DQL suggestions ────────────────────────────────────────────────────────

  // metric-event: one suggestion from rawExpression (or fallback to classicPatterns[0])
  const metricEventDql = useMemo<DqlSuggestion | null>(() => {
    if (alert.alertType !== 'metric-event') return null;
    const raw = alert.rawExpression ?? alert.classicPatterns[0];
    if (!raw) return null;
    return buildSuggestedDql(raw, alert.classicPatterns, provider);
  }, [alert.alertType, alert.rawExpression, alert.classicPatterns, provider]);

  // davis-ai: one suggestion per matching analyzer input
  const davisDqlSuggestions = useMemo<DqlSuggestion[]>(() => {
    if (alert.alertType !== 'davis-ai') return [];
    const inputs = alert.rawAnalyzerInputs ?? [];
    return inputs.map((input) => buildSuggestedDql(input, alert.classicPatterns, provider));
  }, [alert.alertType, alert.rawAnalyzerInputs, alert.classicPatterns, provider]);

  // A suggestion has content worth showing if it has a DQL, not-matched messages, or unmapped key warnings
  const suggestionHasContent = (s: DqlSuggestion) =>
    s.dql !== null || s.notMatchedKeys.length > 0 || s.unmappedKeys.length > 0;

  // GCP is fully handled by the Migration Assessment section — don't show a DQL block for it
  const hasDql =
    provider !== 'GCP' &&
    ((alert.alertType === 'metric-event' &&
      metricEventDql !== null &&
      suggestionHasContent(metricEventDql)) ||
      (alert.alertType === 'davis-ai' && davisDqlSuggestions.some(suggestionHasContent)));

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <Sheet
      show
      title={alert.name}
      onDismiss={onClose}
      actions={
        <Button variant="default" color="neutral" onClick={onClose}>
          Close
        </Button>
      }
    >
      <Flex flexDirection="column" gap={20} padding={4}>

        {/* ── Status row ────────────────────────────────────────────────────── */}
        <Flex flexDirection="row" gap={8} alignItems="center">
          <Chip
            color={ALERT_TYPE_COLORS[alert.alertType] ?? 'neutral'}
            size="condensed"
          >
            {ALERT_TYPE_LABELS[alert.alertType] ?? alert.alertType}
          </Chip>
          <Chip color={alert.enabled ? 'success' : 'neutral'} size="condensed">
            {alert.enabled ? 'Enabled' : 'Disabled'}
          </Chip>
          {provider === 'GCP' && (
            <Chip color="warning" size="condensed">GCP</Chip>
          )}
        </Flex>

        {/* ── Disabled alert warning ────────────────────────────────────────── */}
        {!alert.enabled && (
          <MessageContainer variant="warning">
            <MessageContainer.Title>Alert is currently disabled</MessageContainer.Title>
            <MessageContainer.Description>
              <div style={{ wordBreak: 'break-word' }}>
                This alert is currently disabled. It will still fail to fire on new connection
                data if not migrated before re-enabling.
              </div>
            </MessageContainer.Description>
          </MessageContainer>
        )}

        {/* ── Migration assessment ──────────────────────────────────────────── */}
        <Flex flexDirection="column" gap={8}>
          <Heading level={6}>Migration Assessment</Heading>
          {provider === 'GCP' ? (
            <Flex flexDirection="row" gap={8} alignItems="center">
              <Chip color="warning" size="condensed">Review Required</Chip>
              <Paragraph style={{ margin: 0, fontSize: '0.875em', color: 'var(--dt-colors-text-subtle)' }}>
                GCP metric mapping is not yet available — review manually.
              </Paragraph>
            </Flex>
          ) : alert.alertType === 'infrastructure-detection' ? (
            <Chip color="warning" size="condensed">Review Required</Chip>
          ) : isEndOfLife ? (
            <Chip color="critical" size="condensed">End of Life</Chip>
          ) : (
            <Chip color={migratable ? 'success' : 'warning'} size="condensed">
              {migratable ? 'Migratable' : 'Review Required'}
            </Chip>
          )}

          {/* EOL banners — show date + announcement link per affected service */}
          {isEndOfLife && eolInfoItems.map(({ namespace, info }) => (
            <MessageContainer key={namespace} variant="critical">
              <MessageContainer.Title>End-of-Life Service</MessageContainer.Title>
              <MessageContainer.Description>
                <div style={{ wordBreak: 'break-word' }}>
                  The service <code>{namespace}</code> has been retired or is approaching end
                  of life (date: {info.endOfLifeDate}). No migration action is needed for this
                  metric — the service will be decommissioned.{' '}
                  <ExternalLink href={info.announcementUrl}>Announcement</ExternalLink>
                </div>
              </MessageContainer.Description>
            </MessageContainer>
          ))}
          {/* When EOL is flagged but no EOL info entry was found (e.g. AWS CW namespace) */}
          {isEndOfLife && eolInfoItems.length === 0 && (
            <MessageContainer variant="critical">
              <MessageContainer.Title>End-of-Life Service</MessageContainer.Title>
              <MessageContainer.Description>
                <div style={{ wordBreak: 'break-word' }}>
                  One or more metrics referenced by this alert belong to a service that has been
                  flagged as end of life. Review the service’s documentation before migrating.
                </div>
              </MessageContainer.Description>
            </MessageContainer>
          )}
        </Flex>

        {/* ── Raw expression(s) ─────────────────────────────────────────────── */}
        <Flex flexDirection="column" gap={8}>
          <Heading level={6}>Classic Expression</Heading>

          {alert.alertType === 'infrastructure-detection' && (
            <MessageContainer variant="neutral">
              <MessageContainer.Title>No query — built-in toggle detector</MessageContainer.Title>
              <MessageContainer.Description>
                <div style={{ wordBreak: 'break-word' }}>
                  This is a built-in infrastructure anomaly detection settings object. It does
                  not use an explicit metric query — review manually whether the new
                  connection&apos;s built-in anomaly detection covers the same service.
                </div>
              </MessageContainer.Description>
            </MessageContainer>
          )}

          {alert.alertType === 'metric-event' && (
            <>
              <CodeSnippet showLineNumbers={false} size="condensed" allowCopy={false}>
                {alert.rawExpression ?? alert.classicPatterns.join('\n')}
              </CodeSnippet>
              <IntentButton
                payload={{ 'dt.settings.object_id': alert.id } as IntentPayload}
                options={{
                  recommendedAppId: 'dynatrace.classic.settings',
                  recommendedIntentId: 'settings-open-settings-by-id',
                }}
                variant="default"
                color="neutral"
              >
                Open in Classic Settings
              </IntentButton>
            </>
          )}

          {alert.alertType === 'davis-ai' && (
            <>
              {(alert.rawAnalyzerInputs ?? alert.classicPatterns).map((expr, i) => (
                <CodeSnippet key={i} showLineNumbers={false} size="condensed" allowCopy={false}>
                  {expr}
                </CodeSnippet>
              ))}
            </>
          )}
        </Flex>

        {/* ── Suggested DQL ─────────────────────────────────────────────────── */}
        {hasDql && (
          <Flex flexDirection="column" gap={8}>
            <Heading level={6}>Suggested DQL — review before use</Heading>
            <Paragraph style={{ margin: 0, fontSize: '0.875em', color: 'var(--dt-colors-text-subtle)' }}>
              Best-effort substitution of classic metric keys with new connection equivalents.
              Verify before use.
            </Paragraph>

            {alert.alertType === 'metric-event' && metricEventDql && (
              <>
                <DqlSuggestionBlock suggestion={metricEventDql} provider={provider} />
                {migratable && metricEventDql.mappedKeys.length > 0 && (
                  <MetricIngestionCheck dacMetricKeys={metricEventDql.mappedKeys} />
                )}
                {migratable && metricEventDql.dql !== null && (
                  <CreateDetectorAction dql={metricEventDql.dql} alert={alert} />
                )}
              </>
            )}

            {alert.alertType === 'davis-ai' &&
              davisDqlSuggestions.map((suggestion, i) => (
                <React.Fragment key={i}>
                  <DqlSuggestionBlock suggestion={suggestion} provider={provider} />
                  {migratable && suggestion.mappedKeys.length > 0 && (
                    <MetricIngestionCheck dacMetricKeys={suggestion.mappedKeys} />
                  )}
                  {migratable && suggestion.dql !== null && (
                    <CreateDetectorAction dql={suggestion.dql} alert={alert} />
                  )}
                </React.Fragment>
              ))}
          </Flex>
        )}
      </Flex>
    </Sheet>
  );
};

// ─── MetricIngestionCheck sub-component ─────────────────────────────────────
// Mounts a live DQL probe to check whether any of the resolved DAC metric keys
// are currently being ingested (last 24 h). Rendered only when migratable=true.
// Uses a separate sub-component so useDql can be called unconditionally (Rules of Hooks).

function MetricIngestionCheck({
  dacMetricKeys,
}: {
  dacMetricKeys: string[];
}): React.ReactElement {
  const query = useMemo(() => {
    if (dacMetricKeys.length === 0) return '';
    if (dacMetricKeys.length === 1) {
      return `fetch metric.series, from:now()-24h | filter metric.key == "${dacMetricKeys[0]}" | limit 1`;
    }
    const keysArray = dacMetricKeys.map((k) => `"${k}"`).join(',');
    return `fetch metric.series, from:now()-24h | filter in(metric.key, array(${keysArray})) | limit 1`;
  }, [dacMetricKeys]);

  const { data, error, isLoading } = useDql({ query }, { enabled: dacMetricKeys.length > 0 });

  if (isLoading) {
    return (
      <Flex flexDirection="row" gap={8} alignItems="center">
        <ProgressCircle size="small" />
        <Paragraph style={{ margin: 0, fontSize: '0.875em', color: 'var(--dt-colors-text-subtle)' }}>
          Checking metric ingestion…
        </Paragraph>
      </Flex>
    );
  }

  if (error) {
    // Non-fatal — ingestion check is best-effort
    return (
      <MessageContainer variant="neutral">
        <MessageContainer.Title>Ingestion check unavailable</MessageContainer.Title>
        <MessageContainer.Description>
          <div style={{ wordBreak: 'break-word' }}>
            Could not check whether this metric is currently being ingested. Verify your
            new cloud connection manually.
          </div>
        </MessageContainer.Description>
      </MessageContainer>
    );
  }

  const hasData = (data?.records?.length ?? 0) > 0;

  return hasData ? (
    <MessageContainer variant="success">
      <MessageContainer.Title>Metric is being ingested</MessageContainer.Title>
      <MessageContainer.Description>
        <div style={{ wordBreak: 'break-word' }}>
          Data was found for this metric in the last 24 hours — your new cloud connection
          is already ingesting it.
        </div>
      </MessageContainer.Description>
    </MessageContainer>
  ) : (
    <MessageContainer variant="warning">
      <MessageContainer.Title>No metric data in the last 24 hours</MessageContainer.Title>
      <MessageContainer.Description>
        <div style={{ wordBreak: 'break-word' }}>
          No data was found for this metric in the last 24 hours. Before creating a new
          alert, ensure your new cloud connection is configured to ingest this metric. It
          may also take up to 24 hours for recently enabled connections to appear.
        </div>
      </MessageContainer.Description>
    </MessageContainer>
  );
}

// ─── DqlSuggestionBlock sub-component ────────────────────────────────────────

function DqlSuggestionBlock({
  suggestion,
  provider,
}: {
  suggestion: DqlSuggestion;
  provider: CloudProvider;
}): React.ReactElement {
  return (
    <Flex flexDirection="column" gap={4}>
      {/* Successful DQL substitution */}
      {suggestion.dql !== null && (
        <CodeSnippet
          showLineNumbers={false}
          size="condensed"
          onCopy={() =>
            showToast({ title: 'DQL copied to clipboard', type: 'info', lifespan: 2000 })
          }
        >
          {suggestion.dql}
        </CodeSnippet>
      )}

      {/* Not-matched keys — metric exists in the mapping table but both recommended and
           autodiscovered are "not-matched" (no DAC equivalent available at all).
           NotMatchedMessage renders its own MessageContainer banners. */}
      {suggestion.notMatchedKeys.map((item, i) => (
        <NotMatchedMessage key={i} item={item} provider={provider} />
      ))}

      {/* Autodiscovered keys — resolved via autodiscovery, not the curated recommended set */}
      {suggestion.autodiscoveredKeys.length > 0 && (
        <MessageContainer variant="neutral">
          <MessageContainer.Title>Resolved via autodiscovery</MessageContainer.Title>
          <MessageContainer.Description>
            <div style={{ wordBreak: 'break-word' }}>
              The following key{suggestion.autodiscoveredKeys.length > 1 ? 's were' : ' was'} resolved
              using an autodiscovered metric key rather than the curated recommended set. The DQL
              substitution is still valid, but the key name may differ slightly from the recommended
              naming convention:{' '}
              <code>{suggestion.autodiscoveredKeys.join(', ')}</code>
            </div>
          </MessageContainer.Description>
        </MessageContainer>
      )}

      {/* Truly unmapped keys — classic key not found in our mapping table at all */}
      {suggestion.unmappedKeys.length > 0 && (
        <MessageContainer variant="warning">
          <MessageContainer.Title>Keys without mapping</MessageContainer.Title>
          <MessageContainer.Description>
            <div style={{ wordBreak: 'break-word' }}>
              The following classic keys have no known new-connection equivalent and were
              left as-is:{' '}
              <code>{suggestion.unmappedKeys.join(', ')}</code>
            </div>
          </MessageContainer.Description>
        </MessageContainer>
      )}
    </Flex>
  );
}

// ─── CreateDetectorAction sub-component ────────────────────────────────────────
// Renders the "Create Anomaly Detector" IntentButton with a contextual disclaimer.
// Only mounted when migratable === true and dql is non-null.

function CreateDetectorAction({
  dql,
  alert,
}: {
  dql: string;
  alert: AlertResult;
}): React.ReactElement {
  const hasAnalyzerData = !!(alert.rawAnalyzer || alert.rawModelProperties);
  return (
    <Flex flexDirection="column" gap={4}>
      <MessageContainer variant="neutral">
        <MessageContainer.Title>Create new anomaly detector</MessageContainer.Title>
        <MessageContainer.Description>
          <div style={{ wordBreak: 'break-word' }}>
            Opens the Anomaly Detection app to create a new detector pre-populated
            with the suggested DQL
            {hasAnalyzerData ? ', threshold and window settings,' : ''}
            {' '}alert name, and a default 12-minute query offset.
            Review and adjust before saving.
          </div>
        </MessageContainer.Description>
      </MessageContainer>
      <IntentButton
        payload={buildDetectorPayload(dql, alert)}
        options={{
          recommendedAppId: 'dynatrace.davis.anomalydetection',
          recommendedIntentId: 'create_anomaly_detector_in_modal',
        }}
        variant="default"
        color="primary"
      >
        Create Anomaly Detector
      </IntentButton>
    </Flex>
  );
}
