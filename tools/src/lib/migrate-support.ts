/**
 * migrate-support — small shared helpers for the migrate-* mutating commands.
 * Node-only (fs); kept out of the App-portable core.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AssetType } from './dtctl-apply.ts';
import type { DtctlEnvelope } from '../dynatrace/dtctl.ts';

export const resourceSingular = (t: AssetType): string => (t === 'dashboard' ? 'dashboard' : 'notebook');
export const resourcePlural = (t: AssetType): string => (t === 'dashboard' ? 'dashboards' : 'notebooks');

/** Directory holding the downloaded originals for a type. */
export const downloadDir = (base: string, t: AssetType): string =>
  t === 'dashboard' ? join(base, 'dashboards', 'new') : join(base, 'notebooks');

/** Locate the downloaded original file for a document id (`<id>__<slug>.json`). */
export async function findOriginal(base: string, type: AssetType, id: string): Promise<string | null> {
  let files: string[];
  try {
    files = await readdir(downloadDir(base, type));
  } catch {
    return null;
  }
  const hit = files.find((f) => f.startsWith(`${id}__`) && f.endsWith('.json'));
  return hit ? join(downloadDir(base, type), hit) : null;
}

/** Best-effort: dig a document `version` (revision) out of a `dtctl get` envelope. */
export function versionFromGet(env: DtctlEnvelope): number | undefined {
  const r = env.result as unknown;
  const seen = new Set<unknown>();
  const dig = (o: unknown): number | undefined => {
    if (!o || typeof o !== 'object' || seen.has(o)) return undefined;
    seen.add(o);
    const rec = o as Record<string, unknown>;
    if (typeof rec['version'] === 'number') return rec['version'];
    if (rec['metadata'] && typeof rec['metadata'] === 'object') {
      const v = (rec['metadata'] as Record<string, unknown>)['version'];
      if (typeof v === 'number') return v;
    }
    for (const val of Object.values(rec)) {
      const found = dig(val);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  return dig(r);
}

/** Pull a document's `content` object out of a `dtctl get` envelope. */
export function contentFromGet(env: DtctlEnvelope): unknown {
  const r = env.result as Record<string, unknown> | undefined;
  if (r && typeof r === 'object' && 'content' in r) return (r as Record<string, unknown>)['content'];
  return undefined;
}
