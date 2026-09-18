/**
 * EXPERIMENT: convert a classic dashboard using ONLY the product knowledgebase.
 *
 * The point is to measure what the shipped guidance alone gets you, so this
 * file deliberately does NOT import our rewriter, our empirical lookup tables
 * (aws-service-node-types, entity-field-mappings, metric-dim-carriers,
 * live-metrics, mz-tags, enriched-tags), or anything learned from probing the
 * tenant. Every transformation below cites the knowledgebase file that
 * prescribes it. If a construct has no cited rule, it is left ALONE and counted
 * as "no KB rule" rather than guessed at — guessing would measure me, not the
 * knowledgebase.
 *
 * Inputs used (all inside product-ai-knowledgebase/):
 *   dt-migration-cloud/references/entity-type-mapping.md        (R1,R2,R4,R8)
 *   dt-migration/references/entity-service.md                   (R3)
 *   dt-migration/references/dql-function-migration.md           (R5,R6)
 *   dt-migration-cloud/references/metric-key-mapping.md         (R7)
 *   dt-migration-cloud/references/{per-key,manual}-mappings.json (R7 data)
 *   dt-migration-cloud/references/dac-aws-to-2ndgen-{metrics,entities}.json (R7,R1 data)
 *   dt-migration-cloud/references/metric-streams.md             (R9)
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './src/lib/paths.ts';

const KB = join(REPO_ROOT, 'product-ai-knowledgebase');
const CLOUD = join(KB, 'dt-migration-cloud', 'references');

// ── R7 data: the KB's own metric mapping tables ─────────────────────────────
const perKey: Record<string, any> = JSON.parse(readFileSync(join(CLOUD, 'per-key-mappings.json'), 'utf8'));
const manual: Record<string, any> = JSON.parse(readFileSync(join(CLOUD, 'manual-metric-mappings.json'), 'utf8'));
const dac: any[] = JSON.parse(readFileSync(join(CLOUD, 'dac-aws-to-2ndgen-metrics.json'), 'utf8'));

const perKeyLc = new Map<string, any>();
for (const [k, v] of Object.entries(perKey)) perKeyLc.set(k.toLowerCase(), v);
const manualLc = new Map<string, any>();
for (const [k, v] of Object.entries(manual)) manualLc.set(k.toLowerCase(), v);
const dacByClassic = new Map<string, any>();
for (const e of dac) {
  for (const f of ['builtInMetricKey', 'supportingServiceMetricKey', 'classicMetricKey']) {
    const v = e?.[f];
    if (typeof v === 'string' && v && v !== 'not-matched') dacByClassic.set(v.toLowerCase(), e);
  }
}
const newKeyOf = (e: any): string | undefined => {
  for (const f of ['secondGenMetricKey', 'newMetricKey', 'dtMetricKey', 'newDtMetricKey', 'metricKey']) {
    const v = e?.[f];
    if (typeof v === 'string' && v && v !== 'not-matched') return v;
  }
  return undefined;
};

/** R7 — metric-key-mapping.md: tables first, then the documented normalization. */
function lookupMetric(key: string): { newKey: string; via: string } | null {
  const tries = [key, key.toLowerCase()];
  for (const t of tries) {
    const m = manualLc.get(t.toLowerCase());
    if (m) { const nk = typeof m === 'string' ? m : newKeyOf(m); if (nk) return { newKey: nk, via: 'manual-metric-mappings.json' }; }
  }
  for (const t of tries) {
    const p = perKeyLc.get(t.toLowerCase());
    if (p) { const nk = typeof p === 'string' ? p : newKeyOf(p); if (nk) return { newKey: nk, via: 'per-key-mappings.json' }; }
  }
  // documented prefix variants (metric-key-mapping.md "Key Format Differences")
  const variants = new Set<string>([key]);
  const m = /^dt\.cloud\.(\w+)\.(.+)$/i.exec(key);
  if (m) { variants.add(`builtin:cloud.${m[1]}.${m[2]}`); variants.add(`builtin:${m[1]}.${m[2]}`); }
  if (/^cloud\./i.test(key)) { variants.add(`ext:${key}`); variants.add(`builtin:${key}`); }
  for (const v of variants) {
    const d = dacByClassic.get(v.toLowerCase());
    if (d) { const nk = newKeyOf(d); if (nk) return { newKey: nk, via: 'dac-aws-to-2ndgen-metrics.json' }; }
    const p = perKeyLc.get(v.toLowerCase());
    if (p) { const nk = typeof p === 'string' ? p : newKeyOf(p); if (nk) return { newKey: nk, via: 'per-key-mappings.json (prefix variant)' }; }
  }
  return null;
}

