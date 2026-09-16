/**
 * classic-problem — build a classic-shaped `problemDetails` object out of Grail
 * Davis data, so an event-management system that still speaks the classic
 * problem model (BigPanda here) keeps working after the AWS cloud-integration
 * migration.
 *
 * WHY THIS IS NEEDED. The new integration represents AWS resources only in the
 * Smartscape model. The classic problem system has no entity for them at all —
 * verified on nic55601: `id_classic` is null on 0/132 MSK clusters, 0/36,526
 * Lambda functions and 0/2,360 ECS clusters, and the resulting Davis problem
 * reports `affected_entity_ids: ["ENVIRONMENT-0000000000000001"]` with
 * `affected_entity_names: ["United Lower Environments"]`. That is not a lookup
 * failure; it is what classic has. When an unknown entity reaches the classic
 * system it falls back to the environment entity, and we deliberately do NOT
 * invent a substitute id — a fabricated identifier would be indistinguishable
 * from a real one to every downstream consumer.
 *
 * WHERE THE DATA COMES FROM. Everything below is a pure function of two Grail
 * reads plus one Smartscape lookup, so no classic API call (and no
 * `environment-api:problems:read` scope) is required:
 *
 *   dt.davis.problems  → the problem envelope (id, status, times, impact)
 *   dt.davis.events    → one record per `dt.davis.event_ids`, which is what
 *                        fills `evidenceDetails` (the firing query, the
 *                        detector's settings object, correlation id, …)
 *   smartscapeNodes    → entity name + tags, because `entity_tags`,
 *                        `primary_tags` and `smartscape.affected_entity.names`
 *                        are all NULL on these problems
 *
 * Kept free of Node APIs so the same code can be pasted into a workflow's
 * `run-javascript` task.
 */

/** A `dt.davis.problems` record (only the fields we read). */
export interface DavisProblemRecord {
  'event.id'?: string;
  display_id?: string;
  'event.name'?: string;
  'event.description'?: string;
  'event.category'?: string;
  'event.status'?: string;
  'event.status_transition'?: string;
  'event.start'?: string;
  'event.end'?: string;
  'dt.davis.impact_level'?: string[] | string | null;
  'dt.davis.event_ids'?: string[] | null;
  affected_entity_ids?: string[] | null;
  affected_entity_names?: string[] | null;
  'smartscape.affected_entity.ids'?: string[] | null;
  'smartscape.affected_entity.types'?: string[] | null;
  'smartscape.affected_entities'?: Array<{ id?: string; type?: string; name?: string }> | null;
  'maintenance.is_under_maintenance'?: boolean | null;
  'dt.davis.is_duplicate'?: boolean | null;
  'dt.davis.is_frequent_event'?: boolean | null;
  'labels.alerting_profile'?: string[] | null;
  root_cause_entity_name?: string | null;
  entity_tags?: string[] | null;
  primary_tags?: string[] | null;
  [k: string]: unknown;
}

/** A `dt.davis.events` record (only the fields we read). */
export interface DavisEventRecord {
  'event.id'?: string;
  'event.name'?: string;
  'event.type'?: string;
  'event.status'?: string;
  'event.start'?: string;
  'event.end'?: string;
  'dt.event.correlation_id'?: string | null;
  'dt.davis.is_rootcause_relevant'?: boolean | null;
  'dt.davis.is_frequent_event'?: boolean | null;
  'maintenance.is_under_maintenance'?: boolean | null;
  'dt.smartscape_source.id'?: string | null;
  'dt.smartscape_source.type'?: string | null;
  'dt.settings.object_id'?: string | null;
  'dt.settings.schema_id'?: string | null;
  'dt.query'?: string | null;
  query_string?: string | null;
  'event.provider'?: string | null;
  [k: string]: unknown;
}

