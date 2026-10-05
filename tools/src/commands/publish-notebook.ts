/**
 * The NOTEBOOK branch of migrate-promote: publish the reviewed copy as a new
 * notebook and leave the original exactly as it is.
 *
 * Why not cut over in place like dashboards: a notebook stores the results of its
 * past query runs with the queries, so overwriting it destroys them. Instead the
 * review copy (already reviewed and marked Ready To Publish) becomes the new
 * notebook:
 *   - renamed  "[MIGRATION REVIEW] X"  →  "X (new AWS integration)"
 *   - the `//` original-query reference blocks stripped, as in a dashboard cutover
 *   - a notice tile added at the top explaining what happened, linking the original
 *   - shared with the original's owner, so the person who owns the notebook can use it
 * The ORIGINAL is read (to prove it is untouched) but never written.
 *
 * Reversible: the copy's pre-publish state is snapshotted to
 * migration/pre-publish/<originalId>.json, which migrate-rollback restores.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DocumentClient, DocumentApiError } from '../dynatrace/document.ts';
import { stripOriginalCommentsInPlace } from './rewrite-dashboard.ts';
import { lintAsset, summarize } from '../lib/output-lint.ts';
import {
  buildMigrationNotice,
  countReferenceBlocks,
  publishedNotebookName,
  withMigrationNotice,
} from '../lib/notebook-publish.ts';
import { PUBLISHED, type TrackerRow } from '../lib/tracker-xlsx.ts';

/** Tracker status for a notebook published as new. Kept distinct from `promoted`
 *  so migrate-verify / migrate-rollback never treat the ORIGINAL as cut over. */
export const PUBLISHED_NEW_STATUS = 'published-new';

export interface NotebookPublishCandidate {
  /** The ORIGINAL notebook id (the tracker row). */
  id: string;
  name: string;
  reviewCopyId?: string;
  assetUrl?: string;
  reviewer?: string;
}

export interface NotebookPublishContext {
  client: DocumentClient;
  apply: boolean;
  ignoreLint: boolean;
  /** Where prepare-mode payloads go. */
  publishDir: string;
  /** Where pre-publish snapshots of the review copy go. */
  prePublishDir: string;
}

export type NotebookPublishOutcome =
  | { kind: 'prepared' }
  | { kind: 'published'; row: TrackerRow }
  | { kind: 'skipped'; reason: string };

const today = () => new Date().toISOString().slice(0, 10);
const errText = (e: unknown) =>
  e instanceof DocumentApiError ? `HTTP ${e.status}: ${e.body.slice(0, 140)}` : (e as Error).message;

export async function publishNotebookAsNew(
  c: NotebookPublishCandidate,
  ctx: NotebookPublishContext
): Promise<NotebookPublishOutcome> {
  if (!c.reviewCopyId) return { kind: 'skipped', reason: 'no review copy recorded — stage it first' };

  // The original: read only, to prove later that it was not touched.
  let origVersion: number | undefined;
  let origOwner: string | undefined;
  try {
    const meta = await ctx.client.getMetadata(c.id, true);
    origVersion = meta.version;
    origOwner = meta.owner;
  } catch (e) {
    return { kind: 'skipped', reason: `original not readable (${errText(e)})` };
  }

  // The review copy's LIVE content — what the reviewer actually approved. A
  // pulled file can be older than the reviewer's last edit, and publishing it
  // would silently revert that edit.
  let live;
  try {
    live = await ctx.client.getDocumentFull(c.reviewCopyId, true);
  } catch (e) {
    return { kind: 'skipped', reason: `review copy not readable (${errText(e)})` };
  }
  const content = structuredClone(typeof live.content === 'string' ? JSON.parse(live.content) : live.content);

  stripOriginalCommentsInPlace(content);
  const leftover = countReferenceBlocks(content);

  // Same gate as a dashboard cutover: refuse shapes proven to return nothing.
  const findings = lintAsset(content);
  const lint = summarize(findings);
  if (lint.blocking > 0 && !ctx.ignoreLint) {
    const rules = [...new Set(findings.filter((f) => f.severity === 'blocking').map((f) => f.ruleId))].join(', ');
    return { kind: 'skipped', reason: `${lint.blocking} blocking lint finding(s): ${rules} (--ignore-lint to override)` };
  }

  const notice = buildMigrationNotice({ originalName: c.name, originalUrl: c.assetUrl, reviewer: c.reviewer, date: today() });
  const published = withMigrationNotice(content, notice);
  const name = publishedNotebookName(c.name);

  if (!ctx.apply) {
    await mkdir(ctx.publishDir, { recursive: true });
    await writeFile(
      join(ctx.publishDir, `${c.id}.json`),
      JSON.stringify({ originalId: c.id, reviewCopyId: c.reviewCopyId, name, content: published }, null, 2)
    );
    console.log(
      `  · ${c.name} → would publish copy ${c.reviewCopyId} as "${name}"` +
        `${leftover ? ` (! ${leftover} reference block(s) not stripped)` : ''}; original v${origVersion} left as is`
    );
    return { kind: 'prepared' };
  }

  // Snapshot the copy BEFORE changing it. First snapshot wins, so a re-run after
  // a partial failure keeps the true pre-publish state for rollback.
  await mkdir(ctx.prePublishDir, { recursive: true });
  const snapPath = join(ctx.prePublishDir, `${c.id}.json`);
  if (!existsSync(snapPath)) {
    await writeFile(
      snapPath,
      JSON.stringify({ originalId: c.id, reviewCopyId: c.reviewCopyId, name: live.metadata.name, content: live.content }, null, 2)
    );
  }

  try {
    await ctx.client.updateContent(c.reviewCopyId, {
      name,
      type: 'notebook',
      content: published,
      version: live.metadata.version,
      adminAccess: true,
    });
  } catch (e) {
    return { kind: 'skipped', reason: `publish failed: ${errText(e)}` };
  }

  // Give the original owner access. Non-fatal: the notebook is published either way.
  let shareNote = '';
  if (origOwner && origOwner !== live.metadata.owner) {
    try {
      await ctx.client.shareWithUser(c.reviewCopyId, origOwner, 'read-write');
      shareNote = '; shared with the original owner';
    } catch (e) {
      shareNote = `; ! could not share with the original owner (${errText(e)})`;
    }
  }

  // Prove the original was not touched.
  let untouched = 'original untouched';
  try {
    const after = await ctx.client.getMetadata(c.id, true);
    if (after.version !== origVersion) untouched = `! ORIGINAL VERSION CHANGED v${origVersion} → v${after.version} — investigate`;
    else untouched = `original untouched (still v${origVersion})`;
  } catch (e) {
    untouched = `could not re-read the original (${errText(e)})`;
  }

  console.log(`  ✓ ${c.name} → published "${name}" (${c.reviewCopyId})${shareNote}; ${untouched}`);
  return {
    kind: 'published',
    row: {
      asset_id: c.id,
      asset_type: 'notebook',
      name: c.name,
      status: PUBLISHED_NEW_STATUS,
      decision: PUBLISHED,
      promoted_at: new Date().toISOString(),
    },
  };
}
