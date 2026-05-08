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

export interface TranslationResult {
  /** Joined DQL filter string. Empty when no translatable predicate produced output. */
  filter: string;
  /** Notes for the human reviewer (untranslated predicates, ambiguities, etc.). */
  notes: string[];
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

  for (const p of predicates) {
    const t = translatePredicate(p, smartscapeDim, hints);
    if (t.clause) clauses.push(t.clause);
    if (t.note) notes.push(t.note);
  }

  return {
    filter: clauses.join(' and '),
    notes,
  };
}

export interface TranslationHints {
  /** Default tag context when classicEntitySelector tag has no `[Context]` prefix.
   *  For AWS resources, "aws" is a sensible default. */
  defaultTagContext?: string;
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
      return {
        note:
          `${p.field}(${p.values.join(',')}) — management zones are not migratable to Smartscape. ` +
          `Rewrite using the underlying entity conditions directly. See dt-migration/references/mass-data-filtering-strategy.md.`,
      };

    case 'healthState': {
      // Skill maps healthState → availability.state (smartscape node attr)
      const values = p.values.map(jsonString);
      const fieldRef = `getNodeField(${dim}, "availability.state")`;
      return { clause: stringOpToClause(fieldRef, 'equals', values) };
    }

    case 'attribute':
      return translateAttribute(p, dim);

    case 'relationship':
      return {
        note:
          `${p.direction === 'from' ? 'fromRelationships' : 'toRelationships'}` +
          `${p.relationshipName ? '.' + p.relationshipName : ''}(...) — relationship traversal needs ` +
          `manual translation via smartscapeEdges or traverse on the corresponding edge. ` +
          `Verify the edge exists in dt-migration/references/relationship-mappings.md.`,
      };

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
