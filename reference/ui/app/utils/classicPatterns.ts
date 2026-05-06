import type { CloudProvider } from '../types/connection';

// ─── Classic metric key prefixes ──────────────────────────────────────────────

// Pattern sets per provider used by dashboard scanning (Story 002), metric
// events scanning (Story 004), and SLO scanning (Story 005).

const AWS_CLASSIC_METRIC_PREFIXES = [
  'dt.cloud.aws.',      // Definitive classic
  'builtin:cloud.aws.', // Classic dashboard tile (metric selector format)
  'ext:cloud.aws.',     // Classic extension — metric selector format
  // cloud.aws.<service>.<snake_case>  → classic non-builtin
  // cloud.aws.<service>.<PascalCase>.By.<Dim> → new connection (excluded by detection logic)
  'cloud.aws.',
] as const;

const AZURE_CLASSIC_METRIC_PREFIXES = [
  'dt.cloud.azure.',        // Definitive classic
  'builtin:cloud.azure.',   // Classic dashboard tile
  'ext:cloud.azure.',       // Classic extension
  'cloud.azure.microsoft_', // Ambiguous — classic non-builtin OR new Azure
] as const;

const GCP_CLASSIC_METRIC_PREFIXES = [
  // cloud.gcp.<api_googleapis_com>.<path>  → classic (2nd segment ends _googleapis_com)
  // cloud.gcp.<resource_type>.<api>.<path> → new connection (excluded by detection logic)
  'cloud.gcp.',
  'builtin:cloud.gcp.', // Classic dashboard tile
] as const;

export const CLASSIC_METRIC_PREFIXES: Record<CloudProvider, readonly string[]> = {
  AWS: AWS_CLASSIC_METRIC_PREFIXES,
  Azure: AZURE_CLASSIC_METRIC_PREFIXES,
  GCP: GCP_CLASSIC_METRIC_PREFIXES,
};

// ─── Classic entity types (for DQL tile detection in new dashboards) ──────────

// In new dashboards, `fetch dt.entity.<type>` is a definitive classic reference.
// New connections use smartscapeNodes syntax — not dt.entity.*.

const AWS_CLASSIC_ENTITY_TYPES = [
  'ec2_instance',
  'ebs_volume',
  'aws_lambda_function',
  'auto_scaling_group',
  'aws_application_load_balancer',
  'aws_network_load_balancer',
  'elastic_load_balancer',
  'relational_database_service',
  'dynamo_db_table',
] as const;

const AZURE_CLASSIC_ENTITY_TYPES = [
  'azure_vm',
  'azure_vm_scale_set',
  'azure_load_balancer',
  'azure_event_hub_namespace',
  'azure_event_hub',
  'azure_redis_cache',
  'azure_function_app',
  'azure_storage_account',
  'azure_cosmos_db',
  'azure_web_app',
  'azure_sql_server',
  'azure_sql_database',
] as const;

const GCP_CLASSIC_ENTITY_TYPES = [
  // GCP classic entities are custom_device with cloud:gcp:* subtypes.
  // Flag all `fetch dt.entity.custom_device` when provider is GCP.
  'custom_device',
] as const;

export const CLASSIC_ENTITY_TYPES: Record<CloudProvider, readonly string[]> = {
  AWS: AWS_CLASSIC_ENTITY_TYPES,
  Azure: AZURE_CLASSIC_ENTITY_TYPES,
  GCP: GCP_CLASSIC_ENTITY_TYPES,
};

// ─── Detection helpers ────────────────────────────────────────────────────────

/**
 * Returns the list of classic metric prefix patterns detected in the given string.
 * The returned list is de-duplicated.
 */
export function detectClassicMetricPatterns(
  text: string,
  provider: CloudProvider,
): string[] {
  const prefixes = CLASSIC_METRIC_PREFIXES[provider];
  const found = new Set<string>();
  const lower = text.toLowerCase();
  for (const prefix of prefixes) {
    // AWS cloud.aws.* — only flag when a classic non-builtin key is present.
    // New-connection keys follow: cloud.aws.<service>.<PascalCase>.By.<Dim>
    // Classic non-builtin keys follow: cloud.aws.<service>.<snake_case>
    if (provider === 'AWS' && prefix === 'cloud.aws.') {
      if (/cloud\.aws\.[a-z0-9_]+\.[a-z][a-z0-9_]*/.test(text)) {
        found.add(prefix);
      }
      continue;
    }

    // GCP cloud.gcp.* — only flag when a classic key is present.
    // Classic: cloud.gcp.<api_googleapis_com>.<path>  (2nd segment ends _googleapis_com)
    // New:     cloud.gcp.<resource_type>.<api>.<path>  (2nd segment is a resource type)
    if (provider === 'GCP' && prefix === 'cloud.gcp.') {
      if (/cloud\.gcp\.[a-z0-9]+_googleapis_com\./.test(text)) {
        found.add(prefix);
      }
      continue;
    }

    if (lower.includes(prefix.toLowerCase())) {
      found.add(prefix);
    }
  }
  // Azure: broad azure_* entity type catch in DQL strings
  if (provider === 'Azure' && /fetch\s+dt\.entity\.azure_/i.test(text)) {
    found.add('dt.entity.azure_*');
  }
  return Array.from(found);
}

