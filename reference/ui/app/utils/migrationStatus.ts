import type { MigrationStatus } from '../types/connection';

const MIGRATION_PROGRESS_ORDER: MigrationStatus[] = [
  'not-started',
  'in-progress',
  'parallel-detected',
  'complete',
];

export function deriveMigrationStatus({
  hasClassic,
  hasNew,
  hasOverlappingAccounts,
}: {
  hasClassic: boolean;
  hasNew: boolean;
  hasOverlappingAccounts: boolean;
}): MigrationStatus {
  if (hasOverlappingAccounts) return 'parallel-detected';
  if (!hasClassic && hasNew) return 'complete';
  if (hasClassic && hasNew) return 'in-progress';
  return 'not-started';
}

export function getMostAdvancedStatus(statuses: MigrationStatus[]): MigrationStatus {
  let result: MigrationStatus = 'not-started';
  for (const s of statuses) {
    if (MIGRATION_PROGRESS_ORDER.indexOf(s) > MIGRATION_PROGRESS_ORDER.indexOf(result)) {
      result = s;
    }
  }
  return result;
}
