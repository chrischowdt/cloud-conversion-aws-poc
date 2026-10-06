/**
 * The NOTEBOOK branch of migrate-promote: publish the reviewed copy as a new
 * notebook and leave the original exactly as it is.
 *
 * Why not cut over in place like dashboards: a notebook stores the results of its
 * past query runs with the queries, so overwriting it destroys them. Instead the
 * review copy (already reviewed and marked Ready To Publish) becomes the new
 * notebook:
 *   - renamed  "[MIGRATION REVIEW] X"  →  "X" (the original's own title, unchanged)
 *   - labelled `aws-new-integration`; the original is labelled `aws-classic-superseded`
 *   - the `//` original-query reference blocks stripped, as in a dashboard cutover
 *   - a notice tile added at the top explaining what happened, linking the original
 *   - given the original's OWNER and exactly the original's sharing settings (public
 *     flag, re-share flag, direct and environment shares) — not the review group's
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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { findOriginal } from '../lib/migrate-support.ts';

import { DocumentClient, DocumentApiError, type SharingState } from '../dynatrace/document.ts';
import { describeSharing, planSharingMirror, sameSharing, type SharingPlan } from '../lib/doc-sharing.ts';
import { stripOriginalCommentsInPlace } from './rewrite-dashboard.ts';
import { lintAsset, summarize } from '../lib/output-lint.ts';
import {
  POINTER_SECTION_ID,
  SUPERSEDED_LABEL,
  UPGRADED_LABEL,
  authoredChangesSince,
  mergeLabels,
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
  /** Re-publish even when both notebooks already carry their labels (e.g. after changing the tile text). */
  republish?: boolean;
  /** Where prepare-mode payloads go. */
  publishDir: string;
  /** Where pre-publish snapshots of the review copy go. */
  prePublishDir: string;
  /** Tenant out dir; the downloaded original there is the base the review copy was staged from. */
  outDir: string;
  /** Publish even though the owner edited the original after it was staged (their edits will be missing). */
  force?: boolean;
}

export type NotebookPublishOutcome =
  | { kind: 'prepared' }
  | { kind: 'published'; row: TrackerRow; recordedOnly?: boolean }
  | { kind: 'skipped'; reason: string };

const today = () => new Date().toISOString().slice(0, 10);
const errText = (e: unknown) =>
  e instanceof DocumentApiError ? `HTTP ${e.status}: ${e.body.slice(0, 140)}` : (e as Error).message;

/**
 * Perform a sharing plan on one document. Every step is attempted; failures are
 * returned rather than thrown so the caller can verify and report the end state.
 * The flags are owner-only — call this while the tool owns the document.
 */
export async function applySharingPlan(client: DocumentClient, docId: string, plan: SharingPlan): Promise<string[]> {
  const failures: string[] = [];
  const attempt = async (what: string, fn: () => Promise<unknown>) => {
    try { await fn(); } catch (e) { failures.push(`${what}: ${errText(e)}`); }
  };
  // Grant before revoking. Deleting first meant a failed create left someone
  // without access (it happened: a republish removed a user's share and the
  // re-create was refused). In this order a failure can only leave EXTRA access
  // behind for a moment, never take away access someone should have.
  for (const s of plan.createDirect) await attempt('add a direct share', () => client.createDirectShare(docId, s.access, s.recipients));
  for (const s of plan.addRecipients) await attempt('add recipients to a direct share', () => client.addDirectShareRecipients(s.shareId, s.recipients));
  for (const a of plan.createEnvironment) await attempt('add an environment share', () => client.shareEnvironment(docId, a));
  if (plan.flags) {
    await attempt('set private/reshareable flags', async () => {
      const meta = await client.getMetadata(docId, true);
      await client.setSharingFlags(docId, plan.flags!, Number(meta.version));
    });
  }
  // Only revoke once every grant above succeeded.
  if (failures.length) {
    failures.push('removals skipped because a grant failed — fix and re-run');
    return failures;
  }
  for (const s of plan.removeRecipients) await attempt('remove recipients from a direct share', () => client.removeDirectShareRecipients(s.shareId, s.ids));
  for (const id of plan.deleteDirect) await attempt('remove a direct share', () => client.deleteDirectShare(id));
  for (const id of plan.deleteEnvironment) await attempt('remove an environment share', () => client.deleteEnvironmentShare(id));
  return failures;
}

