import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildApply, stripMigrationMarker, REVIEW_PREFIX } from './doc-apply.ts';

describe('stripMigrationMarker', () => {
  it('removes the review prefix and legacy suffixes, leaves clean names', () => {
    assert.equal(stripMigrationMarker('[MIGRATION REVIEW] Sales'), 'Sales');
    assert.equal(stripMigrationMarker('Sales (migrated — review)'), 'Sales');
    assert.equal(stripMigrationMarker('Sales (rewritten)'), 'Sales');
    assert.equal(stripMigrationMarker('Sales'), 'Sales');
  });
});

describe('buildApply — create (review copy)', () => {
  const wrapper = {
    metadata: { id: 'orig-123', name: 'AWS Lambda', type: 'dashboard' },
    content: { version: 19, tiles: {}, settings: {} },
  };
  it('prefixes the name, mirrors into content.settings.name, omits id', () => {
    const a = buildApply({ wrapper, assetType: 'dashboard', mode: 'create' });
    assert.equal(a.name, `${REVIEW_PREFIX}AWS Lambda`);
    assert.equal((a.content['settings'] as any).name, `${REVIEW_PREFIX}AWS Lambda`);
    assert.equal(a.id, undefined);
    assert.equal(a.type, 'dashboard');
  });
  it('does not double-mark an already-prefixed name', () => {
    const w = { metadata: { name: `${REVIEW_PREFIX}AWS Lambda` }, content: {} };
    const a = buildApply({ wrapper: w, assetType: 'dashboard', mode: 'create' });
    assert.equal(a.name, `${REVIEW_PREFIX}AWS Lambda`);
  });
  it('parses stringified content', () => {
    const w = { metadata: { name: 'X' }, content: JSON.stringify({ tiles: {}, settings: {} }) };
    const a = buildApply({ wrapper: w, assetType: 'dashboard', mode: 'create' });
    assert.equal(typeof a.content, 'object');
    assert.equal((a.content['settings'] as any).name, `${REVIEW_PREFIX}X`);
  });
});

describe('buildApply — update (in-place cutover)', () => {
  const wrapper = {
    metadata: { id: 'orig-123', name: `${REVIEW_PREFIX}AWS Lambda` },
    content: { tiles: {}, settings: { name: `${REVIEW_PREFIX}AWS Lambda` } },
  };
  it('targets the original id and restores the unmarked name', () => {
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
    assert.equal(a.name, `${REVIEW_PREFIX}Runbook`);
    assert.ok(Array.isArray((a.content as any).sections));
    assert.equal((a.content as any).settings, undefined);
  });
});
