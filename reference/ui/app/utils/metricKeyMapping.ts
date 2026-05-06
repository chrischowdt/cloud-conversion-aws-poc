import type { CloudProvider } from '../types/connection';

import awsMetricsData from '../../../docs/dac-aws-to-2ndgen-metrics.json';
import azureMetricsData from '../../../docs/dac-azure-to-2ndgen-metrics.json';
import eolServicesData from '../../../docs/end-of-life-services.json';

// ─── Entry interfaces ─────────────────────────────────────────────────────────

interface AwsMetricEntry {
  cloudwatchNamespace: string;
  builtInMetricKey: string;
  secondGenMetricKey: string;
  dacRecommendedMetricKey: string;
  dacAutodiscoveredMetricKey: string;
  endOfLife: boolean;
}

// Azure uses "supportingServiceMetricKey" where AWS uses "secondGenMetricKey"
interface AzureMetricEntry {
  armResourceType: string;
  builtInMetricKey: string;
  supportingServiceMetricKey: string;
  dacRecommendedMetricKey: string;
  dacAutodiscoveredMetricKey: string;
  endOfLife: boolean;
}

interface EolServiceEntry {
  cloud: string;
  resourceType: string;
  kind: string | null;
  endOfLifeDate: string;
  announcementUrl: string;
}

// ─── Index value ─────────────────────────────────────────────────────────────

interface IndexEntry {
  /**
   * The resolved DAC metric key. Prefers dacRecommendedMetricKey; falls back to
   * dacAutodiscoveredMetricKey. Null only when both are "not-matched".
   */
  dacMetricKey: string | null;
  /** True when dacMetricKey came from dacRecommendedMetricKey (vs autodiscovered fallback). */
  isRecommended: boolean;
  /** CloudWatch namespace (AWS) or ARM resource type (Azure). */
  namespace: string;
  /** Whether this metric entry belongs to an end-of-life service. */
  endOfLife: boolean;
}

// ─── EOL service info map ─────────────────────────────────────────────────────
// Maps "<cloud>:<resourceType>" → { endOfLifeDate, announcementUrl }
// For Azure, resourceType matches armResourceType. For AWS the EOL file uses
// CloudFormation resource types (not CW namespaces), so AWS lookups return null
// unless a future update adds CW-namespace-keyed entries.

const EOL_INFO_MAP = new Map<string, { endOfLifeDate: string; announcementUrl: string }>();
for (const entry of eolServicesData as EolServiceEntry[]) {
  const key = `${entry.cloud}:${entry.resourceType}`;
  if (!EOL_INFO_MAP.has(key)) {
    EOL_INFO_MAP.set(key, { endOfLifeDate: entry.endOfLifeDate, announcementUrl: entry.announcementUrl });
  }
}

// ─── Index builders ───────────────────────────────────────────────────────────
// Each map: classic source key → IndexEntry
// Entries where the source key itself is "not-matched" or empty are skipped.

function buildAwsIndex(): Map<string, IndexEntry> {
  const index = new Map<string, IndexEntry>();
  for (const entry of awsMetricsData as AwsMetricEntry[]) {
    const recommended =
      entry.dacRecommendedMetricKey && entry.dacRecommendedMetricKey !== 'not-matched'
        ? entry.dacRecommendedMetricKey
        : null;
    const autodiscovered =
      entry.dacAutodiscoveredMetricKey && entry.dacAutodiscoveredMetricKey !== 'not-matched'
        ? entry.dacAutodiscoveredMetricKey
        : null;
    const dacKey = recommended ?? autodiscovered;
    const value: IndexEntry = {
      dacMetricKey: dacKey,
      isRecommended: dacKey !== null && dacKey === recommended,
      namespace: entry.cloudwatchNamespace,
      endOfLife: entry.endOfLife === true,
    };
    if (entry.builtInMetricKey && entry.builtInMetricKey !== 'not-matched') {
      index.set(entry.builtInMetricKey, value);
    }
    if (entry.secondGenMetricKey && entry.secondGenMetricKey !== 'not-matched') {
      index.set(entry.secondGenMetricKey, value);
    }
  }
  return index;
}

