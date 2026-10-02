/**
 * entity-arns — classic entity id → the AWS ARN of the resource it named.
 *
 * WHY THIS EXISTS. A classic query can pin ONE resource by entity id:
 *
 *   filter: { dt.entity.custom_device == "CUSTOM_DEVICE-CFF4D22E40425D17" }
 *
 * Classic ids and Smartscape ids are different id spaces, so converting the
 * dimension while leaving the literal gives `dt.smartscape.<type> == "CUSTOM_…"`,
 * which can never match: the query parses, runs, and returns nothing. (Measured:
 * classic 1 record, converted 0, on every pinned OpenSearch detector tested.)
 * `toSmartscapeId()` does not help — it returns a custom device id unchanged.
 *
 * The ARN is the join key. Verified on nic55601:
 *   - the classic entity carries it (`arn:aws:es:us-east-2:351878376352:domain/cwe-logging-stg`)
 *   - the Smartscape node carries the identical string in `aws.arn`
 *   - the new METRIC series carries it too, as the dimension `aws.arn`, on 45 of
 *     45 services with live data — so the pin becomes `aws.arn == "<arn>"` directly
 *     on the metric, with no Smartscape id involved at all.
 *
 * The rewriter is offline and pure, and the classic entity may not exist forever,
 * so the id→ARN resolution is a DISCOVERED artifact (`discover-entity-arns`),
 * cached per tenant — the same pattern as enriched tags and management zones.
 *
 * No I/O except the loader. No Node-specific APIs beyond fs/path.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** What discovery learned about one classic entity id. */
export interface EntityArnEntry {
  /** The resource's ARN, or null when the classic entity has none / no longer exists. */
  arn: string | null;
  /** The classic entity's display name, when it was found. */
  name?: string | null;
  /** Classic entity type, from the id prefix (`custom_device`). */
  type: string;
  /** Why `arn` is null: the entity is gone, has no ARN, or its type can't be queried. */
  missing?: 'not-found' | 'no-arn' | 'type-unqueryable';
}

export type EntityArnIndex = Map<string, EntityArnEntry>;

/** A classic entity id: UPPER_TYPE-<16 hex>. `AWS_*` prefixes included — discovery decides. */
const CLASSIC_ID = /\b([A-Z][A-Z0-9_:]*-[0-9A-F]{16})\b/g;

/** Every classic-looking entity id in a blob of text (a query, or a whole JSON file). */
export function collectClassicIds(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(CLASSIC_ID)) out.add(m[1]!);
  return out;
}

/** The classic entity type an id belongs to: `CUSTOM_DEVICE-ABC…` → `custom_device`. */
export function classicTypeOfId(id: string): string {
  return id.slice(0, id.lastIndexOf('-')).toLowerCase();
}

/** Load `entity-arns.json` (from `discover-entity-arns`) into a lookup. */
export async function loadEntityArns(path: string): Promise<EntityArnIndex> {
  const j = JSON.parse(await readFile(path, 'utf8')) as {
    entities?: Record<string, Partial<EntityArnEntry>>;
  };
  const out: EntityArnIndex = new Map();
  for (const [id, e] of Object.entries(j.entities ?? {})) {
    out.set(id, {
      arn: typeof e.arn === 'string' && e.arn ? e.arn : null,
      name: e.name ?? null,
      type: e.type ?? classicTypeOfId(id),
      missing: e.missing,
    });
  }
  return out;
}

/**
 * Resolve `<tenantDir>/entity-arns.json` if present. Classic ids are
 * TENANT-SPECIFIC, so a map built for one tenant must never be applied to
 * another — which is why this is a per-tenant file, not a shared table.
 */
export function entityArnsPathIfPresent(tenantDir: string | undefined): string | undefined {
  if (!tenantDir) return undefined;
  const p = join(tenantDir, 'entity-arns.json');
  return existsSync(p) ? p : undefined;
}
