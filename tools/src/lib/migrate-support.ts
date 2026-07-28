/**
 * migrate-support — small shared filesystem helpers for the migrate-* commands.
 * Node-only (fs); kept out of the App-portable core.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AssetType } from './doc-apply.ts';

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
