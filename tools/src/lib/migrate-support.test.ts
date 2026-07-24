import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resourceSingular, resourcePlural, versionFromGet, contentFromGet } from './migrate-support.ts';
import type { DtctlEnvelope } from '../dynatrace/dtctl.ts';

describe('resource names', () => {
  it('maps asset types to dtctl resource names', () => {
    assert.equal(resourceSingular('dashboard'), 'dashboard');
    assert.equal(resourcePlural('dashboard'), 'dashboards');
    assert.equal(resourceSingular('notebook'), 'notebook');
    assert.equal(resourcePlural('notebook'), 'notebooks');
  });
});

describe('versionFromGet', () => {
  const env = (result: unknown): DtctlEnvelope => ({ ok: true, result });
  it('finds a top-level version', () => {
    assert.equal(versionFromGet(env({ id: 'x', version: 13 })), 13);
  });
  it('finds a nested metadata.version', () => {
    assert.equal(versionFromGet(env({ metadata: { version: 8 }, content: {} })), 8);
  });
  it('returns undefined when absent', () => {
    assert.equal(versionFromGet(env({ id: 'x', content: {} })), undefined);
  });
});

describe('contentFromGet', () => {
  it('extracts the content object', () => {
    assert.deepEqual(contentFromGet({ ok: true, result: { content: { tiles: {} } } }), { tiles: {} });
  });
  it('undefined when no content', () => {
    assert.equal(contentFromGet({ ok: true, result: { id: 'x' } }), undefined);
  });
});
