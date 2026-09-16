/**
 * Workflow task body: build a classic-shaped `problemDetails` from Grail Davis
 * data. Paste the whole file into the `run-javascript` task.
 *
 * Plain JavaScript on purpose — a workflow task cannot import from this repo,
 * so this is the artifact that actually runs. `classic-problem.ts` is the same
 * logic with types and is the reference implementation;
 * `classic-problem-task.test.ts` runs BOTH against the same fixture and fails
 * if they ever disagree, so this copy cannot silently drift.
 *
 * No classic API call and no `environment-api:problems:read` scope: everything
 * is read from Grail. See classic-problem.ts for why the classic entity is left
 * as the ENVIRONMENT fallback rather than synthesised.
 */

export function toEpochMillis(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

export function classicTypeFromId(id) {
  const s = String(id);
  const i = s.lastIndexOf('-');
  return i > 0 ? s.slice(0, i) : s;
}

export function classicStatus(p) {
  const s = String((p && p['event.status']) || '').toUpperCase();
  if (s === 'CLOSED' || s === 'RESOLVED') return 'CLOSED';
  const t = String((p && p['event.status_transition']) || '').toUpperCase();
  if (t === 'CLOSED' || t === 'RECOVERED' || t === 'RESOLVED') return 'CLOSED';
  return 'OPEN';
}

export function parseTag(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return null;
  let context = 'CONTEXTLESS';
  let rest = s;
  const ctx = /^\[([^\]]+)\]/.exec(s);
  if (ctx) {
    context = ctx[1].toUpperCase();
    rest = s.slice(ctx[0].length);
  }
  const i = rest.indexOf(':');
  const key = i >= 0 ? rest.slice(0, i) : rest;
  const value = i >= 0 ? rest.slice(i + 1) : undefined;
  if (!key) return null;
  const tag = { context, key };
  if (value !== undefined) tag.value = value;
  tag.stringRepresentation = value !== undefined ? key + ':' + value : key;
  return tag;
}

export function buildEntityTags(rows, extra) {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (!t) return;
    const k = t.context + '|' + t.key + '|' + (t.value === undefined ? '' : t.value);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  for (const row of rows || []) {
    for (const key of ['applicationci', 'env']) {
      const v = row ? row[key] : null;
      if (v === null || v === undefined || v === '') continue;
      push({ context: 'CONTEXTLESS', key, value: String(v), stringRepresentation: key + ':' + String(v) });
    }
  }
  for (const raw of extra || []) if (raw) push(parseTag(String(raw)));
  return out;
}

// BigPanda builds its event metadata from affectedEntities/impactedEntities,
// and the classic value for a migrated AWS resource is
// ENVIRONMENT-0000000000000001 for EVERY alert. So by default we put the
// Smartscape entity there instead. Knowingly not classic-shaped, but not
// fabricated either: the id and type are real Smartscape identifiers.
// Pass useSmartscapeEntities=false for strict classic passthrough.
export function buildAffectedEntities(p, rows, useSmartscapeEntities) {
  const useSs = useSmartscapeEntities !== false;
  const lookup = rows || [];
  const nameFor = (id) => {
    const hit = lookup.find((r) => r && r.id === id);
    if (hit && hit.entity_name) return String(hit.entity_name);
    const pairs = (p && p['smartscape.affected_entities']) || [];
    const fromEvent = pairs.find((e) => e && e.id === id);
    if (fromEvent && fromEvent.name) return String(fromEvent.name);
    const ids = (p && p['smartscape.affected_entity.ids']) || [];
    if (ids.length === 1 && lookup.length === 1 && lookup[0] && lookup[0].entity_name) {
      return String(lookup[0].entity_name);
    }
    return '';
  };

  if (useSs) {
    const out = [];
    for (const e of (p && p['smartscape.affected_entities']) || []) {
      if (!e || !e.id) continue;
      out.push({ entityId: { id: e.id, type: e.type || classicTypeFromId(e.id) }, name: nameFor(e.id) });
    }
    if (out.length === 0) {
      const ids = (p && p['smartscape.affected_entity.ids']) || [];
      const types = (p && p['smartscape.affected_entity.types']) || [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        if (!id) continue;
        out.push({ entityId: { id, type: types[i] || classicTypeFromId(id) }, name: nameFor(id) });
      }
    }
    if (out.length > 0) return out;
  }

  const ids = (p && p.affected_entity_ids) || [];
  const names = (p && p.affected_entity_names) || [];
  const out = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (!id) continue;
    out.push({ entityId: { id, type: classicTypeFromId(id) }, name: names[i] || '' });
  }
  return out;
}

export function buildEvidenceDetail(e, entityName) {
  const ssId = e['dt.smartscape_source.id'] || null;
  const ssType = e['dt.smartscape_source.type'] || null;
  return {
    startTime: toEpochMillis(e['event.start']),
    endTime: toEpochMillis(e['event.end']),
    eventId: e['event.id'] || null,
    eventType: e['event.type'] || null,
    displayName: e['event.name'] || null,
    evidenceType: 'EVENT',
    rootCauseRelevant: e['dt.davis.is_rootcause_relevant'] === true,
    entity: ssId ? { entityId: { id: ssId, type: ssType || '' }, name: entityName || '' } : null,
    data: {
      title: e['event.name'] || null,
      status: String(e['event.status'] || '').toUpperCase() === 'CLOSED' ? 'CLOSED' : 'OPEN',
      startTime: toEpochMillis(e['event.start']),
      endTime: toEpochMillis(e['event.end']),
      eventId: e['event.id'] || null,
      eventType: e['event.type'] || null,
      correlationId: e['dt.event.correlation_id'] || null,
      frequentEvent: e['dt.davis.is_frequent_event'] === true,
      underMaintenance: e['maintenance.is_under_maintenance'] === true,
      suppressAlert: false,
      suppressProblem: false,
      managementZones: [],
      entityTags: [],
      dqlQuery: e['dt.query'] || e.query_string || null,
      settingsObjectId: e['dt.settings.object_id'] || null,
      settingsSchemaId: e['dt.settings.schema_id'] || null,
      eventProvider: e['event.provider'] || null,
      smartscapeEntityId: ssId,
      smartscapeEntityType: ssType,
    },
  };
}