// ── R1 data: entity type tables from entity-type-mapping.md §1 ──────────────
// Transcribed from the doc's two tables — nothing added from our own tables.
const KB_ENTITY: Record<string, string> = {
  ec2_instance: 'AWS_EC2_INSTANCE',
  ebs_volume: 'AWS_EC2_VOLUME',
  aws_lambda_function: 'AWS_LAMBDA_FUNCTION',
  auto_scaling_group: 'AWS_AUTOSCALING_AUTOSCALINGGROUP',
  aws_application_load_balancer: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER',
  aws_network_load_balancer: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER',
  relational_database_service: 'AWS_RDS_DBINSTANCE',
  dynamo_db_table: 'AWS_DYNAMODB_TABLE',
  'cloud:aws:s3': 'AWS_S3_BUCKET',
  'cloud:aws:lambda': 'AWS_LAMBDA_FUNCTION',
  'cloud:aws:rds': 'AWS_RDS_DBINSTANCE',
  'cloud:aws:aurora': 'AWS_RDS_DBCLUSTER',
  'cloud:aws:elasticachecustom': 'AWS_ELASTICACHE_CACHECLUSTER',
  'cloud:aws:sqs': 'AWS_SQS_QUEUE',
  'cloud:aws:sns': 'AWS_SNS_TOPIC',
  'cloud:aws:cloud_front': 'AWS_CLOUDFRONT_DISTRIBUTION',
  'cloud:aws:nat_gateway': 'AWS_EC2_NATGATEWAY',
  'cloud:aws:eks:cluster': 'AWS_EKS_CLUSTER',
  'cloud:aws:dynamodb': 'AWS_DYNAMODB_TABLE',
  'cloud:aws:redshift': 'AWS_REDSHIFT_CLUSTER',
  // entity-service.md
  service: 'SERVICE',
  host: 'HOST',
};

export interface Note { rule: string; citation: string; detail: string }

