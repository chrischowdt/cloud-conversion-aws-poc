/**
 * build-mapping — transform the DAC reference JSON into a unified mapping
 * file shaped for the Dynatrace App's lookup utilities.
 *
 * The reference JSONs (cloud-migration-helper) are treated as authoritative.
 * The Python scrape (`mappings/aws_mapping.json`) is consulted only for a
 * coverage diff; gaps are reported but the DAC table wins.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  PYTHON_AWS_MAPPING,
  REFERENCE_AWS_METRICS,
  REFERENCE_AZURE_METRICS,
  REFERENCE_EOL_SERVICES,
  SHARED_OUT_DIR,
} from '../lib/paths.ts';
import type {
  CloudProvider,
  DacAwsMetricRow,
  DacAzureMetricRow,
  UnifiedMapping,
  UnifiedMetricRow,
} from '../lib/types.ts';

const NOT_MATCHED = 'not-matched';

function nullIfNotMatched(value: string | undefined | null): string | null {
  if (!value || value === NOT_MATCHED) return null;
  return value;
}

function transformAws(rows: DacAwsMetricRow[]): UnifiedMetricRow[] {
  return rows.map((r) => {
    const recommended = nullIfNotMatched(r.dacRecommendedMetricKey);
    const autodiscovered = nullIfNotMatched(r.dacAutodiscoveredMetricKey);
    const dacMetricKey = recommended ?? autodiscovered;
    return {
      provider: 'AWS',
      namespace: r.cloudwatchNamespace,
      cloudwatchMetricName: r.cloudwatchMetricName,
      cloudwatchDimensions: r.cloudwatchDimensions ?? [],
      classicBuiltInMetricKey: nullIfNotMatched(r.builtInMetricKey),
      classicExtensionMetricKey: nullIfNotMatched(r.secondGenMetricKey),
      dacMetricKey,
      isRecommended: dacMetricKey !== null && dacMetricKey === recommended,
      endOfLife: r.endOfLife === true,
    };
  });
}

function transformAzure(rows: DacAzureMetricRow[]): UnifiedMetricRow[] {
  return rows.map((r) => {
    const recommended = nullIfNotMatched(r.dacRecommendedMetricKey);
    const autodiscovered = nullIfNotMatched(r.dacAutodiscoveredMetricKey);
    const dacMetricKey = recommended ?? autodiscovered;
    return {
      provider: 'Azure',
      namespace: r.armResourceType,
      cloudwatchMetricName: '',
      cloudwatchDimensions: [],
      classicBuiltInMetricKey: nullIfNotMatched(r.builtInMetricKey),
      classicExtensionMetricKey: nullIfNotMatched(r.supportingServiceMetricKey),
      dacMetricKey,
      isRecommended: dacMetricKey !== null && dacMetricKey === recommended,
      endOfLife: r.endOfLife === true,
    };
  });
}

function buildStats(rows: UnifiedMetricRow[]) {
  const namespaces = new Set(rows.map((r) => r.namespace));
  return {
    namespaces: namespaces.size,
    rowsWithBuiltInMatch: rows.filter((r) => r.classicBuiltInMetricKey !== null).length,
    rowsWithDacMatch: rows.filter((r) => r.dacMetricKey !== null).length,
    rowsWithRecommended: rows.filter((r) => r.isRecommended).length,
    rowsWithEol: rows.filter((r) => r.endOfLife).length,
  };
}

async function loadJson<T>(path: string): Promise<T> {
  const buf = await readFile(path, 'utf8');
  return JSON.parse(buf) as T;
}

interface PythonMapping {
  serviceMappings: Array<{
    service: string;
    builtinMetricMappings?: Array<{
      classicMetricId: string;
      cloudwatchName: string | null;
    }>;
  }>;
}

interface SchemaDiff {
  pythonOnlyBuiltins: string[];
  dacOnlyBuiltins: string[];
  bothCount: number;
}

async function diffPythonScrape(awsRows: UnifiedMetricRow[]): Promise<SchemaDiff | null> {
  let python: PythonMapping;
  try {
    python = await loadJson<PythonMapping>(PYTHON_AWS_MAPPING);
  } catch {
    return null;
  }
  const pythonBuiltins = new Set<string>();
  for (const svc of python.serviceMappings ?? []) {
    for (const bm of svc.builtinMetricMappings ?? []) {
      if (bm.classicMetricId) pythonBuiltins.add(bm.classicMetricId);
    }
  }
  const dacBuiltins = new Set<string>();
  for (const r of awsRows) {
    if (r.classicBuiltInMetricKey) dacBuiltins.add(r.classicBuiltInMetricKey);
  }
  const pythonOnly = [...pythonBuiltins].filter((k) => !dacBuiltins.has(k)).sort();
  const dacOnly = [...dacBuiltins].filter((k) => !pythonBuiltins.has(k)).sort();
  const both = [...pythonBuiltins].filter((k) => dacBuiltins.has(k)).length;
  return {
    pythonOnlyBuiltins: pythonOnly,
    dacOnlyBuiltins: dacOnly,
    bothCount: both,
  };
}

export interface BuildMappingArgs {
  provider?: CloudProvider | 'all';
  outDir?: string;
}

export async function runBuildMapping(args: BuildMappingArgs = {}): Promise<void> {
  const provider = args.provider ?? 'all';
  const outDir = args.outDir ?? SHARED_OUT_DIR;
  await mkdir(outDir, { recursive: true });

  const generated = new Date().toISOString().slice(0, 10);

  const eolServices = await loadJson<unknown[]>(REFERENCE_EOL_SERVICES);

  if (provider === 'AWS' || provider === 'all') {
    const awsRaw = await loadJson<DacAwsMetricRow[]>(REFERENCE_AWS_METRICS);
    const awsRows = transformAws(awsRaw);
    const awsMapping: UnifiedMapping = {
      generated,
      source: {
        provider: 'AWS',
        file: 'reference/docs/dac-aws-to-2ndgen-metrics.json',
        rowCount: awsRaw.length,
      },
      stats: buildStats(awsRows),
      rows: awsRows,
    };
    await writeFile(join(outDir, 'aws_mapping.unified.json'), JSON.stringify(awsMapping, null, 2));

    const diff = await diffPythonScrape(awsRows);
    if (diff) {
      await writeFile(
        join(outDir, 'aws_mapping.schema_diff.json'),
        JSON.stringify(
          {
            generated,
            note:
              'Python scrape vs DAC reference: classic builtIn keys that exist in only one source. ' +
              'These need reconciliation against a real tenant.',
            ...diff,
          },
          null,
          2
        )
      );
      console.log(`AWS schema diff: ${diff.bothCount} match, ${diff.pythonOnlyBuiltins.length} python-only, ${diff.dacOnlyBuiltins.length} dac-only`);
    }

    console.log(
      `AWS unified mapping: ${awsRows.length} rows, ${awsMapping.stats.namespaces} namespaces, ` +
        `${awsMapping.stats.rowsWithBuiltInMatch} with classic builtIn, ` +
        `${awsMapping.stats.rowsWithDacMatch} with dac key, ` +
        `${awsMapping.stats.rowsWithEol} EOL`
    );
  }

  if (provider === 'Azure' || provider === 'all') {
    const azureRaw = await loadJson<DacAzureMetricRow[]>(REFERENCE_AZURE_METRICS);
    const azureRows = transformAzure(azureRaw);
    const azureMapping: UnifiedMapping = {
      generated,
      source: {
        provider: 'Azure',
        file: 'reference/docs/dac-azure-to-2ndgen-metrics.json',
        rowCount: azureRaw.length,
      },
      stats: buildStats(azureRows),
      rows: azureRows,
    };
    await writeFile(
      join(outDir, 'azure_mapping.unified.json'),
      JSON.stringify(azureMapping, null, 2)
    );
    console.log(
      `Azure unified mapping: ${azureRows.length} rows, ${azureMapping.stats.namespaces} services, ` +
        `${azureMapping.stats.rowsWithBuiltInMatch} with classic builtIn, ` +
        `${azureMapping.stats.rowsWithDacMatch} with dac key, ` +
        `${azureMapping.stats.rowsWithEol} EOL`
    );
  }

  // Pass through the EOL service registry so the App can ship a single dir.
  await writeFile(
    join(outDir, 'eol_services.json'),
    JSON.stringify(eolServices, null, 2)
  );

  console.log(`Wrote unified mappings to ${outDir}`);
}