/** Human summary of what a sharing plan will do, including the ownership move. */
function describePlan(p: SharingPlan, target: SharingState, current: SharingState): string {
  const steps: string[] = [];
  if (p.flags) steps.push(`set ${p.flags.isPrivate ? 'private' : 'public'}, ${p.flags.isReshareable ? 'reshareable' : 'not reshareable'}`);
  if (p.deleteDirect.length) steps.push(`remove ${p.deleteDirect.length} direct share(s)`);
  if (p.createDirect.length) steps.push(`add ${p.createDirect.length} direct share(s)`);
  const added = p.addRecipients.reduce((n, s) => n + s.recipients.length, 0);
  const removed = p.removeRecipients.reduce((n, s) => n + s.ids.length, 0);
  if (added) steps.push(`add ${added} recipient(s) to an existing direct share`);
  if (removed) steps.push(`remove ${removed} recipient(s) from an existing direct share`);
  if (p.deleteEnvironment.length) steps.push(`remove ${p.deleteEnvironment.length} environment share(s)`);
  if (p.createEnvironment.length) steps.push(`add ${p.createEnvironment.length} environment share(s)`);
  if (target.owner && target.owner !== current.owner) steps.push(`transfer ownership ${current.owner.slice(0, 8)} → ${target.owner.slice(0, 8)}`);
  return `${steps.length ? steps.join('; ') : 'already identical'} [original: ${describeSharing(target)}]`;
}

/**
 * Make the new notebook's owner and sharing identical to the original's, then
 * PROVE it by re-reading both. Order matters: the public/re-share flags are
 * owner-only, so they and the shares are set while we still own the copy, and
 * the ownership transfer — which removes our own access — goes last.
 *
 * The copy's pre-publish owner and sharing are snapshotted (first wins) so
 * migrate-rollback can put the review copy back as it was.
 */
async function mirrorOwnerAndSharing(c: NotebookPublishCandidate, copyId: string, ctx: NotebookPublishContext): Promise<string> {
  let target: SharingState, current: SharingState;
  try {
    [target, current] = await Promise.all([ctx.client.getSharingState(c.id), ctx.client.getSharingState(copyId)]);
  } catch (e) {
    return `! owner/sharing NOT mirrored — could not read sharing (${errText(e)})`;
  }
  const snapPath = join(ctx.prePublishDir, `${c.id}.sharing.json`);
  if (!existsSync(snapPath)) await writeFile(snapPath, JSON.stringify({ reviewCopyId: copyId, sharing: current }, null, 2));

  const failures = await applySharingPlan(ctx.client, copyId, planSharingMirror(target, current));

  let transferred = false;
  if (target.owner && target.owner !== current.owner) {
    try {
      await ctx.client.transferOwner(copyId, target.owner);
      transferred = true;
    } catch (e) {
      failures.push(`transfer ownership: ${errText(e)}`);
      // Fallback so the owner can at least open it.
      try { await ctx.client.shareWithUser(copyId, target.owner); }
      catch (e2) { failures.push(`fallback share with the original owner: ${errText(e2)}`); }
    }
  }

  // Prove it — after one more pass. The first plan had to leave out anyone who
  // was the copy's owner at the time (the API won't share a document with its
  // own owner); now that ownership has moved, they can be added.
  try {
    let after = await ctx.client.getSharingState(copyId);
    if (!sameSharing(target, after)) {
      failures.push(...(await applySharingPlan(ctx.client, copyId, planSharingMirror(target, after))));
      after = await ctx.client.getSharingState(copyId);
    }
    const ownerOk = after.owner === target.owner;
    const shareOk = sameSharing(target, after);
    const head = ownerOk && shareOk
      ? `owner and sharing now match the original (${transferred ? 'ownership transferred' : 'same owner'}; ${describeSharing(after)})`
      : `! owner/sharing do NOT match the original — owner ${ownerOk ? 'ok' : `${after.owner.slice(0, 8)} ≠ ${target.owner.slice(0, 8)}`}, ` +
        `sharing ${shareOk ? 'ok' : `[new: ${describeSharing(after)}] vs [original: ${describeSharing(target)}]`}`;
    return failures.length ? `${head}; errors: ${failures.join(' | ')}` : head;
  } catch (e) {
    return `could not re-read sharing to confirm (${errText(e)})${failures.length ? `; errors: ${failures.join(' | ')}` : ''}`;
  }
}

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
      // Marks it superseded, so future scans skip it instead of queueing it again.
      labels: mergeLabels(orig.metadata.labels, [SUPERSEDED_LABEL]),
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
    const labelled = (after.metadata.labels ?? []).includes(SUPERSEDED_LABEL);
    return (
      `pointer added to the original (v${orig.metadata.version} → v${after.metadata.version}); its ${n} other section(s) are byte-identical; ` +
      (labelled ? `labelled ${SUPERSEDED_LABEL}` : `! label ${SUPERSEDED_LABEL} NOT present`)
    );
  } catch (e) {
    return `pointer added, but could not re-read the original to confirm (${errText(e)})`;
  }
}