function buildAzureIndex(): Map<string, IndexEntry> {
  const index = new Map<string, IndexEntry>();
  for (const entry of azureMetricsData as AzureMetricEntry[]) {
    const recommended =
      entry.dacRecommendedMetricKey && entry.dacRecommendedMetricKey !== 'not-matched'
        ? entry.dacRecommendedMetricKey
        : null;
    const autodiscovered =
      entry.dacAutodiscoveredMetricKey && entry.dacAutodiscoveredMetricKey !== 'not-matched'
        ? entry.dacAutodiscoveredMetricKey
        : null;
    const dacKey = recommended ?? autodiscovered;
    const value: IndexEntry = {
      dacMetricKey: dacKey,
      isRecommended: dacKey !== null && dacKey === recommended,
      namespace: entry.armResourceType,
      endOfLife: entry.endOfLife === true,
    };
    if (entry.builtInMetricKey && entry.builtInMetricKey !== 'not-matched') {
      index.set(entry.builtInMetricKey, value);
    }
    if (entry.supportingServiceMetricKey && entry.supportingServiceMetricKey !== 'not-matched') {
      index.set(entry.supportingServiceMetricKey, value);
    }
  }
  return index;
}

// ─── Supported namespace / service sets ──────────────────────────────────────
// A namespace/service is "supported" when it has at least one entry with a valid
// dacRecommendedMetricKey or dacAutodiscoveredMetricKey. Since dacAutodiscoveredMetricKey
// has 100% coverage in the current mapping files, all indexed namespaces qualify.

function buildAwsSupportedNamespaces(): Set<string> {
  const supported = new Set<string>();
  for (const entry of awsMetricsData as AwsMetricEntry[]) {
    const hasKey =
      (entry.dacRecommendedMetricKey && entry.dacRecommendedMetricKey !== 'not-matched') ||
      (entry.dacAutodiscoveredMetricKey && entry.dacAutodiscoveredMetricKey !== 'not-matched');
    if (hasKey) {
      supported.add(entry.cloudwatchNamespace);
    }
  }
  return supported;
}

function buildAzureSupportedServices(): Set<string> {
  const supported = new Set<string>();
  for (const entry of azureMetricsData as AzureMetricEntry[]) {
    const hasKey =
      (entry.dacRecommendedMetricKey && entry.dacRecommendedMetricKey !== 'not-matched') ||
      (entry.dacAutodiscoveredMetricKey && entry.dacAutodiscoveredMetricKey !== 'not-matched');
    if (hasKey) {
      supported.add(entry.armResourceType);
    }
  }
  return supported;
}

// All indexes and sets are built once at module load time (< 1 ms, ~7 500 entries)
const AWS_INDEX = buildAwsIndex();
const AZURE_INDEX = buildAzureIndex();
const AWS_SUPPORTED_NAMESPACES = buildAwsSupportedNamespaces();
const AZURE_SUPPORTED_SERVICES = buildAzureSupportedServices();

// ─── Public API ───────────────────────────────────────────────────────────────

/** End-of-life date and official announcement URL for a cloud service. */
export interface EndOfLifeInfo {
  endOfLifeDate: string;
  announcementUrl: string;
}

export interface MetricKeyLookupResult {
  /**
   * The new-connection DAC metric key. Prefers dacRecommendedMetricKey; falls back to
   * dacAutodiscoveredMetricKey. Null only when both are "not-matched", or for GCP.
   */
  dacMetricKey: string | null;
  /**
   * True when the classic key was found as a lookup key in the mapping table,
   * regardless of whether a DAC equivalent exists.
   * Always false for GCP or unknown providers.
   *
   * Note: Keys with prefix `dt.cloud.aws.*` or `dt.cloud.azure.*` are NOT indexed
   * in the mapping tables and return found: false.
   */
  found: boolean;
  /**
   * The CloudWatch namespace (AWS) or ARM resource type (Azure) that this classic
   * key belongs to in the mapping table.  Null for GCP (no mapping table) or when
   * the key is not found in the table.
   */
  namespace: string | null;
  /**
   * True when dacMetricKey came from dacRecommendedMetricKey (curated by Dynatrace).
   * False when it is a fallback from dacAutodiscoveredMetricKey.
   * Always false when found is false or provider is GCP.
   */
  isRecommended: boolean;
  /**
   * True when this metric belongs to a service flagged as end-of-life in the
   * mapping table.  Always false when found is false or provider is GCP.
   */
  endOfLife: boolean;
}

