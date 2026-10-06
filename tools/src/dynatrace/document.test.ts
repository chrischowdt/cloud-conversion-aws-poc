import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { DocumentClient } from './document.ts';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Capture the URL of the next fetch and return a 201. */
function captureUrl(): { urls: string[] } {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    urls.push(String(url));
    return new Response('{}', { status: 201 });
  }) as typeof fetch;
  return { urls };
}

/**
 * A fake Document API: `shares` are the document's existing direct shares
 * (access → recipients). Records every write as "METHOD url body".
 */
function fakeShares(shares: Record<string, Array<{ id: string; type: string }>> = {}): { writes: string[] } {
  const writes: string[] = [];
  const list = Object.entries(shares).map(([access, _], i) => ({ id: `s${i}`, access: access === 'read' ? ['read'] : ['read', 'write'] }));
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? 'GET';
    if (method === 'GET' && /\/direct-shares\?/.test(u)) return new Response(JSON.stringify({ 'direct-shares': list }), { status: 200 });
    const rec = u.match(/\/direct-shares\/(s\d+)\/recipients\?/);
    if (method === 'GET' && rec) return new Response(JSON.stringify({ recipients: Object.values(shares)[Number(rec[1]!.slice(1))] }), { status: 200 });
    writes.push(`${method} ${u} ${init?.body ?? ''}`);
    return new Response(u.includes('/recipients/') ? null : '{}', { status: u.includes('/recipients/') ? 204 : 201 });
  }) as typeof fetch;
  return { writes };
}

const client = new DocumentClient({ baseUrl: 'https://x.apps.dynatrace.com', token: 't' });

describe('DocumentClient share notification suppression', () => {
  it('shareWithGroup defaults to send-notification=false (no team email)', async () => {
    const cap = fakeShares();
    await client.shareWithGroup('doc-1', 'grp-1');
    assert.match(cap.writes[0]!, /^POST \S+\/direct-shares\?send-notification=false&admin-access=true /);
  });

  it('shareWithGroup honors notify=true', async () => {
    const cap = fakeShares();
    await client.shareWithGroup('doc-1', 'grp-1', 'read-write', true);
    assert.match(cap.writes[0]!, /send-notification=true&admin-access=true /);
  });
});

describe('DocumentClient.grantDirect — one direct share per access level', () => {
  it('joins the existing share at that level instead of creating a second (which is HTTP 409)', async () => {
    const cap = fakeShares({ 'read-write': [{ id: 'review-group', type: 'group' }] });
    await client.shareWithUser('doc-1', 'u1');
    assert.equal(cap.writes.length, 1);
    assert.match(cap.writes[0]!, /^POST \S+\/direct-shares\/s0\/recipients\/add\?send-notification=false&admin-access=true \{"recipients":\[\{"id":"u1","type":"user"\}\]\}$/);
  });

  it('is a no-op when the recipient is already on that share (a re-run or restage)', async () => {
    const cap = fakeShares({ 'read-write': [{ id: 'grp-1', type: 'group' }] });
    await client.shareWithGroup('doc-1', 'grp-1');
    assert.deepEqual(cap.writes, []);
  });

  it('creates a share when the document has none at that level', async () => {
    const cap = fakeShares({ read: [{ id: 'x', type: 'user' }] });
    await client.shareWithGroup('doc-1', 'grp-1', 'read-write');
    assert.match(cap.writes[0]!, /^POST \S+\/direct-shares\?/);
  });
});

describe('DocumentClient environment share notification suppression', () => {

  it('shareEnvironment defaults to send-notification=false', async () => {
    const cap = captureUrl();
    await client.shareEnvironment('doc-1');
    assert.match(cap.urls[0]!, /\/environment-shares\?send-notification=false&admin-access=true$/);
  });
});
