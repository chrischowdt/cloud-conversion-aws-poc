import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm, mkdtemp } from 'node:fs/promises';

import ExcelJS from 'exceljs';
import { upsertRows, readDecisions, cellStr, type TrackerRow } from './tracker-xlsx.ts';

let dir: string;
let path: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tracker-test-'));
  path = join(dir, 'tracker.xlsx');
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const row = (id: string, over: Partial<TrackerRow> = {}): TrackerRow => ({
  asset_id: id,
  asset_type: 'dashboard',
  name: `Dash ${id}`,
  status: 'candidate',
  confidence: 'medium',
  lane: 'review',
  ...over,
});

describe('tracker-xlsx round-trip', () => {
  it('creates the file and appends rows', async () => {
    const r = await upsertRows(path, [row('a'), row('b')]);
    assert.equal(r.added, 2);
    assert.equal(r.updated, 0);
  });

  it('preserves human columns across a tool upsert, and updates tool columns', async () => {
    // Simulate a reviewer editing decision/reviewer/notes on asset "a".
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const ws = wb.getWorksheet('migration')!;
    const header = new Map<string, number>();
    ws.getRow(1).eachCell((c, col) => header.set(cellStr(c.value), col));
    // find asset "a" row
    let aRow = -1;
    ws.eachRow((rw, n) => {
      if (n > 1 && cellStr(rw.getCell(header.get('asset_id')!).value) === 'a') aRow = n;
    });
    assert.ok(aRow > 1);
    ws.getRow(aRow).getCell(header.get('decision')!).value = 'approve';
    ws.getRow(aRow).getCell(header.get('reviewer')!).value = 'chris';
    ws.getRow(aRow).getCell(header.get('notes')!).value = 'looks good';
    await wb.xlsx.writeFile(path);

    // Tool re-upserts asset "a" (new status) and adds "c".
    const res = await upsertRows(path, [row('a', { status: 'promoted' }), row('c')]);
    assert.equal(res.updated, 1); // a
    assert.equal(res.added, 1); // c

    // Human columns survived; tool column changed.
    const decisions = await readDecisions(path);
    assert.equal(decisions.get('a')?.decision, 'approve');
    assert.equal(decisions.get('a')?.reviewer, 'chris');
    assert.equal(decisions.get('a')?.notes, 'looks good');

    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.readFile(path);
    const ws2 = wb2.getWorksheet('migration')!;
    const h2 = new Map<string, number>();
    ws2.getRow(1).eachCell((c, col) => h2.set(cellStr(c.value), col));
    let statusA = '';
    ws2.eachRow((rw, n) => {
      if (n > 1 && cellStr(rw.getCell(h2.get('asset_id')!).value) === 'a') {
        statusA = cellStr(rw.getCell(h2.get('status')!).value);
      }
    });
    assert.equal(statusA, 'promoted');
  });

  it('readDecisions returns empty for a missing file', async () => {
    const d = await readDecisions(join(dir, 'nope.xlsx'));
    assert.equal(d.size, 0);
  });
});
