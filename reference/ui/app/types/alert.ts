export type AlertType = 'metric-event' | 'infrastructure-detection' | 'davis-ai';

export type AlertScanPhase = 'idle' | 'scanning' | 'done';

export interface AlertResult {
  /** Settings object ID */
  id: string;
  /** Human-readable alert name */
  name: string;
  /** Whether the alert is currently enabled */
  enabled: boolean;
  /** Which alert system this result came from */
  alertType: AlertType;
  /** Detected classic metric key patterns or entity type binding labels */
  classicPatterns: string[];
  /** Full raw metricKey or metricSelector expression (metric-event alerts only) */
  rawExpression?: string;
  /** Raw analyzer input field values that matched classic patterns (davis-ai alerts only) */
  rawAnalyzerInputs?: string[];
  /** For metric-event alerts: the query definition type from queryDefinition.type */
  metricEventQueryType?: 'METRIC_KEY' | 'METRIC_SELECTOR';
  /**
   * For metric-event METRIC_KEY alerts: the configured aggregation from queryDefinition.aggregation.
   * Known values: "AVG", "MAX", "MIN", "COUNT", "MEDIAN", "SUM", "VALUE"
   */
  metricEventAggregation?: string;
  /**
   * For metric-event METRIC_SELECTOR alerts: the monitoring strategy model type from modelProperties.type.
   * Known values: "STATIC_THRESHOLD", "AUTO_ADAPTIVE_THRESHOLD", "SEASONAL_BASELINE"
   * METRIC_KEY always implies STATIC_THRESHOLD — no need to store it separately for that type.
   */
  metricEventModelType?: string;
  /**
   * For metric-event STATIC_THRESHOLD alerts: threshold/window settings captured from
   * modelProperties, used to pre-populate a Davis AI anomaly detector.
   * Only present when modelProperties.type is STATIC_THRESHOLD, or when
   * queryDefinition.type is METRIC_KEY (which always implies STATIC_THRESHOLD).
   */
  rawModelProperties?: {
    threshold?: number;
    alertCondition?: string;
    violatingSamples?: number;
    dealertingSamples?: number;
    alertOnNoData?: boolean;
    /**
     * Total evaluation window size in samples (schema field "samples").
     * Maps directly to Davis AI slidingWindow.
     */
    samples?: number;
  };
  /**
   * For davis-ai alerts: the raw analyzer object from builtin:davis.anomaly-detectors.
   * Used to pre-populate the davis.analyzer intent payload for the "Create Anomaly Detector" action.
   */
  rawAnalyzer?: {
    name: string;
    input: Array<{ key: string; value: string }>;
  };
}

export interface AlertScanState {
  results: AlertResult[];
  phase: AlertScanPhase;
  /** Non-null only when ALL sub-scans fail */
  error: string | null;
  /** Names of failed sub-scans, e.g. ["Davis AI"] */
  partialFailures: string[];
  run: () => void;
}
