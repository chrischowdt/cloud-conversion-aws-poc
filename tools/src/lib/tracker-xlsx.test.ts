import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readdir } from 'node:fs/promises';
import { rm, mkdtemp } from 'node:fs/promises';

import ExcelJS from 'exceljs';
import { upsertRows, readDecisions, cellStr, isReadyToPublish, isPublished, PUBLISHED, pruneRowsNotInScope, pruneReviewCopyRows, readRows, type TrackerRow, snapshotTracker } from './tracker-xlsx.ts';

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
    ws.getRow(aRow).getCell(header.get('decision')!).value = 'In Progress';
    ws.getRow(aRow).getCell(header.get('reviewer')!).value = 'chris';
    ws.getRow(aRow).getCell(header.get('notes')!).value = 'looks good';
    await wb.xlsx.writeFile(path);

    // Tool re-upserts asset "a" (new status) and adds "c". No decision passed,
    // so the human's decision must survive untouched.
    const res = await upsertRows(path, [row('a', { status: 'promoted' }), row('c')]);
    assert.equal(res.updated, 1); // a
    assert.equal(res.added, 1); // c

    // Human columns survived; tool column changed.
    const decisions = await readDecisions(path);
    assert.equal(decisions.get('a')?.decision, 'in progress'); // readDecisions lowercases
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

  it('lets the automation stamp decision=Published (the one human col it may write)', async () => {
    // asset "c" starts with a human "Ready To Publish" decision.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const ws = wb.getWorksheet('migration')!;
    const header = new Map<string, number>();
    ws.getRow(1).eachCell((c, col) => header.set(cellStr(c.value), col));
    let cRow = -1;
    ws.eachRow((rw, n) => {
      if (n > 1 && cellStr(rw.getCell(header.get('asset_id')!).value) === 'c') cRow = n;
    });
    ws.getRow(cRow).getCell(header.get('decision')!).value = 'Ready To Publish';
    await wb.xlsx.writeFile(path);

    await upsertRows(path, [row('c', { status: 'promoted', decision: PUBLISHED })]);
    const decisions = await readDecisions(path);
    assert.equal(decisions.get('c')?.decision, 'published'); // lowercased on read
  });
});

describe('decision helpers', () => {
  it('isReadyToPublish is case/space tolerant', () => {
    assert.ok(isReadyToPublish('Ready To Publish'));
    assert.ok(isReadyToPublish('  ready to publish '));
    assert.ok(!isReadyToPublish('Published'));
    assert.ok(!isReadyToPublish('approve'));
    assert.ok(!isReadyToPublish(undefined));
  });
  it('isPublished is case tolerant', () => {
    assert.ok(isPublished('Published'));
    assert.ok(isPublished('published'));
    assert.ok(!isPublished('Ready To Publish'));
  });
});

describe('pruneRowsNotInScope — narrowing scope must not destroy work', () => {
  it('removes untouched candidate rows that fell out of scope', async () => {
    const p = join(dir, 'scope.xlsx');
    await upsertRows(p, [row('keep-1'), row('drop-1'), row('drop-2')]);
    const r = await pruneRowsNotInScope(p, new Set(['keep-1']));
    assert.equal(r.removed, 2);
    const left = await readRows(p);
    assert.deepEqual([...left.keys()].sort(), ['keep-1']);
  });

  it('NEVER removes a row carrying human input, even out of scope', async () => {
    const p = join(dir, 'scope-human.xlsx');
    await upsertRows(p, [row('a'), row('b')]);
    // simulate a reviewer claiming row b
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(p);
    const ws = wb.getWorksheet('migration')!;
    const hdr = new Map<string, number>();
    ws.getRow(1).eachCell((c, i) => hdr.set(cellStr(c.value), i));
    ws.getRow(3).getCell(hdr.get('reviewer')!).value = 'Alex';
    await wb.xlsx.writeFile(p);

    const r = await pruneRowsNotInScope(p, new Set<string>()); // nothing in scope
    assert.equal(r.keptHuman, 1);
    assert.equal(r.removed, 1);
    const left = await readRows(p);
    assert.ok(left.has('b'), 'the reviewed row must survive a scope change');
  });

  it('NEVER removes a row with work in flight', async () => {
    const p = join(dir, 'scope-inflight.xlsx');
    await upsertRows(p, [row('staged-1', { status: 'staged' }), row('verified-1', { status: 'verified' }), row('cand-1')]);
    const r = await pruneRowsNotInScope(p, new Set<string>());
    assert.equal(r.keptInFlight, 2);
    assert.equal(r.removed, 1);
    const left = await readRows(p);
    assert.deepEqual([...left.keys()].sort(), ['staged-1', 'verified-1']);
  });
});