/** A row from the Smartscape tag lookup. */
export interface EntityLookupRow {
  applicationci?: string | null;
  env?: string | null;
  ARN?: string | null;
  entity_name?: string | null;
  id?: string | null;
  [k: string]: unknown;
}

export interface ClassicEntityRef {
  entityId: { id: string; type: string };
  name: string;
}
export interface ClassicTag {
  context: string;
  key: string;
  value?: string;
  stringRepresentation: string;
}
export interface ClassicEvidenceDetail {
  startTime: number | null;
  endTime: number | null;
  eventId: string | null;
  eventType: string | null;
  displayName: string | null;
  evidenceType: string;
  rootCauseRelevant: boolean;
  entity: ClassicEntityRef | null;
  data: Record<string, unknown>;
}
export interface ClassicProblemDetails {
  problemId: string | null;
  displayId: string | null;
  title: string | null;
  impactLevel: string | null;
  severityLevel: string | null;
  status: string | null;
  startTime: number | null;
  endTime: number | null;
  affectedEntities: ClassicEntityRef[];
  impactedEntities: ClassicEntityRef[];
  rootCauseEntity: ClassicEntityRef | null;
  managementZones: Array<{ id: string; name: string }>;
  entityTags: ClassicTag[];
  problemFilters: Array<{ id: string; name: string }>;
  evidenceDetails: { totalCount: number; details: ClassicEvidenceDetail[] };
}

/** The environment entity classic falls back to when it has no real one. */
export const ENVIRONMENT_FALLBACK_PREFIX = 'ENVIRONMENT-';

const first = <T>(v: T[] | T | null | undefined): T | undefined =>
  Array.isArray(v) ? v[0] : (v ?? undefined);

/** Classic reports times as epoch millis; Grail gives ISO-8601 (or null). */
export function toEpochMillis(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Classic problem status. Grail carries both a status and a transition; the
 * transition is the more precise signal on the closing event (`RECOVERED`),
 * but classic only knows OPEN/CLOSED, so collapse to that.
 */
export function classicStatus(p: DavisProblemRecord): 'OPEN' | 'CLOSED' {
  const s = String(p['event.status'] ?? '').toUpperCase();
  if (s === 'CLOSED' || s === 'RESOLVED') return 'CLOSED';
  const t = String(p['event.status_transition'] ?? '').toUpperCase();
  if (t === 'CLOSED' || t === 'RECOVERED' || t === 'RESOLVED') return 'CLOSED';
  return 'OPEN';
}

/**
 * Parse a classic tag string (`applicationci:ccl`, `[AWS]env:stg`) into the
 * classic tag object. Values may legitimately contain a colon
 * (`RiskDataClass: Moderate:Internal`), so split on the FIRST one only.
 */
export function parseTag(raw: string): ClassicTag | null {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  let context = 'CONTEXTLESS';
  let rest = s;
  const ctx = /^\[([^\]]+)\]/.exec(s);
  if (ctx) {
    context = ctx[1]!.toUpperCase();
    rest = s.slice(ctx[0].length);
  }
  const i = rest.indexOf(':');
  const key = i >= 0 ? rest.slice(0, i) : rest;
  const value = i >= 0 ? rest.slice(i + 1) : undefined;
  if (!key) return null;
  return {
    context,
    key,
    ...(value !== undefined ? { value } : {}),
    stringRepresentation: value !== undefined ? `${key}:${value}` : key,
  };
}

