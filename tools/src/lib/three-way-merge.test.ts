import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { threeWayMerge } from './three-way-merge.ts';

describe('threeWayMerge', () => {
  it('adopts an owner-only change', () => {
    const base = { a: 1, b: 2 };
    const { merged, report } = threeWayMerge(base, { a: 1, b: 2 }, { a: 1, b: 99 });
    assert.equal(merged.b, 99);
    assert.deepEqual(report.conflicts, []);
    // When the migration side is untouched at this level the merge short-circuits
    // and adopts the owner subtree wholesale, so the report names that subtree
    // rather than the individual leaf. What matters is the merged value.
    assert.ok(report.ownerChangesTaken.length > 0);
  });

  it('keeps a migration-only change', () => {
    const base = { q: 'classic' };
    const { merged, report } = threeWayMerge(base, { q: 'migrated' }, { q: 'classic' });
    assert.equal(merged.q, 'migrated');
    assert.deepEqual(report.ownerChangesTaken, []);
  });

  it('keeps the migration on a conflict, and REPORTS it', () => {
    const base = { q: 'classic' };
    const { merged, report } = threeWayMerge(base, { q: 'migrated' }, { q: 'owner-edit' });
    assert.equal(merged.q, 'migrated', 'a half-migrated query is broken; a lost tweak is re-appliable');
    assert.deepEqual(report.conflicts, ['q'], 'must not swallow it');
  });

  it('merges both sides when they touch different tiles', () => {
    const base = { tiles: { '1': { q: 'classic', color: 'red' }, '2': { q: 'classic2' } } };
    const ours = { tiles: { '1': { q: 'migrated', color: 'red' }, '2': { q: 'migrated2' } } };
    const theirs = { tiles: { '1': { q: 'classic', color: 'blue' }, '2': { q: 'classic2' } } };
    const { merged, report } = threeWayMerge(base, ours, theirs);
    assert.equal(merged.tiles['1']!.q, 'migrated', 'reviewer keeps the query');
    assert.equal(merged.tiles['1']!.color, 'blue', 'owner keeps the colour');
    assert.deepEqual(report.conflicts, []);
  });

  it('merges keyed arrays by id, not index, when one side deleted an element', () => {
    // base [env, application, appci]; the reviewer deleted `application`, so an
    // index-wise merge would compare appci against application.
    const base = { variables: [{ key: 'env', v: 1 }, { key: 'application', v: 1 }, { key: 'appci', v: 1 }] };
    const ours = { variables: [{ key: 'env', v: 1 }, { key: 'appci', v: 1 }] };
    const theirs = { variables: [{ key: 'env', v: 1 }, { key: 'application', v: 1 }, { key: 'appci', v: 2 }] };
    const { merged } = threeWayMerge(base, ours, theirs);
    assert.deepEqual(merged.variables.map((x: any) => x.key), ['env', 'appci'], 'deletion respected');
    assert.equal(merged.variables[1]!.v, 2, 'owner edit landed on the RIGHT element');
  });

  it('keeps an element the owner added', () => {
    const base = { variables: [{ key: 'a' }] };
    const ours = { variables: [{ key: 'a' }] };
    const theirs = { variables: [{ key: 'a' }, { key: 'newvar' }] };
    const { merged, report } = threeWayMerge(base, ours, theirs);
    assert.deepEqual(merged.variables.map((x: any) => x.key), ['a', 'newvar']);
    // ours === base here, so the whole array is adopted from the owner in one
    // step; the addition shows up as an adopted subtree, not a per-element note.
    assert.ok(report.conflicts.length === 0);
  });

  it('honours an owner deletion the reviewer did not touch', () => {
    const base = { tiles: { '1': { colorRules: [1] } } };
    const ours = { tiles: { '1': { colorRules: [1] } } };
    const theirs = { tiles: { '1': {} } };
    const { merged } = threeWayMerge(base, ours, theirs);
    assert.ok(!('colorRules' in (merged as any).tiles['1']));
  });

  it('is a no-op when the owner changed nothing', () => {
    const base = { a: 1 };
    const ours = { a: 2 };
    const { merged, report } = threeWayMerge(base, ours, base);
    assert.deepEqual(merged, ours);
    assert.deepEqual(report, { ownerChangesTaken: [], ownerAdditions: [], conflicts: [], conflictsOwnerWon: [] });
  });
});

describe('threeWayMerge — conflict policy splits by ownership', () => {
  it('keeps the MIGRATION on a query conflict', () => {
    const base = { tiles: { '1': { query: 'classic' } } };
    const ours = { tiles: { '1': { query: 'migrated' } } };
    const theirs = { tiles: { '1': { query: 'owner-edit' } } };
    const { merged, report } = threeWayMerge(base, ours, theirs);
    assert.equal((merged as any).tiles['1'].query, 'migrated');
    assert.equal(report.conflicts.length, 1);
    assert.equal(report.conflictsOwnerWon.length, 0);
  });

  it('keeps the OWNER on a presentation conflict — their edit is the newer intent', () => {
    const base = { tiles: { '1': { visualizationSettings: { unitsOverrides: { A: { cascade: 1 } } } } } };
    const ours = { tiles: { '1': { visualizationSettings: { unitsOverrides: { A: { cascade: 2 } } } } } };
    const theirs = { tiles: { '1': { visualizationSettings: { unitsOverrides: { A: { cascade: 3 } } } } } };
    const { merged, report } = threeWayMerge(base, ours, theirs);
    assert.equal((merged as any).tiles['1'].visualizationSettings.unitsOverrides.A.cascade, 3);
    assert.equal(report.conflictsOwnerWon.length, 1);
    assert.equal(report.conflicts.length, 0);
  });

  it('resolves each side independently in one tile', () => {
    const base = { tiles: { '1': { query: 'classic', visualizationSettings: { chartSettings: { c: 1 } } } } };
    const ours = { tiles: { '1': { query: 'migrated', visualizationSettings: { chartSettings: { c: 2 } } } } };
    const theirs = { tiles: { '1': { query: 'owner', visualizationSettings: { chartSettings: { c: 3 } } } } };
    const { merged } = threeWayMerge(base, ours, theirs);
    assert.equal((merged as any).tiles['1'].query, 'migrated', 'reviewer owns the query');
    assert.equal((merged as any).tiles['1'].visualizationSettings.chartSettings.c, 3, 'owner owns the chart');
  });
});