export async function publishNotebookAsNew(
  c: NotebookPublishCandidate,
  ctx: NotebookPublishContext
): Promise<NotebookPublishOutcome> {
  if (!c.reviewCopyId) return { kind: 'skipped', reason: 'no review copy recorded — stage it first' };

  // The original as it is now: its version, so the pointer write can be locked
  // to it, and its content, for the drift guard below.
  let origVersion: number | undefined;
  let origLabels: string[] = [];
  let origContent: unknown;
  try {
    const orig = await ctx.client.getDocumentFull(c.id, true);
    origVersion = orig.metadata.version;
    origLabels = orig.metadata.labels ?? [];
    origContent = typeof orig.content === 'string' ? JSON.parse(orig.content) : orig.content;
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

  // Already published? The LABELS say so, on the documents themselves. The
  // tracker cannot be trusted for this: on 2026-10-06 a stale save of the shared
  // workbook silently reverted the tool's 'published-new' rows, and trusting it
  // would republish — rewriting the pointer and bumping the version of every
  // owner's original on every run. So: record, write nothing, unless --republish.
  if (!ctx.republish && origLabels.includes(SUPERSEDED_LABEL) && (live.metadata.labels ?? []).includes(UPGRADED_LABEL)) {
    console.log(`  = ${c.name} — already published (both notebooks labelled); nothing written${ctx.apply ? ', tracker re-recorded' : ''}`);
    return ctx.apply ? { kind: 'published', row: publishedRow(c), recordedOnly: true } : { kind: 'prepared' };
  }
  // Drift guard. The review copy was built from the downloaded original; if the
  // owner has since added or changed sections, the new notebook would be
  // missing that work. Stored results don't count — running a query isn't an edit.
  if (!ctx.force) {
    const basePath = await findOriginal(ctx.outDir, 'notebook', c.id);
    if (!basePath) return { kind: 'skipped', reason: 'the staged original is not on disk, so owner edits since staging cannot be ruled out (--force to override)' };
    const bw = JSON.parse(await readFile(basePath, 'utf8')) as { content?: unknown };
    const staged = typeof bw.content === 'string' ? JSON.parse(bw.content) : bw.content;
    const drift = authoredChangesSince(staged as never, origContent as never);
    if (drift.length) {
      return {
        kind: 'skipped',
        reason: `DRIFT: the owner edited the original after it was staged (${drift.join(', ')}); the new notebook would be missing that work — restage it, or --force`,
      };
    }
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
    let accessPlan = '';
    try {
      const [target, current] = await Promise.all([
        ctx.client.getSharingState(c.id),
        ctx.client.getSharingState(c.reviewCopyId),
      ]);
      accessPlan = `would make it match the original — ${describePlan(planSharingMirror(target, current), target, current)}`;
    } catch (e) {
      accessPlan = `! could not read sharing to plan it (${errText(e)})`;
    }
    console.log(
      `  · ${c.name} → would publish copy ${c.reviewCopyId} as "${name}" (title kept), labelled ${UPGRADED_LABEL}` +
        `${leftover ? ` (! ${leftover} reference block(s) not stripped)` : ''}\n` +
        `      would add a pointer tile to the top of the original (v${origVersion}) and label it ${SUPERSEDED_LABEL}, changing nothing else\n` +
        `      ${accessPlan}`
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
      // Same write, so labelling costs no extra version. Merged: the API replaces the set.
      labels: mergeLabels(live.metadata.labels, [UPGRADED_LABEL]),
    });
  } catch (e) {
    return { kind: 'skipped', reason: `publish failed: ${errText(e)}` };
  }

  // The pointer on the ORIGINAL — the one change it gets. Non-fatal: the new
  // notebook is already published and correct whether or not this succeeds.
  const pointerNote = await addPointerToOriginal(c, origVersion, pointer, ctx);

  // Give the new notebook the original's owner and sharing. Last, because the
  // flags are owner-only and the transfer removes our own access.
  const accessNote = await mirrorOwnerAndSharing(c, c.reviewCopyId, ctx);

  let labelNote = '';
  try {
    const m = await ctx.client.getMetadata(c.reviewCopyId, true);
    labelNote = (m.labels ?? []).includes(UPGRADED_LABEL) ? `, labelled ${UPGRADED_LABEL}` : `, ! label ${UPGRADED_LABEL} NOT present`;
  } catch { /* the owner/sharing check below reports an unreadable copy */ }
  console.log(`  ✓ ${c.name} → published "${name}" (${c.reviewCopyId})${labelNote}\n      ${pointerNote}\n      ${accessNote}`);
  return {
    kind: 'published',
    row: publishedRow(c),
  };
}

/** The tracker row for a published notebook. */
function publishedRow(c: NotebookPublishCandidate): TrackerRow {
  return {
    asset_id: c.id,
    asset_type: 'notebook',
    name: c.name,
    status: PUBLISHED_NEW_STATUS,
    decision: PUBLISHED,
    promoted_at: new Date().toISOString(),
  };
}