export function buildClassicProblemDetails(input) {
  const p = (input && input.problem) || {};
  const events = (input && input.events) || [];
  const rows = (input && input.entities) || [];
  const named = rows.find((r) => r && r.entity_name);
  const entityName = named ? named.entity_name : null;
  const extraTags = [].concat(p.entity_tags || [], p.primary_tags || []);
  const impact = p['dt.davis.impact_level'];
  const affected = buildAffectedEntities(p, rows, input && input.useSmartscapeEntities !== false);

  return {
    problemId: p['event.id'] || null,
    displayId: p.display_id || null,
    title: p['event.name'] || null,
    impactLevel: (Array.isArray(impact) ? impact[0] : impact) || null,
    severityLevel: p['event.category'] || null,
    status: classicStatus(p),
    startTime: toEpochMillis(p['event.start']),
    endTime: toEpochMillis(p['event.end']),
    affectedEntities: affected,
    impactedEntities: affected,
    rootCauseEntity: p.root_cause_entity_name
      ? { entityId: { id: '', type: '' }, name: p.root_cause_entity_name }
      : null,
    managementZones: [],
    entityTags: buildEntityTags(rows, extraTags),
    problemFilters: (p['labels.alerting_profile'] || []).map((n) => ({ id: '', name: String(n) })),
    evidenceDetails: {
      totalCount: events.length,
      details: events.map((e) => buildEvidenceDetail(e, entityName)),
    },
  };
}

// ── Workflow entrypoint ─────────────────────────────────────────────────────
// Reads the triggering Davis problem, fetches its underlying events, and
// returns both the classic-shaped object and the flat fields the HTTP task
// templates. Doing the flattening HERE rather than in Jinja is deliberate:
// Jinja's `default()` does not replace null (only undefined), and these
// problems carry null `entity_tags` / `primary_tags`, which made the template
// throw. JavaScript handles null honestly.
export default async function ({ execution_id }) {
  const { execution } = await import('@dynatrace-sdk/automation-utils');
  const { queryExecutionClient } = await import('@dynatrace-sdk/client-query');

  const ex = await execution(execution_id);
  const problem = ex.event();

  const runDql = async (query) => {
    const res = await queryExecutionClient.queryExecute({
      body: { query, requestTimeoutMilliseconds: 30000, fetchTimeoutSeconds: 30 },
    });
    return (res && res.result && res.result.records) || [];
  };

  // Evidence: one record per underlying Davis event.
  const eventIds = problem['dt.davis.event_ids'] || [];
  let events = [];
  if (eventIds.length) {
    const list = eventIds.map((id) => '"' + String(id).replace(/"/g, '') + '"').join(', ');
    events = await runDql(
      'fetch dt.davis.events, from:now()-24h | filter in(event.id, { ' + list + ' })'
    );
  }

  // Entity enrichment. entity_tags / primary_tags / affected_entity.names are
  // all null on these problems, so Smartscape is the only source for them.
  const ssIds = problem['smartscape.affected_entity.ids'] || [];
  let entities = [];
  if (ssIds.length) {
    const list = ssIds.map((id) => 'toSmartscapeId("' + String(id).replace(/"/g, '') + '")').join(', ');
    entities = await runDql(
      'smartscapeNodes "*"\n' +
        '| filter in(id, { ' + list + ' })\n' +
        '| fieldsFlatten tags\n' +
        '| fieldsAdd applicationci = coalesce(tags.ApplicationCI, tags.applicationci, tags.AppCI)\n' +
        '| fieldsAdd env = coalesce(tags.env, tags.Environment, tags.environment, tags.Env)\n' +
        '| fields id, applicationci, env, ARN = aws.arn, entity_name = name'
    );
  }

  const problemDetails = buildClassicProblemDetails({ problem, events, entities });

  const tagStrings = problemDetails.entityTags.map((t) => t.stringRepresentation);
  return {
    problemDetails,
    // Flat fields for the HTTP payload — every one has a defined value.
    flat: {
      ImpactedEntity: (entities.find((e) => e && e.entity_name) || {}).entity_name || '',
      ProblemID: problemDetails.displayId || '',
      PID: problemDetails.problemId || '',
      State: problemDetails.status,
      ProblemTitle: problemDetails.title || '',
      ProblemSeverity: problemDetails.severityLevel || '',
      ProblemImpact: problemDetails.impactLevel || '',
      RootCauseEntity: (problem.root_cause_entity_name || ''),
      ProblemDetails: problem['event.description'] || '',
      applicationci: (entities.find((e) => e && e.applicationci) || {}).applicationci || '',
      env: (entities.find((e) => e && e.env) || {}).env || '',
      ARN: (entities.find((e) => e && e.ARN) || {}).ARN || '',
      Tags: tagStrings.join(', '),
    },
  };
}
