/**
 * A temp tenant out dir holding published alerts as migrate-promote-detectors
 * leaves them: rows on the alerts sheet of a real workbook, the review manifest,
 * `pre/<id>.json` snapshots and `published/<id>.json` records, plus a fake
 * Settings API holding the live alerts. For the verify and rollback command
 * tests; nothing here contacts a tenant.
 */

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ALERTS_SHEET, upsertRows, type TrackerRow } from '../../lib/tracker-xlsx.ts';
import type { ManifestBatch } from '../../lib/detector-publish.ts';
import { fakeSettings, type FakeSettingsHooks, type Stored } from './fake-settings.ts';

export const BASE_URL = 'https://abc12345.apps.dynatrace.com';
export const ENV = 'abc12345';
export const NOW = new Date('2026-11-09T12:00:00.000Z');
export const PUBLISHED_AT = '2026-11-06T12:00:00.000Z';
export const SNAPSHOT_AT = '2026-11-06T11:59:00.000Z';

export const CLASSIC = 'timeseries v = avg(cloud.aws.sqs.messages_visible), by:{dt.entity.custom_device}';
export const APPROVED = 'timeseries v = avg(cloud.aws.sqs.ApproximateNumberOfMessagesVisible.By.QueueName), by:{dt.smartscape.aws_sqs_queue}';

export type Prop = { key: string; value: string };

export const CLASSIC_PROPS: Prop[] = [
  { key: 'event.name', value: 'Backlog on {dims:dt.entity.custom_device.name}' },
  { key: 'dt.source_entity', value: '{dims:dt.entity.custom_device}' },
];
export const NEW_PROPS: Prop[] = [
  { key: 'event.name', value: 'Backlog on {dims:dt.smartscape.aws_sqs_queue.name}' },
  { key: 'dt.smartscape_source.id', value: '{dt.smartscape.aws_sqs_queue}' },
];

export function detector(query: string, props: Prop[], over: { threshold?: string; enabled?: boolean } = {}): Record<string, unknown> {
  return {
    enabled: over.enabled ?? true,
    title: 'Queue backlog',
    executionSettings: { actor: 'actor-1' },
    analyzer: {
      name: 'dt.statistics.ui.anomaly_detection.StaticThresholdAnomalyDetectionAnalyzer',
      input: [
        { key: 'query', value: query },
        { key: 'threshold', value: over.threshold ?? '100' },
      ],
    },
    eventTemplate: { properties: props },
  };
}

/** The value before the publish, and the value the publish wrote. */
export const preValue = (): Record<string, unknown> => detector(CLASSIC, CLASSIC_PROPS);
export const publishedValue = (): Record<string, unknown> => detector(APPROVED, NEW_PROPS);

export interface AlertFixture {
  id: string;
  /** Default `promoted`. */
  status?: string;
  /** Default `Published`. */
  decision?: string;
  reasons?: string;
  /** The live alert; default the published value. `null`: no such alert. */
  live?: Stored | null;
  /** `published/<id>.json`'s value; default the published value. `null`: no file. */
  published?: Record<string, unknown> | null;
  /** `pre/<id>.json`'s value; default the value before the publish. `null`: no file. */
  pre?: Record<string, unknown> | null;
}

export async function publishedAlerts(alerts: AlertFixture[], opts: { manifest?: ManifestBatch[]; hooks?: FakeSettingsHooks } = {}) {
  const outDir = await mkdtemp(join(tmpdir(), 'published-alerts-'));
  const trackerPath = join(outDir, 'migration-tracker.xlsx');
  const promoteDir = join(outDir, 'migration', 'detector-promote');

  const rows: TrackerRow[] = alerts.map((a) => ({
    asset_id: a.id,
    asset_type: 'anomaly-detector',
    name: `Queue backlog ${a.id}`,
    status: a.status ?? 'promoted',
    decision: a.decision ?? 'Published',
    reasons: a.reasons ?? 'a publish note',
    review_batch: 'batch-03',
  }));
  await upsertRows(trackerPath, rows, ALERTS_SHEET);

  const manifest = opts.manifest ?? [{ batch: 'batch-03', notebookId: 'nb-3', detectors: alerts.map((a) => ({ objectId: a.id, title: `Queue backlog ${a.id}` })) }];
  await mkdir(join(outDir, 'migration', 'detector-review'), { recursive: true });
  await writeFile(join(outDir, 'migration', 'detector-review', 'manifest.json'), JSON.stringify({ batches: manifest }, null, 2));

  await mkdir(join(promoteDir, 'pre'), { recursive: true });
  await mkdir(join(promoteDir, 'published'), { recursive: true });
  const store = new Map<string, Stored>();
  for (const a of alerts) {
    const pre = a.pre === undefined ? preValue() : a.pre;
    if (pre) await writeFile(join(promoteDir, 'pre', `${a.id}.json`), JSON.stringify({ objectId: a.id, title: `Queue backlog ${a.id}`, snapshotAt: SNAPSHOT_AT, value: pre }, null, 2));
    const published = a.published === undefined ? publishedValue() : a.published;
    if (published) await writeFile(join(promoteDir, 'published', `${a.id}.json`), JSON.stringify({ objectId: a.id, publishedAt: PUBLISHED_AT, value: published }, null, 2));
    const live = a.live === undefined ? { value: publishedValue(), updateToken: `tok-${a.id}-0`, schemaVersion: '1.2.3' } : a.live;
    if (live) store.set(a.id, live);
  }

  const settings = fakeSettings(store, opts.hooks);
  const sheets: Array<{ path: string; rows: TrackerRow[]; sheet: string }> = [];
  const lines: string[] = [];
  const deps = (over: Record<string, unknown> = {}) => ({
    settings,
    upsert: async (path: string, r: TrackerRow[], sheet: string) => {
      sheets.push({ path, rows: structuredClone(r), sheet });
    },
    log: (line: string) => lines.push(line),
    now: () => NOW,
    ...over,
  });
  const args = { outDir, baseUrl: BASE_URL, token: 't', trackerPath };
  return { outDir, trackerPath, promoteDir, store, settings, sheets, lines, deps, args };
}
