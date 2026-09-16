/**
 * Types for the plain-JS workflow task. The `.js` file is the artifact that
 * runs inside Dynatrace (a workflow cannot import TypeScript), so it stays
 * untyped JavaScript and this declaration lets the test compare it against the
 * typed reference implementation in `../lib/classic-problem.ts`.
 */
import type {
  BuildInput,
  ClassicProblemDetails,
  ClassicTag,
  DavisProblemRecord,
  EntityLookupRow,
} from '../lib/classic-problem.ts';

export function toEpochMillis(iso: string | null | undefined): number | null;
export function classicTypeFromId(id: string): string;
export function classicStatus(p: Partial<DavisProblemRecord> | null | undefined): 'OPEN' | 'CLOSED';
export function parseTag(raw: string): ClassicTag | null;
export function buildEntityTags(
  rows: EntityLookupRow[] | null | undefined,
  extra?: Array<string | null | undefined> | null
): ClassicTag[];
export function buildAffectedEntities(
  p: Partial<DavisProblemRecord>,
  rows?: EntityLookupRow[] | null,
  useSmartscapeEntities?: boolean
): ClassicProblemDetails['affectedEntities'];
export function buildClassicProblemDetails(input: BuildInput): ClassicProblemDetails;
