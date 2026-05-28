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

export const OUT_DIR = resolve(REPO_ROOT, 'tools', 'out');
