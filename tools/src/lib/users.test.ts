import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildUserIndex, emailForUser } from './users.ts';

describe('users', () => {
  const idx = buildUserIndex({
    users: [
      { id: 'u1', email: 'nathan@dynatrace.com' },
      { id: 'u2', email: 'svc@service.sso.dynatrace.com' },
      { id: 'u1', email: 'duplicate@should-be-ignored.com' },
    ],
  });

  it('maps id to email, first entry winning', () => {
    assert.equal(emailForUser(idx, 'u1'), 'nathan@dynatrace.com');
  });

  it('returns undefined for a user it has never seen — the caller keeps the raw id', () => {
    assert.equal(emailForUser(idx, 'never-seen'), undefined);
  });

  it('reports service accounts as-is so they are distinguishable from people', () => {
    assert.match(emailForUser(idx, 'u2')!, /@service\.sso\.dynatrace\.com$/);
  });

  it('is inert without an index', () => {
    assert.equal(emailForUser(undefined, 'u1'), undefined);
  });
});
