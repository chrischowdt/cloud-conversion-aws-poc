import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fetchUsedDocumentIds, APP_ID } from './asset-usage.ts';
import type { DqlClient } from '../dynatrace/dql.ts';

/** Duck-typed DqlClient stub that returns canned records and captures the query. */
function fakeClient(records: Record<string, unknown>[], capture: { query?: string }): DqlClient {
  return {
    async query(req: { query: string }) {
      capture.query = req.query;
      return { records };
    },
  } as unknown as DqlClient;
}

describe('fetchUsedDocumentIds', () => {
  it('parses rows into a documentId → usage map, coercing counts', async () => {
    const records = [
      { documentId: 'a', lastAccessed: '2026-07-01T00:00:00Z', accessCount: 5 },
      { documentId: 'b', lastAccessed: '2026-07-02T00:00:00Z', accessCount: '3' },
      { documentId: null, lastAccessed: 'x', accessCount: 9 }, // skipped
    ];
    const map = await fetchUsedDocumentIds(fakeClient(records, {}), APP_ID.dashboards, 90);
    assert.equal(map.size, 2);
    assert.equal(map.get('a')?.accessCount, 5);
    assert.equal(map.get('b')?.accessCount, 3); // "3" → 3
    assert.equal(map.get('b')?.lastAccessed, '2026-07-02T00:00:00Z');
    assert.equal(map.has('null'), false);
  });

  it('scopes the query to the given app.id and day window', async () => {
    const capture: { query?: string } = {};
    await fetchUsedDocumentIds(fakeClient([], capture), APP_ID.notebooks, 30);
    assert.match(capture.query!, /dynatrace\.notebooks/);
    assert.match(capture.query!, /now\(\)-30d/);
    assert.match(capture.query!, /\/platform\/document\/v1\/documents\//);
  });
});