/**
 * Extracts the actual classic metric key strings found in an arbitrary text
 * (metric key field, metric selector expression, DQL query, etc.).
 *
 * Unlike detectClassicMetricPatterns — which returns the matched prefix label — this
 * function returns the full key token (e.g. `ext:cloud.aws.ec2.cpu_utilization`)
 * stripped of any trailing aggregation/transformation suffix (`:avg`, `:value`, …).
 *
 * The same AWS/GCP disambiguation rules as detectClassicMetricPatterns are applied
 * so new-connection keys are not incorrectly flagged.
 */
export function extractClassicMetricKeys(
  text: string,
  provider: CloudProvider,
): string[] {
  const prefixes = CLASSIC_METRIC_PREFIXES[provider];
  const found = new Set<string>();
  const lowerText = text.toLowerCase();

  for (const prefix of prefixes) {
    const lowerPrefix = prefix.toLowerCase();
    let searchFrom = 0;

    while (searchFrom < lowerText.length) {
      const idx = lowerText.indexOf(lowerPrefix, searchFrom);
      if (idx === -1) break;

      // If the character immediately before this match is ':', the occurrence
      // is embedded inside a longer prefixed token (e.g. `ext:cloud.aws.*` or
      // `builtin:cloud.aws.*`). The longer-prefix iteration already captures the
      // full key — skip here to avoid producing duplicate entries.
      if (idx > 0 && lowerText[idx - 1] === ':') {
        searchFrom = idx + lowerPrefix.length;
        continue;
      }

      // Extract the full metric key token: word chars + dots + colons + hyphens
      const tokenMatch = text.slice(idx).match(/^[\w.:-]+/);
      if (tokenMatch) {
        // Strip trailing aggregation/transformation suffix, e.g. :avg, :value, :auto
        const key = tokenMatch[0].replace(
          /:(?:avg|min|max|sum|count|value|auto|fold|default|first|last|percentile\d*)\b.*/i,
          '',
        );

        // AWS: skip new-connection keys (PascalCase.By.Dimension pattern)
        if (provider === 'AWS' && key.startsWith('cloud.aws.')) {
          if (!/^cloud\.aws\.[a-z0-9_]+\.[a-z][a-z0-9_]*/.test(key)) {
            searchFrom = idx + 1;
            continue;
          }
        }

        // GCP: skip new-connection keys (2nd segment does not end in _googleapis_com)
        if (provider === 'GCP' && key.startsWith('cloud.gcp.')) {
          if (!/^cloud\.gcp\.[a-z0-9]+_googleapis_com\./.test(key)) {
            searchFrom = idx + 1;
            continue;
          }
        }

        found.add(key);
      }

      searchFrom = idx + prefix.length;
    }
  }

  return Array.from(found);
}

/**
 * Returns the list of classic entity type references detected in a DQL string.
 * Matches `fetch dt.entity.<type>` patterns.
 */
export function detectClassicEntityPatterns(
  text: string,
  provider: CloudProvider,
): string[] {
  const entityTypes = CLASSIC_ENTITY_TYPES[provider];
  const found = new Set<string>();
  for (const entityType of entityTypes) {
    const pattern = new RegExp(`fetch\\s+dt\\.entity\\.${entityType}\\b`, 'i');
    if (pattern.test(text)) {
      found.add(`dt.entity.${entityType}`);
    }
  }
  // Azure: catch any `fetch dt.entity.azure_*` not in the explicit list
  if (provider === 'Azure' && /fetch\s+dt\.entity\.azure_/i.test(text)) {
    found.add('dt.entity.azure_*');
  }
  return Array.from(found);
}

/**
 * Returns the list of classic entity type references detected in a Classic SLO
 * entity selector string (e.g. the `filter` field of a Classic SLO).
 *
 * Matches `type(<ENTITY_TYPE>)` patterns (case-insensitive).
 * For GCP, flags any `type(CUSTOM_DEVICE)` reference.
 *
 * Returns SCREAMING_SNAKE_CASE entity type strings (e.g. `["EC2_INSTANCE"]`).
 */
export function detectClassicEntitySelectorPatterns(
  selector: string,
  provider: CloudProvider,
): string[] {
  const entityTypes = CLASSIC_ENTITY_TYPES[provider];
  const found = new Set<string>();
  for (const entityType of entityTypes) {
    const typeUpper = entityType.toUpperCase();
    const pattern = new RegExp(`type\\(${typeUpper}\\)`, 'i');
    if (pattern.test(selector)) {
      found.add(typeUpper);
    }
  }
  return Array.from(found);
}
