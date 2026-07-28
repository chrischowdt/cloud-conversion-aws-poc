/**
 * tracker-xlsx — the shared migration tracker, as a real .xlsx so it can live in
 * a SharePoint/OneDrive folder and be co-authored in O365.
 *
 * The tool owns the TOOL_COLUMNS (asset metadata, confidence, lane, status,
 * review-copy links, timestamps) and rewrites them on every `upsertRows`. The
 * HUMAN_COLUMNS (`decision`, `reviewer`, `notes`) are the reviewer's — the tool
 * READS them (`readDecisions`) but NEVER writes them, joining by `asset_id`.
 *
 * Caveat: this is a whole-file read-modify-write via exceljs, so it's
 * last-writer-wins if the tool saves while someone is live-editing. Run tool
 * updates when reviewers aren't mid-edit. (Graph Excel API is the conflict-free
 * upgrade if that ever bites.)
 *
 * Node-only (exceljs + fs) — not part of the App-portable core.
 */

import { existsSync } from 'node:fs';
import ExcelJS from 'exceljs';

export type AssetType = 'dashboard' | 'notebook';

/** Columns the tool owns and overwrites. `asset_id` is the join key. */
export const TOOL_COLUMNS = [
  { key: 'asset_id', header: 'asset_id', width: 40 },
  { key: 'asset_type', header: 'asset_type', width: 11 },
  { key: 'name', header: 'name', width: 44 },
  { key: 'owner', header: 'owner', width: 22 },
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

export interface TrackerRow {
  asset_id: string;
  asset_type: AssetType;
  name: string;
  owner?: string;
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
}

export interface Decision {
  decision: string;
  reviewer: string;
  notes: string;
}

const DEFAULT_SHEET = 'migration';

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

/** Write a human-facing "how to use this tracker" sheet (once). */
function ensureInstructions(wb: ExcelJS.Workbook): void {
  if (wb.getWorksheet('how-to')) return;
  const ws = wb.addWorksheet('how-to');
  ws.getColumn(1).width = 120;
  const lines: Array<[string] | string> = [
    'Migration tracker — how to use it (5-person team)',
    '',
    'WHAT THIS IS: one row per AWS dashboard/notebook we can migrate to the new Smartscape integration.',
    'The tooling owns the grey/left columns (asset info, confidence, lane, status, review-copy link, timestamps).',
    'YOU own four columns: assignee, decision, reviewer, notes. The tool reads `decision` and never overwrites yours.',
    '',
    'LANES (column "lane"):',
    '  fast    — clean rewrite AND live parity matched; safe to cut over directly after approval.',
    '  review  — has verify-me warnings or unmatched parity; needs a human to open the copy and fix/verify.',
    '  blocked — nothing auto-converted (manual rebuild); not staged.',
    '',
    'PRIORITY (column "priority"): high / medium / low by how often the dashboard is opened (90-day usage) — do high first.',
    '',
    'DIVIDE THE WORK: put your name in "assignee" for the rows you will review (split the review-lane rows across the 5 of you).',
    '',
    'REVIEW WORKFLOW (per assigned row):',
    '  1. Open the review copy — click the link in "review_copy_url" (it is a COPY named "… (migrated — review)"; the original is untouched).',
    '  2. Check the tiles render and the data looks right; fix anything wrong directly in that copy in the UI.',
    '  3. When it is correct, put your name in "reviewer", add any "notes", and set "decision" = approve.',
    '     If it cannot be migrated yet, set "decision" = reject and explain in "notes".',
    '',
    'PROMOTING (migration lead): for rows with decision=approve, the lead runs `cct migrate-pull` then `cct migrate-promote --apply`.',
    '  That updates the ORIGINAL dashboard in place (same URL) with the reviewed content — this is the go-live / "promote to the real dashboard" step.',
    '  Then `cct migrate-verify`; `cct migrate-rollback --ids <id> --apply` reverts if needed.',
    '',
    'STATUS values the tool sets: candidate → staged (copy published) → in-review (copy pulled) → promoted (cut over) → verified. (rolled-back if reverted.)',
    'Only edit assignee/decision/reviewer/notes. Save + close when done so the tool can read your decisions.',
  ];
  lines.forEach((l, i) => {
    const cell = ws.getRow(i + 1).getCell(1);
    cell.value = Array.isArray(l) ? l[0] : l;
    if (i === 0) cell.font = { bold: true, size: 14 };
    if (/^[A-Z][A-Z ]+:/.test(String(cell.value)) || /WORKFLOW|DIVIDE|PROMOTING/.test(String(cell.value))) cell.font = { bold: true };
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
      if (!TOOL_KEYS.has(key as (typeof TOOL_COLUMNS)[number]['key'])) continue; // never touch human cols
      if (val === undefined) continue;
      const col = header.get(key);
      if (col) row.getCell(col).value = val as ExcelJS.CellValue;
    }
    row.commit();
  }

  await wb.xlsx.writeFile(path);
  return { updated, added };
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
