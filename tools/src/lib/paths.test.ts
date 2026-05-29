import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';

import { envIdFromBaseUrl, tenantOutDir, OUT_DIR } from './paths.ts';

describe('envIdFromBaseUrl', () => {
  it('extracts the env id from a SaaS apps host', () => {
    assert.equal(envIdFromBaseUrl('https://nic55601.apps.dynatrace.com'), 'nic55601');
  });

  it('handles a trailing slash and path', () => {
    assert.equal(envIdFromBaseUrl('https://abc12345.apps.dynatrace.com/'), 'abc12345');
    assert.equal(
      envIdFromBaseUrl('https://abc12345.apps.dynatrace.com/platform/storage/query/v1'),
      'abc12345'
    );
  });

  it('handles the live.dynatrace.com host form', () => {
    assert.equal(envIdFromBaseUrl('https://abc12345.live.dynatrace.com'), 'abc12345');
  });

  it('strips a port', () => {
    assert.equal(envIdFromBaseUrl('https://abc12345.apps.dynatrace.com:443'), 'abc12345');
  });

  it('extracts the env id from a managed-cluster /e/<id> path', () => {
    assert.equal(
      envIdFromBaseUrl('https://dt.internal.corp/e/a1b2c3d4-0000-1111-2222-333344445555'),
      'a1b2c3d4-0000-1111-2222-333344445555'
    );
  });

  it('falls back to a sanitized host for unrecognized shapes', () => {
    assert.equal(envIdFromBaseUrl('https://weird_host.example.com'), 'weird-host-example-com');
  });

  it('two different tenants never collide', () => {
    const a = envIdFromBaseUrl('https://nic55601.apps.dynatrace.com');
    const b = envIdFromBaseUrl('https://xyz98765.apps.dynatrace.com');
    assert.notEqual(a, b);
  });
});

describe('tenantOutDir', () => {
  it('derives tools/out/<envId> from a base URL', () => {
    assert.equal(
      tenantOutDir({ baseUrl: 'https://nic55601.apps.dynatrace.com' }),
      resolve(OUT_DIR, 'nic55601')
    );
  });

  it('honors an explicit --env label over the base URL', () => {
    assert.equal(
      tenantOutDir({ baseUrl: 'https://nic55601.apps.dynatrace.com', env: 'staging' }),
      resolve(OUT_DIR, 'staging')
    );
  });

  it('sanitizes an --env label', () => {
    assert.equal(
      tenantOutDir({ env: 'My Tenant!' }),
      resolve(OUT_DIR, 'my-tenant')
    );
  });

  it('honors an explicit --out-dir override verbatim, ignoring tenant identity', () => {
    assert.equal(
      tenantOutDir({ baseUrl: 'https://nic55601.apps.dynatrace.com', override: 'some/custom/dir' }),
      resolve('some/custom/dir')
    );
  });
});
