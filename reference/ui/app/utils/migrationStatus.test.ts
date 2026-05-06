import { deriveMigrationStatus, getMostAdvancedStatus } from './migrationStatus';

describe('deriveMigrationStatus', () => {
  it('returns not-started when only classic connections exist', () => {
    expect(
      deriveMigrationStatus({ hasClassic: true, hasNew: false, hasOverlappingAccounts: false })
    ).toBe('not-started');
  });

  it('returns complete when only new connections exist', () => {
    expect(
      deriveMigrationStatus({ hasClassic: false, hasNew: true, hasOverlappingAccounts: false })
    ).toBe('complete');
  });

  it('returns in-progress when both classic and new exist without overlap', () => {
    expect(
      deriveMigrationStatus({ hasClassic: true, hasNew: true, hasOverlappingAccounts: false })
    ).toBe('in-progress');
  });

  it('returns parallel-detected when overlapping accounts are present', () => {
    expect(
      deriveMigrationStatus({ hasClassic: true, hasNew: true, hasOverlappingAccounts: true })
    ).toBe('parallel-detected');
  });

  it('returns parallel-detected even when hasClassic and hasNew are false if overlap is true', () => {
    // overlapping takes precedence — guard against edge case in the data
    expect(
      deriveMigrationStatus({ hasClassic: false, hasNew: false, hasOverlappingAccounts: true })
    ).toBe('parallel-detected');
  });

  it('returns not-started when no connections at all', () => {
    expect(
      deriveMigrationStatus({ hasClassic: false, hasNew: false, hasOverlappingAccounts: false })
    ).toBe('not-started');
  });
});

describe('getMostAdvancedStatus', () => {
  it('returns not-started for an empty array', () => {
    expect(getMostAdvancedStatus([])).toBe('not-started');
  });

  it('returns the only status when the array has one item', () => {
    expect(getMostAdvancedStatus(['complete'])).toBe('complete');
    expect(getMostAdvancedStatus(['in-progress'])).toBe('in-progress');
  });

  it('returns the most advanced status from a mixed array', () => {
    expect(getMostAdvancedStatus(['not-started', 'parallel-detected', 'in-progress'])).toBe(
      'parallel-detected'
    );
  });

  it('returns complete when present alongside other statuses', () => {
    expect(getMostAdvancedStatus(['not-started', 'complete', 'in-progress'])).toBe('complete');
  });

  it('returns not-started when all entries are not-started', () => {
    expect(getMostAdvancedStatus(['not-started', 'not-started'])).toBe('not-started');
  });

  it('treats parallel-detected as less advanced than complete', () => {
    expect(getMostAdvancedStatus(['parallel-detected', 'complete'])).toBe('complete');
  });
});
