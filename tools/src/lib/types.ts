// Shared types. The schemas here are intentionally close to the reference
// project's `dac-aws-to-2ndgen-metrics.json` so this code stays portable.

export type CloudProvider = 'AWS' | 'Azure' | 'GCP';

export interface DacAwsMetricRow {
  cloudwatchNamespace: string;
  cloudwatchMetricName: string;
  cloudwatchDimensions: string[];
  secondGenMetricKey: string;
  dacRecommendedMetricKey: string;
  dacAutodiscoveredMetricKey: string;
  builtInMetricKey: string;
  endOfLife: boolean;
}

export interface DacAzureMetricRow {
  armResourceType: string;
  builtInMetricKey: string;
  supportingServiceMetricKey: string;
  dacRecommendedMetricKey: string;
  dacAutodiscoveredMetricKey: string;
  endOfLife: boolean;
}

export interface UnifiedMetricRow {
  provider: CloudProvider;
  /** CloudWatch namespace (AWS) or ARM resource type (Azure). */
  namespace: string;
  /** Underlying CW metric name (AWS); empty for Azure rows. */
  cloudwatchMetricName: string;
  /** Source CW dimensions (AWS); empty for Azure rows. */
  cloudwatchDimensions: string[];
  /**
   * Classic builtin key as recorded in the DAC mapping table. May be
   * "not-matched" when no classic builtin metric exists for this row.
   */
  classicBuiltInMetricKey: string | null;
  /**
   * Classic extension/2ndgen key (`ext:cloud.aws.*` style). Always present in
   * the source data — the DAC team builds this from the extension catalog.
   */
  classicExtensionMetricKey: string | null;
  /**
   * Resolved DAC metric key. Prefers `dacRecommendedMetricKey`; falls back to
   * `dacAutodiscoveredMetricKey`. Null only when both are "not-matched".
   */
  dacMetricKey: string | null;
  /** True when dacMetricKey came from `dacRecommendedMetricKey`. */
  isRecommended: boolean;
  /** True when this metric belongs to a service flagged as end-of-life. */
  endOfLife: boolean;
}

export interface UnifiedMapping {
  generated: string;
  source: {
    provider: CloudProvider;
    file: string;
    rowCount: number;
  };
  stats: {
    namespaces: number;
    rowsWithBuiltInMatch: number;
    rowsWithDacMatch: number;
    rowsWithRecommended: number;
    rowsWithEol: number;
  };
  rows: UnifiedMetricRow[];
}
