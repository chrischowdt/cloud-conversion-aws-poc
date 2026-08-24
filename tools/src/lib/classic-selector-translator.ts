/**
 * Translate a parsed classicEntitySelector AST into a DQL filter expression.
 *
 * Strategy (from dt-migration/references/mass-data-filtering-strategy.md):
 *   We default to **Check 2** (`getNodeField(<smartscape_dim>, "<field>") == "<v>"`)
 *   as the safest universally-applicable approach. Check 1 (direct enriched
 *   dimension) would be faster but requires fieldsSnapshot discovery to know
 *   which conditions are enriched on the mass-data source. Check 3 (smartscapeNodes
 *   subquery) is needed for cross-node-type filters; we don't auto-do that.
 *
 *   Tags are translated using the documented `tags:<context>[<key>]` access
 *   pattern (Example 001 in dt-migration/references/examples.md).
 *
 *   Relationships (`fromRelationships.X(...)`) need `traverse` on smartscape
 *   edges — these are flagged for manual translation since they require
 *   knowledge of the relationship-mappings table that's beyond simple
 *   per-predicate translation.
 *
 *   Management zones do not migrate (per skill); these are flagged.
 *
 * Output: DQL clause string (joins to other clauses with `and`) + warnings.
 */

import type { Predicate, StringOp } from './classic-selector-parser.ts';
import { classicEntityToSmartscape, lookupBySmartscapeDim } from './entity-mappings.ts';
import { mzFilterExpression, type MzTagIndex } from './mz-tags.ts';
import { findEdgesBetween } from './smartscape-edges.ts';

/**
 * Map a classic relationship name (as it appears in
 * fromRelationships.<name> / toRelationships.<name>) to the corresponding
 * Smartscape edge type.
 *
 * Source: dt-migration/references/entity-selector-predicates.md
 *         "Mapping to Semantic Dictionary Relationship Types" + the
 *         edge inventory in relationship-mappings.md.
 *
 * When a name has multiple semantically related smartscape edges, the
 * generic / most-common edge is used.
 */
const CLASSIC_RELATIONSHIP_TO_EDGE: Record<string, string> = {
  runsOn: 'runs_on',
  runsOnHost: 'runs_on',
  runsOnResource: 'runs_on',
  isProcessOf: 'runs_on',
  belongsTo: 'belongs_to',
  isPartOf: 'is_part_of',
  isStepOf: 'is_part_of',
  isAttachedTo: 'is_attached_to',
  isBalancedBy: 'balanced_by',
  calls: 'calls',
  manages: 'manages',
  monitors: 'monitors',
  isAccessibleBy: 'accessible_by',
  isInstanceOf: 'is_part_of',  // closest fit; flagged when used
  isHostGroupOf: 'belongs_to', // host_group isn't a smartscape entity; flagged
  propagatesTo: 'propagates_to',
  sendsToQueue: 'sends_to',
  receivesFromQueue: 'receives_from',
  listensOnQueue: 'receives_from',
};

/** Classic relationship names that translate but with caveats (worth a note). */
const RELATIONSHIPS_NEEDING_CAVEAT: Record<string, string> = {
  isInstanceOf:
    'isInstanceOf has no clean Smartscape edge — translated to is_part_of as closest fit; verify on relationship-mappings.md.',
  isHostGroupOf:
    'isHostGroupOf points at host_group which is not a standalone Smartscape entity — use dt.host_group.id field on HOST instead.',
};

export interface TranslationResult {
  /** Joined DQL filter string. Empty when no translatable predicate produced output. */
  filter: string;
  /** Notes for the human reviewer (untranslated predicates, ambiguities, etc.). */
  notes: string[];
  /**
   * True when every predicate either produced a clause or is implicit (a bare
   * `type(...)`). A false value means a real predicate was DROPPED, so the
   * emitted `filter` is incomplete and would return wrong results — callers
   * should treat that as blocking. When complete, the notes are purely
   * advisory (e.g. "assumed tag context aws") and must NOT block.
   */
  complete: boolean;
}

/**
 * Translate a parsed selector against a known smartscape dimension reference.
 *
 * @param predicates  Parsed selector AST.
 * @param smartscapeDim  The smartscape dimension on the mass-data source
 *                       (e.g. "dt.smartscape.aws_ec2_instance"). Used as the
 *                       first arg to `getNodeField()`.
 * @param hints        Optional hints to guide translation (e.g. cloud provider
 *                       defaults the tag context to "aws").
 */