export function kbConvert(query: string): { out: string; notes: Note[]; unresolved: string[] } {
  let q = query;
  const notes: Note[] = [];
  const unresolved: string[] = [];
  const note = (rule: string, citation: string, detail: string) => notes.push({ rule, citation, detail });

  // R9 — metric-streams.md: Metric Streams keys have no new-connection metric.
  const streams = q.match(/(?:dt\.)?cloud\.aws\.[a-z0-9_]+\.[a-z][A-Za-z0-9]*By[A-Z][A-Za-z0-9]*/g) ?? [];
  for (const s of new Set(streams)) {
    unresolved.push(`metric-streams: ${s}`);
    note('R9', 'metric-streams.md', `${s} is Metric Streams — doc says not supported by the new connection`);
  }

  // R7 — metric keys.
  const keyRe = /((?:builtin:|ext:|dt\.)?cloud\.aws\.[A-Za-z0-9_.]+)/g;
  q = q.replace(keyRe, (whole) => {
    if (/\.By\./.test(whole)) return whole;              // already new-form
    if (/By[A-Z]/.test(whole)) return whole;             // Metric Streams, handled above
    const hit = lookupMetric(whole);
    if (hit) { note('R7', 'metric-key-mapping.md', `${whole} -> ${hit.newKey} (${hit.via})`); return hit.newKey; }
    unresolved.push(`unmapped-metric: ${whole}`);
    note('R7', 'metric-key-mapping.md', `${whole}: no entry in any KB table, and the heuristic needs a live query (doc §1 step 3)`);
    return whole;
  });

  // R5/R6 — dql-function-migration.md: selector tag() -> `tags:<ctx>`[k] == "v".
  q = q.replace(
    /in\(\s*`?(dt\.entity\.[\w:]+)`?\s*,\s*classicEntitySelector\(\s*"((?:\\.|[^"\\])*)"\s*\)\s*\)/g,
    (whole, _dim: string, sel: string) => {
      const raw = sel.replace(/\\(.)/g, '$1');
      const preds = raw.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
      const out: string[] = [];
      let allHandled = true;
      for (const p of preds) {
        if (/^type\(/i.test(p)) continue;                                  // R6: implied by the node type
        // The `[Context]` prefix is OPTIONAL — require the brackets for the
        // context group, or a plain `tag("applicationci:cwi")` gets split at
        // the wrong character.
        const tag = /^tag\(\s*"?(?:\[([^\]]+)\])?([^":\]]+):([^")]*)"?\s*\)$/i.exec(p);
        if (tag) {
          const ctx = (tag[1] || '').trim().toLowerCase();
          const key = tag[2]!.trim();
          const val = tag[3]!.trim();
          out.push(ctx ? `\`tags:${ctx}\`[${key}] == "${val}"` : `\`tags\`[${key}] == "${val}"`);
          note('R5', 'dql-function-migration.md', `tag(${key}:${val}) -> \`tags:${ctx || '?'}\`[${key}] == "${val}"`);
          continue;
        }
        allHandled = false;
        unresolved.push(`selector-predicate: ${p.slice(0, 60)}`);
        note('R5', 'dql-function-migration.md', `predicate not covered by the doc: ${p.slice(0, 60)}`);
      }
      // Leave the whole selector when any predicate has no rule — a partial
      // filter would change what the tile matches.
      if (!allHandled || out.length === 0) return whole;
      return out.join(' and ');
    }
  );

  // R1 — fetch dt.entity.X -> smartscapeNodes <TYPE>.
  q = q.replace(/fetch\s+`?dt\.entity\.([\w:]+)`?/g, (whole, t: string) => {
    const node = KB_ENTITY[t.toLowerCase()];
    if (!node) {
      unresolved.push(`unmapped-entity: ${t}`);
      note('R1', 'entity-type-mapping.md', `dt.entity.${t}: not in the doc's tables`);
      return whole;
    }
    note('R1', 'entity-type-mapping.md', `fetch dt.entity.${t} -> smartscapeNodes ${node}`);
    return `smartscapeNodes ${node}`;
  });

  // R3/R4 — bare dim refs: dt.entity.X -> dt.smartscape.X.
  q = q.replace(/(?<!fetch\s)`?dt\.entity\.([\w:]+)`?/g, (whole, t: string) => {
    if (/classicEntitySelector/.test(q) && whole.includes('classicEntitySelector')) return whole;
    note('R4', 'entity-service.md / entity-type-mapping.md §4', `dt.entity.${t} -> dt.smartscape.${t}`);
    return `dt.smartscape.${t}`;
  });

  // R2 — entity.name -> name; R8 — awsAccountId -> aws.account.id.
  if (/\bentity\.name\b/.test(q)) {
    q = q.replace(/\bentity\.name\b/g, 'name');
    note('R2', 'entity-type-mapping.md §4', 'entity.name -> name');
  }
  if (/\bawsAccountId\b/.test(q)) {
    q = q.replace(/\bawsAccountId\b/g, 'aws.account.id');
    note('R8', 'entity-type-mapping.md §4', 'awsAccountId -> aws.account.id');
  }

  // Relationship projections: the doc names the replacement CONCEPTS but gives
  // no recipe for `accessible_by[...]`, so flag rather than invent one.
  for (const rel of new Set(q.match(/\b(accessible_by|belongs_to|runs|instance_of|clustered_by)\[/g) ?? [])) {
    unresolved.push(`relationship: ${rel}`);
    note('R-rel', 'entity-type-mapping.md §4', `${rel}…] -> traverse/references: doc states the concept, gives no concrete rewrite`);
  }

  return { out: q, notes, unresolved };
}
