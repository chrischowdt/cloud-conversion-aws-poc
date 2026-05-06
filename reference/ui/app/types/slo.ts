export type SloType = 'Classic' | 'New';

export type SloStatus = 'SUCCESS' | 'WARNING' | 'FAILURE' | 'DEGRADED' | 'DISABLED' | 'UNKNOWN';

export type SloEvaluationType = 'AGGREGATE' | 'WINDOW' | 'CUMULATIVE' | 'DQL';

export type SloScanPhase = 'idle' | 'scanning' | 'done';

export interface SloResult {
  /** Unique SLO identifier */
  id: string;
  /** Human-readable SLO name */
  name: string;
  /** Classic or New (DQL-based) SLO */
  sloType: SloType;
  /** Current evaluation status */
  status: SloStatus;
  /** Whether the SLO is enabled */
  enabled: boolean;
  /** Evaluation type (Classic) or 'DQL' for new SLOs */
  evaluationType: SloEvaluationType;
  /** Numeric target threshold (0–100) */
  targetSuccess: number;
  /** Detected classic pattern strings (metric keys, entity type references) */
  classicPatterns: string[];
}

export interface SloScanState {
  results: SloResult[];
  phase: SloScanPhase;
  /** Non-null only when ALL sub-scans fail */
  error: string | null;
  /** Names of failed sub-scans, e.g. ["Classic SLOs (token required)"] */
  partialFailures: string[];
  run: () => void;
}