/**
 * Look up a classic metric key and return its new-connection DAC equivalent.
 *
 * - GCP → always `{ found: false, dacMetricKey: null, namespace: null, isRecommended: false, endOfLife: false }`
 * - Key is in the table with a valid key → `{ found: true, dacMetricKey: '<key>', isRecommended: <bool>, endOfLife: <bool>, namespace: '<ns>' }`
 * - Key is in the table but both recommended and autodiscovered are "not-matched" → `{ found: true, dacMetricKey: null, ... }`
 * - Key not in the table → `{ found: false, dacMetricKey: null, ... }`
 */
export function lookupMetricKey(classicKey: string, provider: CloudProvider): MetricKeyLookupResult {
  if (provider === 'GCP') {
    return { found: false, dacMetricKey: null, namespace: null, isRecommended: false, endOfLife: false };
  }

  const index = provider === 'AWS' ? AWS_INDEX : AZURE_INDEX;

  if (!index.has(classicKey)) {
    return { found: false, dacMetricKey: null, namespace: null, isRecommended: false, endOfLife: false };
  }

  const entry = index.get(classicKey)!;
  return {
    found: true,
    dacMetricKey: entry.dacMetricKey,
    namespace: entry.namespace,
    isRecommended: entry.isRecommended,
    endOfLife: entry.endOfLife,
  };
}

/**
 * Returns EOL date and announcement URL for a namespace/service, or null when not found.
 * For Azure, namespace is the ARM resource type which maps directly to end-of-life-services.json.
 * For AWS, the EOL file uses CloudFormation resource types (not CloudWatch namespaces) — returns null.
 */
export function getEndOfLifeInfo(namespace: string | null, provider: CloudProvider): EndOfLifeInfo | null {
  if (!namespace || provider === 'GCP') return null;
  const key = `${provider}:${namespace}`;
  return EOL_INFO_MAP.get(key) ?? null;
}

/**
 * Returns true when the given namespace/service has at least one metric with a
 * valid DAC metric key (recommended or autodiscovered) in the mapping table.
 * When true the user can add additional metrics from that namespace as custom
 * metrics in their new connection settings.
 *
 * Always returns false for GCP (no mapping table available).
 */
export function isServiceSupported(namespace: string | null, provider: CloudProvider): boolean {
  if (!namespace || provider === 'GCP') return false;
  if (provider === 'AWS') return AWS_SUPPORTED_NAMESPACES.has(namespace);
  if (provider === 'Azure') return AZURE_SUPPORTED_SERVICES.has(namespace);
  return false;
}

/**
 * Returns true only when every classic key in the array resolves to a non-null DAC metric key
 * for the given provider.  Returns false for GCP (no mapping table) or empty arrays.
 */
export function isMigratable(classicKeys: string[], provider: CloudProvider): boolean {
  if (provider === 'GCP' || classicKeys.length === 0) return false;
  return classicKeys.every((key) => {
    const { found, dacMetricKey } = lookupMetricKey(key, provider);
    return found && dacMetricKey !== null;
  });
}

/**
 * Returns true when any of the given classic keys resolves to a metric that is
 * flagged as end-of-life in the mapping table.
 * Always returns false for GCP (no mapping table) or empty arrays.
 */
export function hasEndOfLifeMetrics(classicKeys: string[], provider: CloudProvider): boolean {
  if (provider === 'GCP' || classicKeys.length === 0) return false;
  return classicKeys.some((key) => {
    const { found, endOfLife } = lookupMetricKey(key, provider);
    return found && endOfLife;
  });
}
