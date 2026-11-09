/**
 * A fake Settings API for the tests of the commands that write LIVE alerts
 * (publish, rollback) and the one that reads them (verify). It behaves like the
 * real API where it matters: every write gets a new update token, and a PUT with
 * any other token is refused with 409. Test support only; nothing here runs
 * against a tenant.
 */

import { SettingsApiError, type SettingsObject } from '../../dynatrace/settings.ts';

export interface Stored {
  value: Record<string, unknown>;
  /** Left out, a read returns no token. */
  updateToken?: string;
  schemaVersion?: string;
}

export interface Call {
  op: 'get' | 'put';
  id: string;
  body?: { value: Record<string, unknown>; updateToken?: string; schemaVersion?: string };
  validateOnly?: boolean;
}

export interface FakeSettingsHooks {
  /** Fail the nth read (0-based) of an alert. */
  getError?: (id: string, nth: number) => unknown;
  /** Fail the write before anything is stored. */
  putError?: (id: string) => unknown;
  /** Store the write, then fail as a lost response would. */
  putLandsThenFails?: (id: string) => unknown;
  /** What the server keeps of a written value (default: the value as sent). */
  stored?: (value: Record<string, unknown>) => Record<string, unknown>;
}

/** A Settings API over an in-memory store; `calls` lists every request in order. */
export function fakeSettings(store: Map<string, Stored>, hooks: FakeSettingsHooks = {}) {
  const calls: Call[] = [];
  let tokens = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const enter = async (): Promise<void> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setImmediate(r));
  };
  return {
    calls,
    maxInFlight: () => maxInFlight,
    async getObject(id: string): Promise<SettingsObject> {
      const nth = calls.filter((c) => c.op === 'get' && c.id === id).length;
      calls.push({ op: 'get', id });
      await enter();
      try {
        const err = hooks.getError?.(id, nth);
        if (err) throw err;
        const s = store.get(id);
        if (!s) throw new SettingsApiError(404, `https://example/settings/objects/${id}`, '{"error":{"message":"not found"}}');
        return { objectId: id, value: structuredClone(s.value), updateToken: s.updateToken, schemaVersion: s.schemaVersion };
      } finally {
        inFlight--;
      }
    },
    async putObject(
      id: string,
      body: { value: Record<string, unknown>; updateToken?: string; schemaVersion?: string },
      opts: { validateOnly?: boolean } = {},
    ): Promise<void> {
      calls.push({ op: 'put', id, body: structuredClone(body), validateOnly: opts.validateOnly });
      await enter();
      try {
        const err = hooks.putError?.(id);
        if (err) throw err;
        const s = store.get(id)!;
        if (body.updateToken !== s.updateToken) {
          throw new SettingsApiError(409, `https://example/settings/objects/${id}`, '{"error":{"message":"the object was modified"}}');
        }
        if (opts.validateOnly) return;
        const kept = hooks.stored ? hooks.stored(structuredClone(body.value)) : structuredClone(body.value);
        store.set(id, { value: kept, updateToken: `tok-${id}-w${++tokens}`, schemaVersion: s.schemaVersion });
        const lost = hooks.putLandsThenFails?.(id);
        if (lost) throw lost;
      } finally {
        inFlight--;
      }
    },
  };
}
