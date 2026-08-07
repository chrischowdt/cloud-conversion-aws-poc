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

const client = new DocumentClient({ baseUrl: 'https://x.apps.dynatrace.com', token: 't' });

describe('DocumentClient share notification suppression', () => {
  it('shareWithGroup defaults to send-notification=false (no team email)', async () => {
    const cap = captureUrl();
    await client.shareWithGroup('doc-1', 'grp-1');
    assert.match(cap.urls[0]!, /\/direct-shares\?send-notification=false$/);
  });

  it('shareWithGroup honors notify=true', async () => {
    const cap = captureUrl();
    await client.shareWithGroup('doc-1', 'grp-1', 'read-write', true);
    assert.match(cap.urls[0]!, /send-notification=true$/);
  });

  it('shareEnvironment defaults to send-notification=false', async () => {
    const cap = captureUrl();
    await client.shareEnvironment('doc-1');
    assert.match(cap.urls[0]!, /\/environment-shares\?send-notification=false$/);
  });
});