export function translateSelector(
  predicates: Predicate[],
  smartscapeDim: string,
  hints: TranslationHints = {}
): TranslationResult {
  const clauses: string[] = [];
  const notes: string[] = [];
  let complete = true;

  for (const p of predicates) {
    const t = translatePredicate(p, smartscapeDim, hints);
    if (t.clause) clauses.push(t.clause);
    // A non-`type` predicate that produced no clause was dropped → incomplete.
    else if (p.kind !== 'type') complete = false;
    if (t.note) notes.push(t.note);
  }

  return {
    filter: clauses.join(' and '),
    notes,
    complete,
  };
}

export interface TranslationHints {
  /** Default tag context when classicEntitySelector tag has no `[Context]` prefix.
   *  For AWS resources, "aws" is a sensible default. */
  defaultTagContext?: string;
  /**
   * Management zone -> the AWS tag predicates that define its AWS slice
   * (`discover-management-zones` -> `management-zones.json`). When a zone is
   * present here, `mzName(...)` becomes a native enriched-tag dimension filter
   * instead of an untranslatable note. Absent zones stay untranslated.
   */
  mzTags?: MzTagIndex;
}

interface PredicateTranslation {
  clause?: string;
  note?: string;
}

/**
 * Translate one predicate. Returns either a DQL clause or a note (or both).
 * No clause is emitted for predicates that are implicit, not migratable, or
 * need human attention.
 */
function translatePredicate(
  p: Predicate,
  dim: string,
  hints: TranslationHints
): PredicateTranslation {
  switch (p.kind) {
    case 'type':
      // Implicit when filtering on a typed smartscape dimension. No clause.
      return {};

    case 'entityId':
      return {
        note:
          `entityId(${p.values.join(',')}) — classic entity IDs do not carry over to Smartscape. ` +
          `Wrap with toSmartscapeId() or look up the matching Smartscape ID. See dt-migration/references/dql-function-migration.md.`,
      };

    case 'entityName': {
      const values = p.values.map(jsonString);
      const fieldRef = `getNodeField(${dim}, "name")`;
      return { clause: stringOpToClause(fieldRef, p.op, values) };
    }

    case 'tag':
      return translateTag(p, dim, hints);

    case 'mz':
      return translateManagementZone(p, hints);

    case 'healthState': {
      // Skill maps healthState → availability.state (smartscape node attr)
      const values = p.values.map(jsonString);
      const fieldRef = `getNodeField(${dim}, "availability.state")`;
      return { clause: stringOpToClause(fieldRef, 'equals', values) };
    }

    case 'attribute':
      return translateAttribute(p, dim);

    case 'relationship':
      return translateRelationship(p, dim, hints);

    case 'modifier': {
      const inner = translateSelector(p.inner, dim, hints);
      if (!inner.filter) {
        return {
          note: `${p.modifier}(...) wrapped a predicate that did not translate; verify manually.`,
        };
      }
      if (p.modifier === 'not') {
        return { clause: `not (${inner.filter})` };
      }
      // caseSensitive — DQL string compare is case-sensitive by default; pass through.
      return { clause: inner.filter };
    }

    case 'unknown':
      return { note: `Unrecognized predicate "${p.raw}" — translate manually.` };
  }
}

/**
 * Map a classic filter-predicate name to a Smartscape node attribute. Source:
 * dt-migration/references/entity-selector-predicates.md "Filter Predicates" +
 * "Auto-Tagging Field Mapping" cross-references.
 *
 * When the predicate isn't in this map, we still emit a getNodeField clause
 * using the predicate name as the field. That's a best-effort guess and
 * prints a note.
 */
