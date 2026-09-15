/**
 * entity-candidates — derive classic→Smartscape entity mappings from the product
 * team's `dac-aws-to-2ndgen-entities.json`, instead of hand-maintaining them.
 *
 * WHY. `entity-mappings.ts` is curated by hand, and a classic type missing from
 * it becomes a BLOCKING `unmapped-entity-type` that can hold a whole dashboard
 * out of review. Every such type we chased down by hand (`cloud:aws:ecs`,
 * `cloud:aws:ecs:cluster`, `cloud:aws:emr`, `cloud:aws:kafka`,
 * `cloud:aws:cloud_front`) turned out to be sitting in the skill's entity file
 * already. Measured across the two tenants, that file covers 37 further types we
 * don't map — 143 references on nic55601 and 225 on sfz80352.
 *
 * WHY WE STILL PROBE. CLAUDE.md records that the file's `dacResourceType` has
 * the wrong granularity for node-type derivation, and that held up: the derived
 * name is a good CANDIDATE, not an answer. `AWS::ECS::Cluster` → `AWS_ECS_CLUSTER`
 * is right, but plenty of resource types have no Smartscape node at all, and at
 * least one guess this week (`AWS_KAFKA_CLUSTER`) does not exist — classic
 * `cloud:aws:kafka` is MSK. So `discover-entity-candidates` asks the tenant
 * whether each candidate node type exists before anything is written, and only
 * verified entries are ever loaded.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One row of the skill's entity file (only the fields we read). */
interface SkillEntityRow {
  supportingServiceEntityType?: string;
  builtInEntityType?: string;
  dacResourceType?: string;
  dacSemDictTitle?: string;
  endOfLife?: boolean;
}

export interface EntityCandidate {
  /** Classic type segment after `dt.entity.` (e.g. `cloud:aws:ecs`). */
  classicEntityType: string;
  /** Candidate Smartscape node type (e.g. `AWS_ECS_CLUSTER`). */
  smartscapeNodeType: string;
  /** `dt.smartscape.<lowercased node type>` — the convention the tests enforce. */
  smartscapeDimension: string;
  /** What it was derived from, so a wrong guess is traceable. */
  dacResourceType: string;
  title?: string;
}

const NOT_MATCHED = 'not-matched';

/**
 * `AWS::ECS::Cluster` → `AWS_ECS_CLUSTER`.
 *
 * Deliberately simple and deliberately not clever: the point is to produce a
 * name the tenant can be asked about, not to be right by construction.
 */
export function nodeTypeFromResourceType(dacResourceType: string): string | null {
  const parts = dacResourceType.split('::').filter(Boolean);
  if (parts.length < 2) return null;
  if (parts[0]!.toUpperCase() !== 'AWS') return null;
  return parts
    .map((p) => p.replace(/[^A-Za-z0-9]/g, ''))
    .join('_')
    .toUpperCase();
}

export function smartscapeDimFor(nodeType: string): string {
  return `dt.smartscape.${nodeType.toLowerCase()}`;
}

/**
 * Pull every (classic type → candidate node type) pair out of the skill file.
 * Both the custom-device type and the built-in type map to the same resource.
 */
export function deriveCandidates(json: unknown): EntityCandidate[] {
  const rows = Array.isArray(json) ? (json as SkillEntityRow[]) : [];
  const out = new Map<string, EntityCandidate>();
  for (const r of rows) {
    const resourceType = typeof r.dacResourceType === 'string' ? r.dacResourceType : '';
    if (!resourceType || resourceType === NOT_MATCHED) continue;
    const nodeType = nodeTypeFromResourceType(resourceType);
    if (!nodeType) continue;
    for (const f of [r.supportingServiceEntityType, r.builtInEntityType]) {
      if (typeof f !== 'string' || !f || f === NOT_MATCHED) continue;
      const classic = f.toLowerCase();
      if (out.has(classic)) continue;
      out.set(classic, {
        classicEntityType: classic,
        smartscapeNodeType: nodeType,
        smartscapeDimension: smartscapeDimFor(nodeType),
        dacResourceType: resourceType,
        title: r.dacSemDictTitle,
      });
    }
  }
  return [...out.values()];
}

export interface EntityCandidateFile {
  generated: string;
  tenant?: string;
  /** Only entries whose node type was confirmed to exist on the tenant. */
  verified: EntityCandidate[];
  /** Candidates the tenant rejected — kept so the next run doesn't re-probe blindly. */
  rejected?: Array<{ classicEntityType: string; smartscapeNodeType: string; reason: string }>;
}

export async function loadEntityCandidates(path: string): Promise<EntityCandidate[]> {
  const file = JSON.parse(await readFile(path, 'utf8')) as EntityCandidateFile;
  return Array.isArray(file.verified) ? file.verified : [];
}

/** `<tenantDir>/entity-candidates.json` if discovery has been run, else undefined. */
export function entityCandidatesPathIfPresent(tenantDir: string | undefined): string | undefined {
  if (!tenantDir) return undefined;
  const p = join(tenantDir, 'entity-candidates.json');
  return existsSync(p) ? p : undefined;
}
