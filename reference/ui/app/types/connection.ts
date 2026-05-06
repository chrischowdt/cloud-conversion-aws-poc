export type CloudProvider = 'AWS' | 'Azure' | 'GCP';
export type ConnectionStatus = 'Classic' | 'New' | 'Parallel';
export type MigrationStatus = 'not-started' | 'in-progress' | 'parallel-detected' | 'complete';
/** Time window applied to all inventory queries.
 *  Controls how far back entity lifetime / Smartscape history / metric series are scanned. */
export type InventoryTimeframe = '12h' | '24h' | '7d' | '30d';
export type EnvironmentLifecyclePhase = 'assess' | 'plan' | 'execute' | 'complete';

// ─── Classic connection entity types ─────────────────────────────────────────

export type ClassicAwsConnection = {
  entityId: string;
  name: string;
  accountId: string | null;
};

export type NewAwsConnection = {
  entityId: string;
  name: string;
  accountId: string;
};

export type AwsInventory = {
  classicConnections: ClassicAwsConnection[];
  newConnections: NewAwsConnection[];
  parallelIngestion?: { overlappingAccountIds: string[] };
};

export type ClassicAzureConnection = {
  entityId: string;
  name: string;
  /** Azure subscription UUID — null for legacy credentials with no linked subscription */
  accountId: string | null;
  /** Azure AZURE_SUBSCRIPTION-* entity ID — null for legacy credentials with no linked subscription */
  subscriptionEntityId: string | null;
};

export type NewAzureConnection = {
  entityId: string;
  name: string;
  accountId: string;
};

export type AzureInventory = {
  classicConnections: ClassicAzureConnection[];
  newConnections: NewAzureConnection[];
  parallelIngestion?: { overlappingAccountIds: string[] };
};

export type ClassicGcpConnection = {
  entityId: string;
  /** GCP project ID — entity.name IS the project ID for dt.entity.cloud:gcp:project */
  name: string;
  accountId: string;
};

export type NewGcpConnection = {
  entityId: string;
  /** GCP project display name (not the slug) */
  name: string;
  accountId: string;
};

export type GcpInventory = {
  classicConnections: ClassicGcpConnection[];
  newConnections: NewGcpConnection[];
  parallelIngestion?: { overlappingAccountIds: string[] };
};

// ─── Flat table row type ──────────────────────────────────────────────────────

export type CloudAccount = {
  provider: CloudProvider;
  /** Human-readable credential / connection name */
  name: string;
  /** AWS account number, Azure subscription UUID, or GCP project ID. Null for legacy Azure with no linked subscription. */
  accountId: string | null;
  status: ConnectionStatus;
  /** Classic entity ID — null for New-only accounts */
  entityId: string | null;
  /** Azure AZURE_SUBSCRIPTION-* entity ID — null for AWS and GCP */
  subscriptionEntityId: string | null;
  /** True when ≥2 classic AWS rows share the same awsAccountId */
  hasDuplicateAccountId: boolean;
  /** True when AWS CloudWatch Metric Streams traffic was detected for this account in the
   *  query window. Metric Streams is not yet supported by the new AWS connection — migration
   *  of Metric-Streams-enabled accounts is currently blocked at the platform level. */
  isMigrationBlocked: boolean;
};