/** Build the classic tag array from the Smartscape lookup + any event tags. */
export function buildEntityTags(
  rows: EntityLookupRow[],
  extra: Array<string | null | undefined> = []
): ClassicTag[] {
  const out: ClassicTag[] = [];
  const seen = new Set<string>();
  const push = (t: ClassicTag | null) => {
    if (!t) return;
    const k = `${t.context}|${t.key}|${t.value ?? ''}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  // Tag-shaped columns from the lookup, in a stable order.
  for (const row of rows ?? []) {
    for (const key of ['applicationci', 'env'] as const) {
      const v = row?.[key];
      if (v === null || v === undefined || v === '') continue;
      push({ context: 'CONTEXTLESS', key, value: String(v), stringRepresentation: `${key}:${String(v)}` });
    }
  }
  for (const raw of extra ?? []) if (raw) push(parseTag(String(raw)));
  return out;
}

/**
 * Affected entities.
 *
 * BigPanda builds its event metadata from `affectedEntities` / `impactedEntities`,
 * and for a migrated AWS resource the classic side of those is
 * `ENVIRONMENT-0000000000000001` — the fallback classic uses for an entity it
 * does not know. Every alert would collapse onto one "entity" and the metadata
 * would be useless, so by default we put the SMARTSCAPE entity here instead.
 *
 * This is knowingly not classic-shaped. It is also not fabricated: the id and
 * type are the real Smartscape identifiers, and the name comes from the live
 * lookup. The distinction matters — we are relabelling a field, not inventing
 * an identifier that could be mistaken for a classic one.
 *
 * Pass `useSmartscapeEntities: false` to restore strict classic passthrough
 * once BigPanda can read the entity from the evidence entry instead.
 */
export function buildAffectedEntities(
  p: DavisProblemRecord,
  rows: EntityLookupRow[] = [],
  useSmartscapeEntities = true
): ClassicEntityRef[] {
  const nameFor = (id: string): string => {
    const hit = (rows ?? []).find((r) => r?.id === id);
    if (hit?.entity_name) return String(hit.entity_name);
    const fromEvent = (p['smartscape.affected_entities'] ?? []).find((e) => e?.id === id);
    if (fromEvent?.name) return String(fromEvent.name);
    // Single-entity problems are the common case; if the lookup returned one
    // row and there is one entity, they are the same thing.
    const ids = p['smartscape.affected_entity.ids'] ?? [];
    if (ids.length === 1 && (rows ?? []).length === 1 && rows[0]?.entity_name) {
      return String(rows[0].entity_name);
    }
    return '';
  };

  if (useSmartscapeEntities) {
    const pairs = p['smartscape.affected_entities'] ?? [];
    const out: ClassicEntityRef[] = [];
    for (const e of pairs) {
      if (!e?.id) continue;
      out.push({ entityId: { id: e.id, type: e.type ?? classicTypeFromId(e.id) }, name: nameFor(e.id) });
    }
    if (out.length === 0) {
      // Fall back to the parallel id/type arrays when the object form is absent.
      const ids = p['smartscape.affected_entity.ids'] ?? [];
      const types = p['smartscape.affected_entity.types'] ?? [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (!id) continue;
        out.push({ entityId: { id, type: types[i] ?? classicTypeFromId(id) }, name: nameFor(id) });
      }
    }
    if (out.length > 0) return out;
    // No Smartscape entity at all → fall through to whatever classic reported.
  }

  const ids = p.affected_entity_ids ?? [];
  const names = p.affected_entity_names ?? [];
  const out: ClassicEntityRef[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!id) continue;
    out.push({ entityId: { id, type: classicTypeFromId(id) }, name: names[i] ?? '' });
  }
  return out;
}

/** `ENVIRONMENT-0000000000000001` → `ENVIRONMENT`. */
export function classicTypeFromId(id: string): string {
  const i = String(id).lastIndexOf('-');
  return i > 0 ? String(id).slice(0, i) : String(id);
}

/** One evidence entry per underlying Davis event. */
export function buildEvidenceDetail(
  e: DavisEventRecord,
  entityName: string | null | undefined
): ClassicEvidenceDetail {
  const ssId = e['dt.smartscape_source.id'] ?? null;
  const ssType = e['dt.smartscape_source.type'] ?? null;
  return {
    startTime: toEpochMillis(e['event.start']),
    endTime: toEpochMillis(e['event.end']),
    eventId: e['event.id'] ?? null,
    eventType: e['event.type'] ?? null,
    displayName: e['event.name'] ?? null,
    evidenceType: 'EVENT',
    rootCauseRelevant: e['dt.davis.is_rootcause_relevant'] === true,
    // The Smartscape id is a REAL identifier, just from the new model — passing
    // it is not the same as inventing one. Null when the event has none.
    entity: ssId ? { entityId: { id: ssId, type: ssType ?? '' }, name: entityName ?? '' } : null,
    data: {
      title: e['event.name'] ?? null,
      status: String(e['event.status'] ?? '').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
      startTime: toEpochMillis(e['event.start']),
      endTime: toEpochMillis(e['event.end']),
      eventId: e['event.id'] ?? null,
      eventType: e['event.type'] ?? null,
      correlationId: e['dt.event.correlation_id'] ?? null,
      frequentEvent: e['dt.davis.is_frequent_event'] === true,
      underMaintenance: e['maintenance.is_under_maintenance'] === true,
      suppressAlert: false,
      suppressProblem: false,
      managementZones: [],
      entityTags: [],
      // Not classic fields, but the useful part of the new model: what fired,
      // and which detector configuration fired it.
      dqlQuery: e['dt.query'] ?? e.query_string ?? null,
      settingsObjectId: e['dt.settings.object_id'] ?? null,
      settingsSchemaId: e['dt.settings.schema_id'] ?? null,
      eventProvider: e['event.provider'] ?? null,
      smartscapeEntityId: ssId,
      smartscapeEntityType: ssType,
    },
  };
}

export interface BuildInput {
  problem: DavisProblemRecord;
  /** `dt.davis.events` records for `dt.davis.event_ids`. May be empty. */
  events?: DavisEventRecord[];
  /** Rows from the Smartscape tag lookup. May be empty. */
  entities?: EntityLookupRow[];
  /**
   * Put the SMARTSCAPE entity in affectedEntities/impactedEntities rather than
   * the classic ENVIRONMENT fallback. On by default because BigPanda builds its
   * event metadata from those fields and the classic value is the same
   * placeholder for every AWS alert. Set false for strict classic passthrough.
   */
  useSmartscapeEntities?: boolean;
}

/**
 * Assemble the classic-shaped problemDetails.
 *
 * Total function: every field has a defined value for any input, including the
 * all-null problem records this data actually produces. Nothing here throws,
 * because it runs inside a workflow task where an exception loses the alert.
 */
export function buildClassicProblemDetails(input: BuildInput): ClassicProblemDetails {
  const p = input.problem ?? {};
  const events = input.events ?? [];
  const rows = input.entities ?? [];

  const entityName = rows.find((r) => r?.entity_name)?.entity_name ?? null;
  const entities = buildAffectedEntities(p, rows, input.useSmartscapeEntities !== false);
  const extraTags = [...(p.entity_tags ?? []), ...(p.primary_tags ?? [])];

  return {
    problemId: p['event.id'] ?? null,
    displayId: p.display_id ?? null,
    title: p['event.name'] ?? null,
    impactLevel: (first(p['dt.davis.impact_level']) as string | undefined) ?? null,
    severityLevel: p['event.category'] ?? null,
    status: classicStatus(p),
    startTime: toEpochMillis(p['event.start']),
    endTime: toEpochMillis(p['event.end']),
    affectedEntities: entities,
    // Classic distinguishes these; Davis gives one set, so they are the same.
    impactedEntities: entities,
    rootCauseEntity: p.root_cause_entity_name
      ? { entityId: { id: '', type: '' }, name: p.root_cause_entity_name }
      : null,
    managementZones: [],
    entityTags: buildEntityTags(rows, extraTags),
    problemFilters: (p['labels.alerting_profile'] ?? []).map((n) => ({ id: '', name: String(n) })),
    evidenceDetails: {
      totalCount: events.length,
      details: events.map((e) => buildEvidenceDetail(e, entityName)),
    },
  };
}
