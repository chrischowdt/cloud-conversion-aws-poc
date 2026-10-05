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
 * The ORIGINAL gets exactly one change: a pointer tile at the top linking to the
 * new notebook (otherwise its owner would never find it). That write is
 * version-locked, and the original is re-read afterwards to prove every other
 * section — every query, setting and stored result — came through byte-identical.
 *
 * Reversible: the copy's pre-publish state is snapshotted to
 * migration/pre-publish/<originalId>.json and the original's to
 * <originalId>.original.json; migrate-rollback restores the copy and takes the
 * pointer back out of the original.
 */

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DocumentClient, DocumentApiError } from '../dynatrace/document.ts';
import { stripOriginalCommentsInPlace } from './rewrite-dashboard.ts';
import { lintAsset, summarize } from '../lib/output-lint.ts';
import {
  POINTER_SECTION_ID,
  buildMigrationNotice,
  buildOriginalPointer,
  countReferenceBlocks,
  publishedNotebookName,
  sameSectionsExcept,
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
  /** Link to the review copy — after publishing, the NEW notebook. Used in the pointer. */
  reviewCopyUrl?: string;
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

/**
 * Add the pointer tile to the top of the original, then PROVE nothing else moved.
 * Version-locked to what we read at the start: if the owner edited the notebook
 * in the meantime, we leave it alone rather than race their change.
 */
async function addPointerToOriginal(
  c: NotebookPublishCandidate,
  versionReadAtStart: number | undefined,
  pointer: string,
  ctx: NotebookPublishContext
): Promise<string> {
  let orig;
  try {
    orig = await ctx.client.getDocumentFull(c.id, true);
  } catch (e) {
    return `! pointer NOT added — original not readable (${errText(e)})`;
  }
  if (versionReadAtStart !== undefined && orig.metadata.version !== versionReadAtStart) {
    return `! pointer NOT added — the original changed while publishing (v${versionReadAtStart} → v${orig.metadata.version}); re-run to add it`;
  }
  const before = typeof orig.content === 'string' ? JSON.parse(orig.content) : orig.content;

  // First snapshot wins, so a republish keeps the true pre-pointer state.
  const snapPath = join(ctx.prePublishDir, `${c.id}.original.json`);
  if (!existsSync(snapPath)) {
    await writeFile(snapPath, JSON.stringify({ originalId: c.id, name: orig.metadata.name, version: orig.metadata.version, content: orig.content }, null, 2));
  }

  const withPointer = withMigrationNotice(before, pointer, POINTER_SECTION_ID);
  try {
    await ctx.client.updateContent(c.id, {
      name: String(orig.metadata.name ?? c.name), // unchanged — the original keeps its name
      type: 'notebook',
      content: withPointer,
      version: orig.metadata.version,
      adminAccess: true,
    });
  } catch (e) {
    return `! pointer NOT added (${errText(e)})`;
  }

  // Re-read and compare: every section other than the pointer must be identical.
  try {
    const after = await ctx.client.getDocumentFull(c.id, true);
    const ac = typeof after.content === 'string' ? JSON.parse(after.content) : after.content;
    const n = ((before as { sections?: unknown[] }).sections ?? []).filter((s: any) => s?.id !== POINTER_SECTION_ID).length;
    if (!sameSectionsExcept(before, ac, POINTER_SECTION_ID)) {
      return `! ORIGINAL CHANGED BEYOND THE POINTER — investigate; snapshot at ${snapPath}`;
    }
    if (String(after.metadata.name) !== String(orig.metadata.name)) {
      return `! original was RENAMED to "${after.metadata.name}" — investigate`;
    }
    return `pointer added to the original (v${orig.metadata.version} → v${after.metadata.version}); its ${n} other section(s) are byte-identical`;
  } catch (e) {
    return `pointer added, but could not re-read the original to confirm (${errText(e)})`;
  }
}

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
  const pointer = buildOriginalPointer({ newName: name, newUrl: c.reviewCopyUrl, date: today() });

  if (!ctx.apply) {
    await mkdir(ctx.publishDir, { recursive: true });
    await writeFile(
      join(ctx.publishDir, `${c.id}.json`),
      JSON.stringify({ originalId: c.id, reviewCopyId: c.reviewCopyId, name, content: published }, null, 2)
    );
    try {
      const orig = await ctx.client.getDocumentFull(c.id, true);
      const oc = typeof orig.content === 'string' ? JSON.parse(orig.content) : orig.content;
      await writeFile(
        join(ctx.publishDir, `${c.id}.original.json`),
        JSON.stringify({ originalId: c.id, name: orig.metadata.name, content: withMigrationNotice(oc, pointer, POINTER_SECTION_ID) }, null, 2)
      );
    } catch { /* the original was readable a moment ago; the apply path re-checks */ }
    console.log(
      `  · ${c.name} → would publish copy ${c.reviewCopyId} as "${name}"` +
        `${leftover ? ` (! ${leftover} reference block(s) not stripped)` : ''}; ` +
        `would add a pointer tile to the top of the original (v${origVersion}), changing nothing else`
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

  // The pointer on the ORIGINAL — the one change it gets. Non-fatal: the new
  // notebook is already published and correct whether or not this succeeds.
  const pointerNote = await addPointerToOriginal(c, origVersion, pointer, ctx);

  console.log(`  ✓ ${c.name} → published "${name}" (${c.reviewCopyId})${shareNote}; ${pointerNote}`);
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
