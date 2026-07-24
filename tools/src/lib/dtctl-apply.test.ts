import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildApply, stripMigrationSuffix, REVIEW_SUFFIX } from './dtctl-apply.ts';

describe('stripMigrationSuffix', () => {
  it('removes review / rewritten markers, leaves clean names', () => {
    assert.equal(stripMigrationSuffix('Sales (migrated — review)'), 'Sales');
    assert.equal(stripMigrationSuffix('Sales (rewritten)'), 'Sales');
    assert.equal(stripMigrationSuffix('Sales'), 'Sales');
  });
});

describe('buildApply — create (review copy)', () => {
  const wrapper = {
    metadata: { id: 'orig-123', name: 'AWS Lambda', type: 'dashboard' },
    content: { version: 19, tiles: {}, settings: {} },
  };
  it('suffixes the name, mirrors into content.settings.name, omits id', () => {
    const a = buildApply({ wrapper, assetType: 'dashboard', mode: 'create' });
    assert.equal(a.name, `AWS Lambda${REVIEW_SUFFIX}`);
    assert.equal((a.content['settings'] as any).name, `AWS Lambda${REVIEW_SUFFIX}`);
    assert.equal(a.id, undefined);
    assert.equal(a.type, 'dashboard');
  });
  it('does not double-suffix an already-suffixed name', () => {
    const w = { metadata: { name: 'AWS Lambda (migrated — review)' }, content: {} };
    const a = buildApply({ wrapper: w, assetType: 'dashboard', mode: 'create' });
    assert.equal(a.name, `AWS Lambda${REVIEW_SUFFIX}`);
  });
  it('parses stringified content', () => {
    const w = { metadata: { name: 'X' }, content: JSON.stringify({ tiles: {}, settings: {} }) };
    const a = buildApply({ wrapper: w, assetType: 'dashboard', mode: 'create' });
    assert.equal(typeof a.content, 'object');
    assert.equal((a.content['settings'] as any).name, `X${REVIEW_SUFFIX}`);
  });
});

describe('buildApply — update (in-place cutover)', () => {
  const wrapper = {
    metadata: { id: 'orig-123', name: 'AWS Lambda (migrated — review)' },
    content: { tiles: {}, settings: { name: 'AWS Lambda (migrated — review)' } },
  };
  it('targets the original id and restores the unsuffixed name', () => {
    const a = buildApply({ wrapper, assetType: 'dashboard', mode: 'update', targetId: 'orig-123' });
    assert.equal(a.id, 'orig-123');
    assert.equal(a.name, 'AWS Lambda');
    assert.equal((a.content['settings'] as any).name, 'AWS Lambda');
  });
  it('throws without a targetId', () => {
    assert.throws(() => buildApply({ wrapper, assetType: 'dashboard', mode: 'update' }), /requires targetId/);
  });
});

describe('buildApply — notebooks', () => {
  it('sets top-level name, leaves sections content untouched, type notebook', () => {
    const w = { metadata: { id: 'nb-1', name: 'Runbook' }, content: { sections: [{ type: 'dql' }] } };
    const a = buildApply({ wrapper: w, assetType: 'notebook', mode: 'create' });
    assert.equal(a.type, 'notebook');
    assert.equal(a.name, `Runbook${REVIEW_SUFFIX}`);
    assert.ok(Array.isArray((a.content as any).sections));
    assert.equal((a.content as any).settings, undefined); // no dashboard settings injected
  });
});