describe('pruneReviewCopyRows', () => {
  it('removes our own review copies but keeps any a human annotated', async () => {
    const p = join(dir, 'copies.xlsx');
    await upsertRows(p, [
      row('orig-1'),
      row('copy-1', { name: '[MIGRATION REVIEW] Dash A' }),
      row('copy-2', { name: '[MIGRATION REVIEW] Dash B' }),
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(p);
    const ws = wb.getWorksheet('migration')!;
    const hdr = new Map<string, number>();
    ws.getRow(1).eachCell((c, i) => hdr.set(cellStr(c.value), i));
    ws.getRow(4).getCell(hdr.get('notes')!).value = 'checked this one';
    await wb.xlsx.writeFile(p);

    const r = await pruneReviewCopyRows(p, '[MIGRATION REVIEW] ');
    assert.equal(r.removed, 1);
    assert.equal(r.keptWithHumanInput.length, 1);
    const left = await readRows(p);
    assert.ok(left.has('orig-1'));
    assert.ok(left.has('copy-2'), 'annotated copy is kept and reported');
  });
});

describe('asset_url', () => {
  it('is written as a plain URL so Excel auto-links it', async () => {
    const p = join(dir, 'asseturl.xlsx');
    const url = 'https://nic55601.apps.dynatrace.com/ui/apps/dynatrace.dashboards/dashboard/abc';
    await upsertRows(p, [row('abc', { asset_url: url })]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(p);
    const ws = wb.getWorksheet('migration')!;
    const hdr = new Map<string, number>();
    ws.getRow(1).eachCell((c, i) => hdr.set(cellStr(c.value), i));
    const cell = ws.getRow(2).getCell(hdr.get('asset_url')!).value;
    assert.equal(typeof cell, 'string', 'plain string, not a hyperlink object');
    assert.equal(cell, url);
  });

  it('survives a refresh round-trip alongside human columns', async () => {
    const p = join(dir, 'asseturl2.xlsx');
    await upsertRows(p, [row('x', { asset_url: 'https://t/ui/apps/d/x' })]);
    await upsertRows(p, [row('x', { asset_url: 'https://t/ui/apps/d/x', status: 'staged' })]);
    const back = await readRows(p);
    assert.equal(back.get('x')!['asset_url'], 'https://t/ui/apps/d/x');
    assert.equal(back.get('x')!['status'], 'staged');
  });
});

describe('owner_email', () => {
  it('is stored alongside the raw owner id, not instead of it', async () => {
    const p = join(dir, 'owner.xlsx');
    await upsertRows(p, [row('a', { owner: 'uuid-1', owner_email: 'someone@united.com' })]);
    const back = await readRows(p);
    assert.equal(back.get('a')!['owner'], 'uuid-1', 'raw id stays for traceability');
    assert.equal(back.get('a')!['owner_email'], 'someone@united.com');
  });

  it('leaves owner_email empty when the user is unknown, keeping the id', async () => {
    const p = join(dir, 'owner2.xlsx');
    await upsertRows(p, [row('b', { owner: 'uuid-unknown' })]);
    const back = await readRows(p);
    assert.equal(back.get('b')!['owner'], 'uuid-unknown');
    assert.ok(!back.get('b')!['owner_email']);
  });
});

describe('status re-evaluation (blocked <-> candidate only)', () => {
  it('leaves status untouched when the refresh omits it — how in-flight rows are protected', async () => {
    // migrate-refresh decides WHETHER to send a status: only for new rows, or
    // when an existing row is still blocked/candidate. For anything in flight it
    // sends nothing, and upsertRows must then leave the cell alone — that is
    // what keeps real workflow progress from being rewound.
    const p = join(dir, 'restatus.xlsx');
    await upsertRows(p, [row('in-flight', { status: 'staged' }), row('was-blocked', { status: 'blocked' })]);
    await upsertRows(p, [
      { asset_id: 'in-flight', asset_type: 'dashboard', name: 'Dash in-flight' }, // no status sent
      { asset_id: 'was-blocked', asset_type: 'dashboard', name: 'Dash was-blocked', status: 'candidate' },
    ]);
    const back = await readRows(p);
    assert.equal(back.get('in-flight')!['status'], 'staged', 'in-flight work must not be rewound');
    assert.equal(back.get('was-blocked')!['status'], 'candidate', 'a no-longer-blocked row becomes stageable again');
  });
});

describe('snapshotTracker', () => {
  it('copies the file before the first write, once per run', async () => {
    // Every mutating helper rewrites the whole workbook, and the tracker lives
    // in a synced folder reviewers also have open. Without a copy on disk a bad
    // run is unrecoverable. A refresh writes several times; we want ONE snapshot
    // of the pre-run state, not one per write.
    const p = join(dir, 'snap.xlsx');
    await upsertRows(p, [row('a', { status: 'candidate' })]);
    await upsertRows(p, [row('a', { status: 'staged' })]);
    await upsertRows(p, [row('a', { status: 'verified' })]);
    const backups = (await readdir(dir)).filter((f) => f.startsWith('snap.autobackup-'));
    assert.equal(backups.length, 1, `expected one snapshot, got: ${backups.join(', ')}`);
  });

  it('does not invent a backup for a file that does not exist', () => {
    assert.equal(snapshotTracker(join(dir, 'absent.xlsx')), undefined);
  });
});