const ATTRIBUTE_FIELD_MAP: Record<string, string> = {
  // Common AWS predicates (most useful)
  awsRegion: 'aws.region',
  awsAccountId: 'aws.account.id',
  awsResourceName: 'aws.resource.name',
  cloudType: 'cloud.provider',

  // Hosts / OS
  ipAddress: 'host.ip',
  osType: 'os.type',
  osDetail: 'os.version',
  monitoringMode: 'dt.agent.monitoring_mode',
  hostVirtualizationType: 'hypervisor.type',
  networkZone: 'dt.network_zone.id',
  hostGroupId: 'dt.host_group.id',
  hostGroupName: 'dt.host_group.id',

  // Services / databases
  serviceType: 'service.type',
  serviceTechnologyTypes: 'service.technology',
  databaseName: 'db.namespace',
  databaseVendor: 'db.system',

  // Kubernetes
  kubernetesClusterId: 'k8s.cluster.uid',
  kubernetesClusterName: 'k8s.cluster.name',
  k8sClusterName: 'k8s.cluster.name',
  namespaceName: 'k8s.namespace.name',
  k8sNamespaceName: 'k8s.namespace.name',
  k8sWorkloadName: 'k8s.workload.name',
  containerNames: 'container.name',
  containerName: 'container.name',

  // Azure
  azureSubscriptionUuid: 'azure.subscription',
  azureTenantUuid: 'azure.tenant.id',
  azureManagementGroupUuid: 'azure.management_group',
  azureResourceId: 'azure.resource.id',
  azureSiteName: 'azure.site_name',

  // Releases
  releasesVersion: 'deployment.release_version',
  releasesStage: 'deployment.release_stage',
  releasesProduct: 'deployment.release_product',
  releasesBuildVersion: 'deployment.release_build_version',
};

function translateAttribute(
  p: Predicate & { kind: 'attribute' },
  dim: string
): PredicateTranslation {
  const field = ATTRIBUTE_FIELD_MAP[p.predicate];
  const values = p.values.map(jsonString);
  if (!field) {
    return {
      clause: stringOpToClause(`getNodeField(${dim}, ${jsonString(p.predicate)})`, p.op, values),
      note:
        `Predicate "${p.predicate}" has no documented Smartscape field mapping; ` +
        `translated as getNodeField(<dim>, "${p.predicate}") — verify this field exists on ` +
        `the node type via fieldsSnapshot smartscape.nodes.`,
    };
  }
  const fieldRef = `getNodeField(${dim}, ${jsonString(field)})`;
  return { clause: stringOpToClause(fieldRef, p.op, values) };
}

/**
 * `mzName("…")` / `managementZone("…")` → a native enriched-tag dimension
 * filter, when we know the zone's AWS tag definition.
 *
 * Management zones don't exist in Smartscape, so historically this predicate was
 * dropped and the whole panel blocked. But the AWS slice of a zone is just a set
 * of tag rules, and the new integration enriches those same tags onto the metric
 * (`aws.tags.<key>`) — so the zone reduces to a plain dimension filter needing no
 * entity lookup. Only zones present in the discovered index are translated; an
 * unknown zone still returns a note so the asset keeps blocking rather than
 * silently changing an alert's scope.
 */
function translateManagementZone(
  p: Predicate & { kind: 'mz' },
  hints: TranslationHints
): PredicateTranslation {
  const names = p.values ?? [];
  const idx = hints.mzTags;
  if (idx && names.length > 0) {
    const parts: string[] = [];
    const unresolved: string[] = [];
    for (const n of names) {
      const preds = idx.get(n);
      if (preds && preds.length) parts.push(mzFilterExpression(preds));
      else unresolved.push(n);
    }
    if (parts.length > 0 && unresolved.length === 0) {
      // Multiple zones in one predicate are a union.
      const clause = parts.length === 1 ? parts[0]! : '(' + parts.map((c) => `(${c})`).join(' or ') + ')';
      return {
        clause,
        note:
          `Management zone ${names.map((n) => `"${n}"`).join(', ')} was rewritten as an enriched-tag ` +
          `dimension filter (${clause}). Zones have no Smartscape equivalent; this reproduces the zone's ` +
          `AWS membership rules only — verify the scope matches, especially if the zone also selected ` +
          `non-AWS entities or if some resources are missing the tag.`,
      };
    }
  }
  return {
    note:
      `${p.field}(${names.join(',')}) — management zones are not migratable to Smartscape, and this zone's ` +
      `AWS tag definition isn't available (run \`cct discover-management-zones\`). ` +
      `Rewrite using the underlying entity conditions directly. See dt-migration/references/mass-data-filtering-strategy.md.`,
  };
}

