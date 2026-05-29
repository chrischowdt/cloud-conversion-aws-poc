import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root: `tools/src/lib/paths.ts` → up three levels. */
export const REPO_ROOT = resolve(here, '..', '..', '..');

export const REFERENCE_AWS_METRICS = resolve(
  REPO_ROOT,
  'reference',
  'docs',
  'dac-aws-to-2ndgen-metrics.json'
);

/**
 * Fresh DAC AWS metrics mapping shipped with the dt-migration skill. This
 * is the same shape as REFERENCE_AWS_METRICS but refreshed alongside the
 * skill — prefer it as the primary mapping source when present.
 */
export const SKILL_DAC_AWS_METRICS = resolve(
  REPO_ROOT,
  'dt-migration',
  'references',
  'dac-aws-to-2ndgen-metrics.json'
);

/**
 * ~117 hand-curated AWS metric abbreviations from the dt-migration skill
 * (`cloud.aws.alb.bytes`, `cloud.aws.aurora.*_by_role`, `cloud.aws.eccustom.*`,
 * etc.). Dynatrace shorthands that don't algorithmically derive from
 * CloudWatch; the DAC normalization chain will never resolve them.
 */
export const SKILL_MANUAL_AWS_METRICS = resolve(
  REPO_ROOT,
  'dt-migration',
  'references',
  'manual-metric-mappings.json'
);

/**
 * ~5,709 pre-resolved AWS metric mappings shipped with the dt-migration skill —
 * output of the skill team's own normalization chain (selector-strip,
 * dt.cloud→builtin:cloud, dimension-suffix strip, service-segment scan).
 * Catches keys our local DAC normalization misses, especially lowercased
 * ext: keys and Cassandra-shape `builtin:aws.X` shapes.
 */
export const SKILL_PER_KEY_AWS_METRICS = resolve(
  REPO_ROOT,
  'dt-migration',
  'references',
  'per-key-mappings.json'
);

export const REFERENCE_AZURE_METRICS = resolve(
  REPO_ROOT,
  'reference',
  'docs',
  'dac-azure-to-2ndgen-metrics.json'
);

export const REFERENCE_AWS_ENTITIES = resolve(
  REPO_ROOT,
  'reference',
  'docs',
  'dac-aws-to-2ndgen-entities.json'
);

export const REFERENCE_EOL_SERVICES = resolve(
  REPO_ROOT,
  'reference',
  'docs',
  'end-of-life-services.json'
);

export const PYTHON_AWS_MAPPING = resolve(
  REPO_ROOT,
  'mappings',
  'aws_mapping.json'
);

/** Root of all generated output. Tenant-scoped runs land in subdirectories. */
export const OUT_DIR = resolve(REPO_ROOT, 'tools', 'out');

/**
 * Output for tenant-independent artifacts (e.g. `build-mapping`, which reads
 * DAC reference files, not a live tenant). Kept separate from per-tenant data
 * so it's obvious these don't belong to any one environment.
 */
export const SHARED_OUT_DIR = resolve(OUT_DIR, 'shared');

/**
 * Derive a stable, filesystem-safe environment id from a Dynatrace tenant URL.
 *
 *   https://nic55601.apps.dynatrace.com        → "nic55601"
 *   https://abc12345.apps.dynatrace.com/        → "abc12345"
 *   https://abc12345.live.dynatrace.com         → "abc12345"
 *   https://my.managed.host/e/<uuid>            → "<uuid>"  (managed cluster)
 *
 * Falls back to a sanitized form of the whole host when no recognizable
 * env-id is present, so two distinct tenants never collide.
 */
export function envIdFromBaseUrl(baseUrl: string): string {
  let host = baseUrl.trim();
  // Strip scheme + any path/query.
  host = host.replace(/^[a-z]+:\/\//i, '');
  const slash = host.indexOf('/');
  const path = slash >= 0 ? host.slice(slash) : '';
  if (slash >= 0) host = host.slice(0, slash);
  host = host.replace(/:\d+$/, ''); // drop port

  // Managed cluster: env id lives in the `/e/<envId>` path segment.
  const managed = /\/e\/([a-z0-9-]+)/i.exec(path);
  if (managed) return sanitizeEnvId(managed[1]!);

  // SaaS: the env id is the first DNS label of *.apps|live.dynatrace.com.
  const saas = /^([a-z0-9-]+)\.(?:apps|live)\.dynatrace\.com$/i.exec(host);
  if (saas) return sanitizeEnvId(saas[1]!);

  // Anything else: use the whole host, sanitized, so it's still unique.
  return sanitizeEnvId(host || 'unknown-tenant');
}

function sanitizeEnvId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown-tenant';
}

/**
 * Resolve the output directory for a command that talks to a tenant.
 *
 *   - An explicit `override` (the `--out-dir` flag) always wins, verbatim.
 *   - An explicit `env` label (the `--env` flag) is used as the subdirectory.
 *   - Otherwise the env id is derived from `baseUrl`.
 *
 * Result is always `tools/out/<envId>` unless overridden, so two tenants
 * never write to the same place.
 */
export function tenantOutDir(opts: {
  baseUrl?: string;
  env?: string;
  override?: string;
}): string {
  if (opts.override) return resolve(opts.override);
  const envId = opts.env
    ? sanitizeEnvId(opts.env)
    : opts.baseUrl
      ? envIdFromBaseUrl(opts.baseUrl)
      : 'unknown-tenant';
  return resolve(OUT_DIR, envId);
}
