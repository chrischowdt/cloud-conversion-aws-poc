export type DashboardFormat = 'classic' | 'new';
export type DashboardOwnership = 'custom' | 'preset' | 'ready-made';

export type DashboardScanResult = {
  /** Dashboard ID */
  id: string;
  /** Dashboard display name */
  name: string;
  /** Deep-link URL to open the dashboard in Dynatrace */
  url: string;
  /** 'classic' = Config API v1 dashboard; 'new' = Document Service dashboard */
  format: DashboardFormat;
  /** 'custom' = user-created; 'preset' = DT preset (classic); 'ready-made' = shipped by an app (new) */
  ownership: DashboardOwnership;
  /** De-duplicated list of detected classic metric/entity prefix patterns */
  classicPatterns: string[];
  /** Dashboard owner identifier (raw user ID / email). Null for classic dashboards. */
  owner: string | null;
  /** Time of last modification. Null for classic dashboards. */
  lastModified: Date | null;
  /** Time the current user last opened the dashboard. Null for classic dashboards or if not available. */
  lastOpened: Date | null;
};

export type ScanPhase = 'idle' | 'scanning' | 'done';

export type DashboardScanState = {
  /** All matched dashboards from the last completed scan (unfiltered — preset/ready-made included). */
  results: DashboardScanResult[];
  phase: ScanPhase;
  error: string | null;
  /** Trigger or re-trigger the scan. */
  run: (includePresetAndReadyMade: boolean) => void;
};