function translateTag(
  p: Predicate & { kind: 'tag' },
  dim: string,
  hints: TranslationHints
): PredicateTranslation {
  // Forms:
  //   tag("[Context]key:value") - explicit context, key/value
  //   tag("[Context]value")     - explicit context, value-only
  //   tag("key:value")          - no context (rule-based or unknown)
  //   tag("value")              - no context, value-only

  if (p.context && p.key && p.value !== undefined) {
    // Most authoritative form. Translate to tags:<contextLower>[<key>] == "<value>".
    const ctx = p.context.toLowerCase();
    const ref = `getNodeField(${dim}, ${jsonString('tags:' + ctx)})[${p.key}]`;
    return { clause: `${ref} == ${jsonString(p.value)}` };
  }

  if (!p.context && p.key && p.value !== undefined) {
    // Heuristic: AWS resources usually carry tags under tags:aws.
    const guess = hints.defaultTagContext ?? 'aws';
    const ref = `getNodeField(${dim}, ${jsonString('tags:' + guess)})[${p.key}]`;
    return {
      clause: `${ref} == ${jsonString(p.value)}`,
      note:
        `tag("${p.raw}") had no [Context] prefix — assumed context="${guess}". ` +
        `If this is a rule-based tag, look up the rule under builtin:tags.auto-tagging and ` +
        `resolve its conditions per dt-migration/references/mass-data-filtering-strategy.md Step 1A. ` +
        `If it is from a non-AWS source, change the context (e.g. tags:k8s.labels).`,
    };
  }

  // Value-only tag. Per Example 013, use substring match: tags ~ "value".
  const v = p.value ?? p.raw;
  return {
    clause: `getNodeField(${dim}, "tags") ~ ${jsonString(v)}`,
    note:
      `tag("${p.raw}") matches by substring on the serialized tag string — verify whether you ` +
      `want exact key/value match instead. See examples.md Example 013.`,
  };
}

function stringOpToClause(fieldRef: string, op: StringOp, values: string[]): string {
  switch (op) {
    case 'equals':
      // Single value → ==; multiple → in()
      return values.length <= 1
        ? `${fieldRef} == ${values[0] ?? '""'}`
        : `in(${fieldRef}, array(${values.join(', ')}))`;
    case 'contains':
      return values.length === 1
        ? `${fieldRef} ~ ${values[0]}`
        : '(' + values.map((v) => `${fieldRef} ~ ${v}`).join(' or ') + ')';
    case 'startsWith':
      return values.length === 1
        ? `startsWith(${fieldRef}, ${values[0]})`
        : '(' + values.map((v) => `startsWith(${fieldRef}, ${v})`).join(' or ') + ')';
    case 'in':
      return `in(${fieldRef}, array(${values.join(', ')}))`;
    case 'exists':
      return `isNotNull(${fieldRef})`;
    case 'gte':
      return `${fieldRef} >= ${values[0] ?? '0'}`;
    case 'gt':
      return `${fieldRef} > ${values[0] ?? '0'}`;
    case 'lte':
      return `${fieldRef} <= ${values[0] ?? '0'}`;
    case 'lt':
      return `${fieldRef} < ${values[0] ?? '0'}`;
  }
}

function jsonString(s: string): string {
  return JSON.stringify(s);
}

/**
 * Translate a relationship predicate inside a classicEntitySelector wrapped
 * by `in(<outer_dim>, classicEntitySelector(...))`.
 *
 * Strategy (Check 3 from mass-data-filtering-strategy.md):
 *
 *     <outer_dim> in [
 *       smartscapeNodes <inner_node_type>
 *       | filter <inner predicates as direct fields>
 *       | traverse <edge>, <outer_node_type>, direction:<dir>
 *       | fields id
 *     ]
 *
 * Direction:
 *   - fromRelationships.X — outer entity has the X edge going FROM it TO
 *     inner. Starting at inner and traversing the edge backward lands on
 *     the outer entity. → direction:backward
 *   - toRelationships.X — inverse. → direction:forward
 *
 * Returns no clause and a note when:
 *   - the relationship name has no documented Smartscape edge
 *   - the outer dim doesn't map to a known Smartscape node type
 *   - the inner selector has no `type(X)` predicate or X has no node-type mapping
 *   - the inner selector contains its own (nested) relationship — flag for manual,
 *     since chained traversals are entity-pair-specific.
 */
