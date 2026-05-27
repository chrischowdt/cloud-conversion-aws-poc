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
