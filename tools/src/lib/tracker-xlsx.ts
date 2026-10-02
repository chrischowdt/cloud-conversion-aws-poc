/**
 * tracker-xlsx — the shared migration tracker, as a real .xlsx so it can live in
 * a SharePoint/OneDrive folder and be co-authored in O365.
 *
 * The tool owns the TOOL_COLUMNS (asset metadata, confidence, lane, status,
 * review-copy links, timestamps) and rewrites them on every `upsertRows`. The
 * HUMAN_COLUMNS (`decision`, `reviewer`, `notes`) are the reviewer's — the tool
 * READS them (`readDecisions`) and joins by `asset_id`. The ONE exception: the
 * automation stamps `decision = "Published"` on rows it has just cut over (that
 * lifecycle transition is the tool's to record); it never touches any other
 * decision value a human set.
 *
 * Caveat: this is a whole-file read-modify-write via exceljs, so it's
 * last-writer-wins if the tool saves while someone is live-editing. Run tool
 * updates when reviewers aren't mid-edit. (Graph Excel API is the conflict-free
 * upgrade if that ever bites.)
 *
 * Node-only (exceljs + fs) — not part of the App-portable core.
 */

import { existsSync, copyFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { dirname, basename, join as joinPath } from 'node:path';
import ExcelJS from 'exceljs';

export type AssetType = 'dashboard' | 'notebook';

// The shared review vocabulary lives in decision-states.ts so the tracker and
// the in-product review notebooks use ONE set of words. Re-exported here because
// this module is where callers have always imported it from.
export {
  DECISION_STATES,
  READY_TO_PUBLISH,
  PUBLISHED,
  isReadyToPublish,
  isPublished,
  type DecisionState,
} from './decision-states.ts';
import { DECISION_STATES } from './decision-states.ts';

/** Columns the tool owns and overwrites. `asset_id` is the join key. */
export const TOOL_COLUMNS = [
  { key: 'asset_id', header: 'asset_id', width: 40 },
  { key: 'asset_type', header: 'asset_type', width: 11 },
  { key: 'name', header: 'name', width: 44 },
  { key: 'asset_url', header: 'asset_url', width: 48 },
  { key: 'owner', header: 'owner', width: 22 },
  { key: 'owner_email', header: 'owner_email', width: 32 },
  { key: 'access_count', header: 'access_count', width: 12 },
  { key: 'last_accessed', header: 'last_accessed', width: 22 },
  { key: 'scan_clean', header: 'scan_clean', width: 10 },
  { key: 'scan_soft', header: 'scan_soft', width: 10 },
  { key: 'scan_blocked', header: 'scan_blocked', width: 12 },
  { key: 'parity', header: 'parity', width: 14 },
  { key: 'confidence', header: 'confidence', width: 11 },
  { key: 'lane', header: 'lane', width: 8 },
  { key: 'priority', header: 'priority', width: 9 },
  { key: 'status', header: 'status', width: 12 },
  { key: 'reasons', header: 'reasons', width: 48 },
  { key: 'review_copy_id', header: 'review_copy_id', width: 40 },
  { key: 'review_copy_url', header: 'review_copy_url', width: 48 },
  { key: 'based_on_version', header: 'based_on_version', width: 16 },
  { key: 'pre_promote_version', header: 'pre_promote_version', width: 18 },
  { key: 'staged_at', header: 'staged_at', width: 22 },
  { key: 'promoted_at', header: 'promoted_at', width: 22 },
  { key: 'verified_at', header: 'verified_at', width: 22 },
  { key: 'tool_updated', header: 'tool_updated', width: 22 },
] as const;

/** Columns the reviewer owns. The tool reads `decision` but never writes any of these. */
export const HUMAN_COLUMNS = [
  { key: 'assignee', header: 'assignee', width: 20 },
  { key: 'decision', header: 'decision', width: 12 },
  { key: 'reviewer', header: 'reviewer', width: 22 },
  { key: 'notes', header: 'notes', width: 60 },
] as const;

const ALL_COLUMNS = [...TOOL_COLUMNS, ...HUMAN_COLUMNS];
const TOOL_KEYS = new Set(TOOL_COLUMNS.map((c) => c.key));

/**
 * What the TRACKER can hold. Wider than `AssetType`, which is deliberately the
 * document types only (`doc-apply` builds Document API payloads and a Davis
 * anomaly detector is a Settings 2.0 object, never a document). Alerts are
 * tracked for status but never travel the stage/promote pipeline.
 */
export type TrackedAssetType = AssetType | 'anomaly-detector';

export interface TrackerRow {
  asset_id: string;
  asset_type: TrackedAssetType;
  name: string;
  /**
   * Deep link to the LIVE asset. Written as a plain URL string — Excel turns it
   * into a clickable link on its own, which is enough here and keeps the sheet
   * free of hyperlink objects that complicate reading it back.
   */
  asset_url?: string;
  owner?: string;
  /**
   * The owner as a person. Resolved from the user UUID via `discover-users`;
   * absent when that user has not run a query in the window, in which case the
   * raw id in `owner` is still there.
   */
  owner_email?: string;
  access_count?: number;
  last_accessed?: string;
  scan_clean?: number;
  scan_soft?: number;
  scan_blocked?: number;
  parity?: string;
  confidence?: string;
  lane?: string;
  priority?: string;
  status?: string;
  reasons?: string;
  review_copy_id?: string;
  review_copy_url?: string;
  based_on_version?: number;
  pre_promote_version?: number;
  staged_at?: string;
  promoted_at?: string;
  verified_at?: string;
  tool_updated?: string;
  /**
   * Human column, normally reviewer-owned. The automation MAY set this to
   * `Published` after a cutover (see module header); no other tool path sets it.
   */
  decision?: string;
}

export interface Decision {
  decision: string;
  reviewer: string;
  notes: string;
}

/**
 * The team keeps ONE workbook with a sheet per asset family:
 *   `migration` — dashboards + notebooks, which travel the stage/promote pipeline
 *   `alerts`    — Davis anomaly detectors, which do not (a detector is a Settings
 *                 object, so there is no inert copy to stage; see refresh-alert-tracker)
 * They are separate sheets because the two have different lifecycles and the
 * review teams differ, but they share one file so a reviewer opens one thing.
 */
export const MIGRATION_SHEET = 'migration';
export const ALERTS_SHEET = 'alerts';
const DEFAULT_SHEET = MIGRATION_SHEET;

/** The sheet an asset type belongs on. */
export function sheetForAssetType(type: TrackedAssetType): string {
  return type === 'anomaly-detector' ? ALERTS_SHEET : MIGRATION_SHEET;
}

/**
 * Snapshot the tracker before the first write of this process.
 *
 * Every mutating helper here rewrites the WHOLE workbook, and the file usually
 * lives in a synced folder that reviewers also have open — so a bad run, or a
 * run that races a reviewer's save, can only be undone if a copy exists. A
 * refresh performs several writes in a row; we snapshot once, before the first,
 * so the backup is the state we started from rather than a half-updated file.
 *
 * Keeps the newest BACKUPS_KEPT snapshots and prunes the rest, so a folder that
 * people actually browse does not fill up with them.
 */
const BACKUPS_KEPT = 5;
const backedUpThisRun = new Set<string>();

export function snapshotTracker(path: string): string | undefined {
  if (!existsSync(path) || backedUpThisRun.has(path)) return undefined;
  backedUpThisRun.add(path);
  const dir = dirname(path);
  const base = basename(path).replace(/\.xlsx$/i, '');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = joinPath(dir, `${base}.autobackup-${stamp}.xlsx`);
  try {
    copyFileSync(path, dest);
  } catch {
    return undefined; // a backup must never block the actual work
  }
  try {
    const mine = readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.autobackup-`) && f.endsWith('.xlsx'))
      .map((f) => ({ f, t: statSync(joinPath(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const old of mine.slice(BACKUPS_KEPT)) unlinkSync(joinPath(dir, old.f));
  } catch {
    /* pruning is best-effort */
  }
  return dest;
}

/** Coerce any exceljs cell value to a plain string. */
export function cellStr(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  const o = v as unknown as Record<string, unknown>;
  if (typeof o['text'] === 'string') return o['text'] as string; // hyperlink
  if (Array.isArray(o['richText'])) return (o['richText'] as Array<{ text?: string }>).map((r) => r.text ?? '').join('');
  if ('result' in o) return String(o['result'] ?? ''); // formula
  return '';
}

/** header name → 1-based column number, from row 1. */
function headerIndex(ws: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  const row = ws.getRow(1);
  row.eachCell((cell, col) => {
    const h = cellStr(cell.value).trim();
    if (h) map.set(h, col);
  });
  return map;
}

function initHeader(ws: ExcelJS.Worksheet): Map<string, number> {
  const map = new Map<string, number>();
  ALL_COLUMNS.forEach((c, i) => {
    const col = i + 1;
    const cell = ws.getRow(1).getCell(col);
    cell.value = c.header;
    ws.getColumn(col).width = c.width;
    map.set(c.header, col);
  });
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return map;
}

/** (Re)write the human-facing "how to use this tracker" sheet to match the code. */
function ensureInstructions(wb: ExcelJS.Workbook): void {
  const ws = wb.getWorksheet('how-to') ?? wb.addWorksheet('how-to');
  ws.spliceRows(1, ws.rowCount); // clear stale guidance, then rewrite
  ws.getColumn(1).width = 120;
  const lines: Array<[string] | string> = [
    'Migration tracker — how to use it (5-person team)',
    '',
    'WHAT THIS IS: the AWS assets we are migrating to the new Smartscape integration, one row each.',
    '  SHEET "migration" — dashboards + notebooks. These are staged as a review COPY, then cut over in place.',
    '  SHEET "alerts"    — Davis anomaly detectors. A detector is a settings object, not a document, so there is',
    '                      no inert copy to stage: the converted queries go into a review NOTEBOOK (batches of 25),',
    '                      and "review_copy_url" on each row points at the batch notebook holding that alert.',
    '                      Everything else — assignee / decision / reviewer / notes — works exactly the same.',
    'The tooling owns the grey/left columns (asset info, confidence, lane, status, review-copy link, timestamps).',
    'YOU own: assignee, decision, reviewer, notes. The tool reads "decision"; the only value it WRITES is "Published" (after it cuts a row over).',
    '',
    'LANES (column "lane"):',
    '  fast    — clean rewrite AND live parity matched; safe to cut over directly.',
    '  review  — has verify-me warnings or unmatched parity; needs a human to open the copy and fix/verify.',
    '  blocked — nothing auto-converted (manual rebuild); not staged.',
    '',
    'PRIORITY (column "priority"): high / medium / low by how often the dashboard is opened (90-day usage) — do high first.',
    '',
    'DIVIDE THE WORK: put your name in "assignee" for the rows you will review (split the review-lane rows across the 5 of you).',
    '',
    'DECISION (column V) — pick one from the dropdown:',
    '  Descope          — exclude this dashboard from any automated conversion (whatever the reason).',
    '  Needs Review     — has a conversion blocker; not ready.',
    '  In Progress      — you are actively reviewing it right now (tells the team it is taken).',
    '  Ready To Publish — reviewed + correct; the automation MAY cut the review copy over the original.',
    '  Published        — set BY the automation after it has cut the row over. Do not set this yourself.',
    '',
    'REVIEW WORKFLOW (per assigned row):',
    '  1. Set decision = In Progress so others know it is taken.',
    '  2. Open the review copy — click "review_copy_url" (a COPY named "[MIGRATION REVIEW] …"; the original is untouched).',
    '     To compare against the live original side by side, click "asset_url" — that is the dashboard as it is today.',
    '     Each converted tile shows the ORIGINAL classic query as a // comment above the migrated one, for reference.',
    '  3. Check the tiles render and the data looks right; fix anything wrong directly in that copy in the UI.',
    '  4. When correct, put your name in "reviewer", add any "notes", and set decision = Ready To Publish.',
    '     If it cannot be migrated yet, set decision = Needs Review (or Descope) and explain in "notes".',
    '',
    'PUBLISHING (migration lead): for rows with decision = Ready To Publish, run `cct migrate-pull` then `cct migrate-promote --apply`',
    '  (pass --tracker "<this file>"). That updates the ORIGINAL dashboard in place (same URL) with the reviewed content —',
    '  the go-live step — then stamps decision = Published. `cct migrate-verify`; `cct migrate-rollback --ids <id> --apply` reverts.',
    '',
    'STATUS values the tool sets (column M): candidate → staged (copy published) → in-review (copy pulled) → promoted (cut over) → verified.',
    'Only edit assignee / decision / reviewer / notes. Save + close when done so the tool can read your decisions.',
  ];
  lines.forEach((l, i) => {
    const cell = ws.getRow(i + 1).getCell(1);
    cell.value = Array.isArray(l) ? l[0] : l;
    if (i === 0) cell.font = { bold: true, size: 14 };
    if (/^[A-Z][A-Z ]+ ?\(|^[A-Z][A-Z ]+:/.test(String(cell.value)) || /WORKFLOW|DIVIDE|PUBLISHING/.test(String(cell.value))) cell.font = { bold: true };
  });
}

/**
 * Insert/update tool-owned data for each row, joined by asset_id. Existing rows
 * keep their human columns untouched; new asset_ids are appended. Creates the
 * workbook/sheet if absent.
 */
export async function upsertRows(
  path: string,
  rows: TrackerRow[],
  sheetName = DEFAULT_SHEET
): Promise<{ updated: number; added: number }> {
  const wb = new ExcelJS.Workbook();
  if (existsSync(path)) await wb.xlsx.readFile(path);
  let ws = wb.getWorksheet(sheetName);
  let header: Map<string, number>;
  if (!ws) {
    ws = wb.addWorksheet(sheetName);
    header = initHeader(ws);
  } else {
    header = headerIndex(ws);
    // Add any tool columns missing from an existing sheet (schema evolution).
    for (const c of ALL_COLUMNS) {
      if (!header.has(c.header)) {
        const col = header.size + 1;
        ws.getRow(1).getCell(col).value = c.header;
        ws.getColumn(col).width = c.width;
        header.set(c.header, col);
      }
    }
  }

  ensureInstructions(wb);

  // One workbook, two sheets: refuse to write a row onto the wrong one. Mixing
  // 990 detector rows into the dashboards sheet (or vice versa) is tedious to
  // undo by hand in a file the team has open, so fail loudly instead.
  const misplaced = rows.filter((r) => r.asset_type && sheetForAssetType(r.asset_type) !== sheetName);
  if (misplaced.length) {
    const kinds = [...new Set(misplaced.map((r) => r.asset_type))].join(', ');
    throw new Error(
      `upsertRows: refusing to write ${misplaced.length} ${kinds} row(s) to sheet "${sheetName}" — ` +
        `they belong on "${sheetForAssetType(misplaced[0]!.asset_type)}". Pass the right sheet name.`
    );
  }

  const idCol = header.get('asset_id')!;
  const idToRow = new Map<string, number>();
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const id = cellStr(row.getCell(idCol).value).trim();
    if (id) idToRow.set(id, n);
  });

  let updated = 0;
  let added = 0;
  const stamp = new Date().toISOString();
  for (const r of rows) {
    const withStamp = { ...r, tool_updated: r.tool_updated ?? stamp } as Record<string, unknown>;
    let rowNum = idToRow.get(r.asset_id);
    if (rowNum === undefined) {
      rowNum = ws.rowCount + 1;
      idToRow.set(r.asset_id, rowNum);
      added++;
    } else {
      updated++;
    }
    const row = ws.getRow(rowNum);
    for (const [key, val] of Object.entries(withStamp)) {
      // Tool columns are always writable; `decision` is writable ONLY so the
      // automation can stamp its lifecycle value (Published). No other human col.
      if (!TOOL_KEYS.has(key as (typeof TOOL_COLUMNS)[number]['key']) && key !== 'decision') continue;
      if (val === undefined) continue;
      const col = header.get(key);
      if (col) row.getCell(col).value = val as ExcelJS.CellValue;
    }
    row.commit();
  }

  applyDecisionDropdown(ws, header);
  snapshotTracker(path);
  await wb.xlsx.writeFile(path);
  return { updated, added };
}

/**
 * Attach a data-validation dropdown of DECISION_STATES to every data row's
 * `decision` cell, so the whole team picks from the same list. Idempotent.
 */
function applyDecisionDropdown(ws: ExcelJS.Worksheet, header: Map<string, number>): void {
  const col = header.get('decision');
  if (!col) return;
  const formulae = [`"${DECISION_STATES.join(',')}"`];
  const last = Math.max(ws.rowCount, 2);
  for (let r = 2; r <= last; r++) {
    ws.getCell(r, col).dataValidation = {
      type: 'list',
      allowBlank: true,
      formulae,
      showErrorMessage: true,
      errorStyle: 'warning',
      error: 'Pick one of: ' + DECISION_STATES.join(', '),
      errorTitle: 'Migration decision',
    };
  }
}

/** asset_ids already present in the tracker (so a refresh won't reset status). */
export async function readExistingIds(path: string, sheetName = DEFAULT_SHEET): Promise<Set<string>> {
  const out = new Set<string>();
  if (!existsSync(path)) return out;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return out;
  const idCol = headerIndex(ws).get('asset_id');
  if (!idCol) return out;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const id = cellStr(row.getCell(idCol).value).trim();
    if (id) out.add(id);
  });
  return out;
}

/** Read every row's cells as strings, keyed by asset_id (all columns). */
export async function readRows(
  path: string,
  sheetName = DEFAULT_SHEET
): Promise<Map<string, Record<string, string>>> {
  const out = new Map<string, Record<string, string>>();
  if (!existsSync(path)) return out;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return out;
  const header = headerIndex(ws);
  const idCol = header.get('asset_id');
  if (!idCol) return out;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const id = cellStr(row.getCell(idCol).value).trim();
    if (!id) return;
    const rec: Record<string, string> = {};
    for (const [name, col] of header) rec[name] = cellStr(row.getCell(col).value).trim();
    out.set(id, rec);
  });
  return out;
}

/** Read the human decision columns, keyed by asset_id. Empty map if no file. */
export async function readDecisions(path: string, sheetName = DEFAULT_SHEET): Promise<Map<string, Decision>> {
  const out = new Map<string, Decision>();
  if (!existsSync(path)) return out;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return out;
  const header = headerIndex(ws);
  const idCol = header.get('asset_id');
  if (!idCol) return out;
  const dCol = header.get('decision');
  const rCol = header.get('reviewer');
  const nCol = header.get('notes');
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const id = cellStr(row.getCell(idCol).value).trim();
    if (!id) return;
    out.set(id, {
      decision: dCol ? cellStr(row.getCell(dCol).value).trim().toLowerCase() : '',
      reviewer: rCol ? cellStr(row.getCell(rCol).value).trim() : '',
      notes: nCol ? cellStr(row.getCell(nCol).value).trim() : '',
    });
  });
  return out;
}

/**
 * Remove rows for assets that are OUR OWN review copies.
 *
 * The copies this pipeline publishes are real documents in the tenant, so a
 * download picks them up and earlier refreshes enrolled them as migration
 * candidates — 74 of them on this tenant. They are not assets anyone needs to
 * migrate (the originals are tracked under their own ids), and leaving them in
 * invites staging a review copy OF a review copy.
 *
 * Deliberately refuses to delete a row carrying human input. If a reviewer has
 * put a decision, note, or their name on one, that is a signal we do not
 * understand the row — losing their work to a cleanup would be far worse than
 * leaving one stray row, so we keep it and report it.
 */
export async function pruneReviewCopyRows(
  path: string,
  prefix: string,
  sheetName = DEFAULT_SHEET
): Promise<{ removed: number; keptWithHumanInput: string[] }> {
  if (!existsSync(path)) return { removed: 0, keptWithHumanInput: [] };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return { removed: 0, keptWithHumanInput: [] };
  const header = headerIndex(ws);
  const nameCol = header.get('name');
  if (!nameCol) return { removed: 0, keptWithHumanInput: [] };
  const humanCols = HUMAN_COLUMNS.map((c) => header.get(c.header)).filter((n): n is number => !!n);

  const doomed: number[] = [];
  const kept: string[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const name = cellStr(row.getCell(nameCol).value);
    if (!name.startsWith(prefix)) return;
    const hasHuman = humanCols.some((c) => cellStr(row.getCell(c).value).trim().length > 0);
    if (hasHuman) kept.push(name);
    else doomed.push(n);
  });

  // Splice from the bottom so earlier row numbers stay valid.
  for (const n of doomed.sort((a, b) => b - a)) ws.spliceRows(n, 1);
  if (doomed.length) { snapshotTracker(path); await wb.xlsx.writeFile(path); }
  return { removed: doomed.length, keptWithHumanInput: kept };
}

/** Workflow states that mean real work is in flight — never pruned. */
const IN_FLIGHT_STATUSES = new Set(['staged', 'in-review', 'promoted', 'verified']);

/**
 * Remove rows for assets that are no longer in scope — e.g. after narrowing the
 * download to "opened in the last N days", so the sheet tracks the assets the
 * team actually has to migrate rather than everything that has ever existed.
 *
 * `upsertRows` only ever adds or updates, so without this a narrowed scan just
 * leaves the old rows sitting there and the sheet never shrinks.
 *
 * Three things are never pruned, whatever the scope says:
 *   - rows carrying human input (assignee / decision / reviewer / notes)
 *   - rows with work in flight (staged, in-review, promoted, verified)
 * Losing either to a scope change would destroy work that scope has no opinion
 * about. Everything kept for those reasons is reported so it stays visible.
 */
export async function pruneRowsNotInScope(
  path: string,
  keepIds: Set<string>,
  sheetName = DEFAULT_SHEET
): Promise<{ removed: number; keptHuman: number; keptInFlight: number }> {
  if (!existsSync(path)) return { removed: 0, keptHuman: 0, keptInFlight: 0 };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return { removed: 0, keptHuman: 0, keptInFlight: 0 };
  const header = headerIndex(ws);
  const idCol = header.get('asset_id');
  const statusCol = header.get('status');
  if (!idCol) return { removed: 0, keptHuman: 0, keptInFlight: 0 };
  const humanCols = HUMAN_COLUMNS.map((c) => header.get(c.header)).filter((n): n is number => !!n);

  const doomed: number[] = [];
  let keptHuman = 0, keptInFlight = 0;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const id = cellStr(row.getCell(idCol).value).trim();
    if (!id || keepIds.has(id)) return;
    if (humanCols.some((c) => cellStr(row.getCell(c).value).trim().length > 0)) { keptHuman++; return; }
    const status = statusCol ? cellStr(row.getCell(statusCol).value).trim().toLowerCase() : '';
    if (IN_FLIGHT_STATUSES.has(status)) { keptInFlight++; return; }
    doomed.push(n);
  });

  for (const n of doomed.sort((a, b) => b - a)) ws.spliceRows(n, 1);
  if (doomed.length) { snapshotTracker(path); await wb.xlsx.writeFile(path); }
  return { removed: doomed.length, keptHuman, keptInFlight };
}

/**
 * Fill `asset_url` on any row that lacks one, deriving it from the row's own
 * asset_id + asset_type.
 *
 * A refresh only writes rows it just scanned, so rows kept for other reasons —
 * out-of-scope rows carrying human input, anything already published — would
 * otherwise be the only ones in the sheet without a working link, which is
 * exactly backwards: those are the rows people most want to open.
 */
export async function backfillAssetUrls(
  path: string,
  baseUrl: string,
  sheetName = DEFAULT_SHEET
): Promise<number> {
  if (!existsSync(path) || !baseUrl) return 0;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return 0;
  const header = headerIndex(ws);
  const idCol = header.get('asset_id');
  const typeCol = header.get('asset_type');
  const urlCol = header.get('asset_url');
  if (!idCol || !urlCol) return 0;

  const root = baseUrl.replace(/\/+$/, '');
  let filled = 0;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const id = cellStr(row.getCell(idCol).value).trim();
    if (!id || cellStr(row.getCell(urlCol).value).trim()) return;
    const type = typeCol ? cellStr(row.getCell(typeCol).value).trim() : 'dashboard';
    const app = type === 'notebook' ? 'dynatrace.notebooks/notebook' : 'dynatrace.dashboards/dashboard';
    row.getCell(urlCol).value = `${root}/ui/apps/${app}/${id}`;
    filled++;
  });
  if (filled) { snapshotTracker(path); await wb.xlsx.writeFile(path); }
  return filled;
}

/**
 * Fill `owner_email` on any row that has an owner id but no email yet.
 *
 * Same reason as the asset_url backfill: a refresh only writes rows it just
 * scanned, so rows kept for other reasons (out-of-scope-with-human-input,
 * already published) would keep showing a bare UUID. Rows whose owner isn't in
 * the index are left alone — the raw id stays, which is more useful than blank.
 */
export async function backfillOwnerEmails(
  path: string,
  users: Map<string, string>,
  sheetName = DEFAULT_SHEET
): Promise<number> {
  if (!existsSync(path) || users.size === 0) return 0;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const ws = wb.getWorksheet(sheetName);
  if (!ws) return 0;
  const header = headerIndex(ws);
  const ownerCol = header.get('owner');
  const emailCol = header.get('owner_email');
  if (!ownerCol || !emailCol) return 0;

  let filled = 0;
  ws.eachRow((row, n) => {
    if (n === 1) return;
    if (cellStr(row.getCell(emailCol).value).trim()) return;
    const owner = cellStr(row.getCell(ownerCol).value).trim();
    const email = owner ? users.get(owner) : undefined;
    if (!email) return;
    row.getCell(emailCol).value = email;
    filled++;
  });
  if (filled) { snapshotTracker(path); await wb.xlsx.writeFile(path); }
  return filled;
}