function translateRelationship(
  rel: Predicate & { kind: 'relationship' },
  outerDim: string,
  hints: TranslationHints
): PredicateTranslation {
  const relName = rel.relationshipName;
  const edge = relName ? CLASSIC_RELATIONSHIP_TO_EDGE[relName] : undefined;
  if (!edge) {
    return {
      note:
        `${rel.direction === 'from' ? 'fromRelationships' : 'toRelationships'}` +
        `${relName ? '.' + relName : ''}(...) has no documented Smartscape edge mapping — ` +
        `translate manually using smartscapeEdges or traverse. ` +
        `See dt-migration/references/entity-selector-predicates.md and relationship-mappings.md.`,
    };
  }

  const outerMapping = lookupBySmartscapeDim(outerDim);
  if (!outerMapping || !outerMapping.smartscapeNodeType) {
    return {
      note:
        `Cannot determine outer Smartscape node type from ${outerDim} — relationship not translated.`,
    };
  }

  const innerTypePred = rel.inner.find((p): p is Predicate & { kind: 'type' } => p.kind === 'type');
  if (!innerTypePred || !innerTypePred.value) {
    return {
      note:
        `Relationship inner selector has no type(X) predicate — cannot determine inner node type. ` +
        `Add an explicit type() inside the relationship or translate manually.`,
    };
  }
  const innerMapping = classicEntityToSmartscape(innerTypePred.value);
  if (!innerMapping || !innerMapping.smartscapeNodeType) {
    return {
      note:
        `Inner type "${innerTypePred.value}" has no Smartscape node-type mapping — relationship not translated. ` +
        `See dt-migration/references/type-mappings.md.`,
    };
  }

  const nestedRel = rel.inner.find((p) => p.kind === 'relationship');
  if (nestedRel) {
    return {
      note:
        `Nested relationship inside ${rel.direction}Relationships.${relName}(...) — chained traversals ` +
        `need manual translation. Each traversal step depends on the specific (source, target) edge ` +
        `which is best expressed by hand for now.`,
    };
  }

  // Build inner-side filter (excluding the type predicate; that's the smartscapeNodes target).
  const innerPreds = rel.inner.filter((p) => p.kind !== 'type');
  const innerXlate = translateForSmartscapeNode(innerPreds, hints);

  // Validate the edge against the relationship-mappings table. The naive
  // classic-name → smartscape-name mapping is often wrong for a specific
  // (source, target) pair (e.g. EC2_INSTANCE↔AVAILABILITY_ZONE is `runs_on`,
  // NOT `belongs_to` even though classic `belongsTo` → smartscape `belongs_to`).
  // When the table has exactly one edge between the pair, prefer that.
  const innerType = innerMapping.smartscapeNodeType;
  const outerType = outerMapping.smartscapeNodeType;
  const validEdges = findEdgesBetween(innerType, outerType);
  let chosenEdge = edge;
  let directionOverride: 'forward' | 'backward' | null = null;
  const validationNotes: string[] = [];
  if (validEdges.length === 0) {
    validationNotes.push(
      `No edge between (${innerType}, ${outerType}) in the AWS subset of relationship-mappings.md. ` +
        `Emitting "${edge}" from classic-name mapping; verify by hand or expand smartscape-edges.ts.`
    );
  } else {
    const direct = validEdges.find((e) => e.edge === edge);
    if (direct) {
      // Our naive choice is supported — check direction is consistent.
      // For from-relationships we expect outer→inner forward (the user is
      // saying "outer has X going to inner"), so the registered edge should
      // be source=outer, target=inner (i.e. forward=false from inner's POV).
      const expectsForwardFromInner = rel.direction === 'to';
      if (direct.forward !== expectsForwardFromInner) {
        // Edge exists but the wiring is the other way — flip direction.
        directionOverride = direct.forward ? 'forward' : 'backward';
      }
    } else if (validEdges.length === 1) {
      // Exactly one edge connects the pair and it isn't the naive pick —
      // prefer the actual edge and note the substitution.
      const only = validEdges[0]!;
      validationNotes.push(
        `Classic relationship "${relName}" naively maps to "${edge}", but the only Smartscape edge ` +
          `between ${innerType} and ${outerType} is "${only.edge}" (${only.forward ? 'inner→outer' : 'outer→inner'}). ` +
          `Substituting that edge.`
      );
      chosenEdge = only.edge;
      // Recompute direction from the actual edge wiring.
      directionOverride = only.forward ? 'forward' : 'backward';
    } else {
      // Multiple candidate edges and our naive pick isn't among them.
      validationNotes.push(
        `Classic relationship "${relName}" maps to "${edge}", but the Smartscape edges between ` +
          `${innerType} and ${outerType} are [${validEdges.map((e) => e.edge).join(', ')}]. ` +
          `Pick the right edge by hand.`
      );
    }
  }

  const direction = directionOverride ?? (rel.direction === 'from' ? 'backward' : 'forward');
  const lines: string[] = [];
  lines.push(`smartscapeNodes ${innerType}`);
  if (innerXlate.filter) lines.push(`  | filter ${innerXlate.filter}`);
  lines.push(`  | traverse ${chosenEdge}, ${outerType}, direction:${direction}`);
  lines.push(`  | fields id`);
  const subquery = lines.join('\n');

  const notes: string[] = [];
  if (validationNotes.length > 0) notes.push(...validationNotes);
  if (RELATIONSHIPS_NEEDING_CAVEAT[relName!]) {
    notes.push(RELATIONSHIPS_NEEDING_CAVEAT[relName!]!);
  }
  notes.push(...innerXlate.notes);

  return {
    clause: `${outerDim} in [\n${subquery}\n]`,
    note: notes.length > 0 ? notes.join(' ') : undefined,
  };
}

