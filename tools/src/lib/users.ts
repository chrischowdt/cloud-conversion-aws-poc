/**
 * users — resolve a Dynatrace user UUID to a human-readable email.
 *
 * Documents record their owner as a user UUID, which is useless in a tracker a
 * human has to work from ("who owns this dashboard?" should not require a
 * lookup). There is no simple non-Account-Management API for id -> email, but
 * the query-execution audit trail carries both, so we harvest the pairs from
 * there:
 *
 *   fetch dt.system.query_executions, from: now()-90d
 *   | fields user.email, user.id
 *   | dedup user.email
 *
 * CAVEAT worth stating plainly: this only knows users who RAN A QUERY in the
 * window. Someone who owns a dashboard but hasn't run a DQL query in 90 days
 * simply won't be in it (135 of 159 owners resolved on this tenant). So an
 * unresolved owner means "not seen recently", not "not a real user" — we leave
 * the raw id in place rather than blanking it, so the row is still traceable.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** user UUID -> email address. */
export type UserIndex = Map<string, string>;

interface UsersFile {
  users?: Array<{ id?: string; email?: string }>;
}

/** Build the lookup from a `users.json` produced by `discover-users`. */
export function buildUserIndex(file: unknown): UserIndex {
  const idx: UserIndex = new Map();
  for (const u of (file as UsersFile)?.users ?? []) {
    if (u?.id && u?.email && !idx.has(u.id)) idx.set(u.id, u.email);
  }
  return idx;
}

/** Load `users.json` into a lookup; empty map when it hasn't been discovered. */
export async function loadUsers(path: string): Promise<UserIndex> {
  try {
    return buildUserIndex(JSON.parse(await readFile(path, 'utf8')));
  } catch {
    return new Map();
  }
}

/**
 * Resolve `<tenantDir>/users.json` if present. Nothing changes unless the tenant
 * has been probed (`discover-users`), so the owner column keeps showing raw ids
 * rather than going blank.
 */
export function usersPathIfPresent(tenantDir: string | undefined): string | undefined {
  if (!tenantDir) return undefined;
  const p = join(tenantDir, 'users.json');
  return existsSync(p) ? p : undefined;
}

/**
 * Email for a user id, or `undefined` when we've never seen them. Service
 * accounts surface as `<uuid>@service.sso.dynatrace.com`, which is not a person
 * — reported as-is so a reader can tell it apart from a real owner.
 */
export function emailForUser(index: UserIndex | undefined, userId: string | undefined): string | undefined {
  if (!index || !userId) return undefined;
  return index.get(userId);
}