/**
 * Translate a list of predicates in a smartscapeNodes context — i.e., when
 * we ARE the node, fields are accessed directly (`name`, `aws.region`,
 * `` `tags:aws`[key] ``) rather than via `getNodeField()`.
 */
function translateForSmartscapeNode(
  predicates: Predicate[],
  hints: TranslationHints
): TranslationResult {
  const clauses: string[] = [];
  const notes: string[] = [];
  let complete = true;
  for (const p of predicates) {
    const t = translatePredicateForNode(p, hints);
    if (t.clause) clauses.push(t.clause);
    else if (p.kind !== 'type') complete = false;
    if (t.note) notes.push(t.note);
  }
  return { filter: clauses.join(' and '), notes, complete };
}

function translatePredicateForNode(
  p: Predicate,
  hints: TranslationHints
): PredicateTranslation {
  switch (p.kind) {
    case 'type':
      return {};
    case 'entityName': {
      const values = p.values.map(jsonString);
      return { clause: stringOpToClause('name', p.op, values) };
    }
    case 'entityId':
      return {
        note: `entityId in inner selector — classic IDs do not carry over; translate manually.`,
      };
    case 'tag':
      return translateTagForNode(p, hints);
    case 'mz':
      return { note: `${p.field}() inside relationship — management zones are not migratable.` };
    case 'healthState': {
      const values = p.values.map(jsonString);
      return { clause: stringOpToClause('availability.state', 'equals', values) };
    }
    case 'attribute': {
      const field = ATTRIBUTE_FIELD_MAP[p.predicate] ?? p.predicate;
      const values = p.values.map(jsonString);
      const clause = stringOpToClause(field, p.op, values);
      const note =
        ATTRIBUTE_FIELD_MAP[p.predicate]
          ? undefined
          : `Inner predicate "${p.predicate}" has no documented field mapping; using bare name — verify with fieldsSnapshot.`;
      return { clause, note };
    }
    case 'relationship':
      return {
        note: `Nested relationship inside relationship — flagged earlier; translate manually.`,
      };
    case 'modifier': {
      const inner = translateForSmartscapeNode(p.inner, hints);
      if (!inner.filter) return {};
      if (p.modifier === 'not') return { clause: `not (${inner.filter})` };
      return { clause: inner.filter };
    }
    case 'unknown':
      return { note: `Unknown predicate "${p.raw}" inside inner selector.` };
  }
}

function translateTagForNode(
  p: Predicate & { kind: 'tag' },
  hints: TranslationHints
): PredicateTranslation {
  // Direct field access on a smartscapeNode — the tag context becomes a
  // backticked field name. Example: `tags:azure`[dt_owner_email] == "..."
  if (p.context && p.key && p.value !== undefined) {
    const ctx = p.context.toLowerCase();
    return { clause: `\`tags:${ctx}\`[${p.key}] == ${jsonString(p.value)}` };
  }
  if (!p.context && p.key && p.value !== undefined) {
    const guess = hints.defaultTagContext ?? 'aws';
    return {
      clause: `\`tags:${guess}\`[${p.key}] == ${jsonString(p.value)}`,
      note:
        `tag("${p.raw}") inside relationship had no [Context] — assumed "${guess}". ` +
        `If this is rule-based or non-AWS, change the context.`,
    };
  }
  // Value-only — substring on serialized tags.
  const v = p.value ?? p.raw;
  return {
    clause: `tags ~ ${jsonString(v)}`,
    note: `tag("${p.raw}") inside relationship — substring match; verify intent.`,
  };
}
