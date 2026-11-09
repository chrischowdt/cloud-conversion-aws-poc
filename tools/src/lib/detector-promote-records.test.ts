import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  fileStamp,
  moveAside,
  publishedValueOf,
  readPromoteRecord,
  readRolledBack,
  recordPath,
  writeRolledBack,
} from './detector-promote-records.ts';

const AT = new Date('2026-11-09T12:00:00.123Z');

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'promote-records-'));
}

describe('recordPath', () => {
  it('keeps the pending record next to the published one', () => {
    assert.equal(recordPath('p', 'pre', 'A'), join('p', 'pre', 'A.json'));
    assert.equal(recordPath('p', 'published', 'A'), join('p', 'published', 'A.json'));
    assert.equal(recordPath('p', 'pending', 'A'), join('p', 'published', 'A.pending.json'));
  });
});

describe('readPromoteRecord', () => {
  it('reads a record, and refuses one whose value or storedValue is not an object', async () => {
    const d = await dir();
    await mkdir(join(d, 'published'), { recursive: true });
    await writeFile(join(d, 'published', 'OK.json'), JSON.stringify({ value: { a: 1 }, storedValue: { a: 2 } }));
    await writeFile(join(d, 'published', 'NOVAL.json'), JSON.stringify({ value: [] }));
    await writeFile(join(d, 'published', 'BADSTORED.json'), JSON.stringify({ value: { a: 1 }, storedValue: 'x' }));

    const ok = await readPromoteRecord(d, 'published', 'OK');
    assert.equal(ok.kind, 'ok');
    assert.equal((await readPromoteRecord(d, 'published', 'NOVAL')).kind, 'bad');
    const bad = await readPromoteRecord(d, 'published', 'BADSTORED');
    assert.equal(bad.kind, 'bad');
    assert.match((bad as { problem: string }).problem, /storedValue/);
    assert.equal((await readPromoteRecord(d, 'pending', 'OK')).kind, 'missing');
  });
});

describe('publishedValueOf', () => {
  it('is what the server stored when the record has it, else what was sent', () => {
    assert.deepEqual(publishedValueOf({ value: { a: 1 }, storedValue: { a: 2 } }), { a: 2 });
    assert.deepEqual(publishedValueOf({ value: { a: 1 } }), { a: 1 });
  });
});

describe('moveAside', () => {
  it('renames <id>.json to <id>.<UTC stamp with ms>.json, never over another file', async () => {
    const d = await dir();
    await writeFile(join(d, 'A.json'), 'one');
    const first = await moveAside(join(d, 'A.json'), AT);
    await writeFile(join(d, 'A.json'), 'two');
    const second = await moveAside(join(d, 'A.json'), AT);

    assert.equal(fileStamp(AT), '20261109T120000.123Z');
    assert.equal(first, join(d, 'A.20261109T120000.123Z.json'));
    assert.equal(second, join(d, 'A.20261109T120000.123Z-1.json'));
    assert.equal(await readFile(first, 'utf8'), 'one');
    assert.equal(await readFile(second, 'utf8'), 'two');
    assert.deepEqual((await readdir(d)).sort(), ['A.20261109T120000.123Z-1.json', 'A.20261109T120000.123Z.json']);
  });
});

describe('the rolled-back record', () => {
  it('reads back what a rollback wrote, and counts an unreadable one as rolled back at an unknown time', async () => {
    const d = await dir();
    assert.equal(await readRolledBack(d, 'A'), undefined);

    await writeRolledBack(d, 'A', AT.toISOString());
    assert.deepEqual(JSON.parse(await readFile(join(d, 'rolled-back', 'A.json'), 'utf8')), { objectId: 'A', rolledBackAt: AT.toISOString() });
    assert.equal((await readRolledBack(d, 'A'))?.rolledBackAt, AT.toISOString());

    await writeFile(join(d, 'rolled-back', 'B.json'), '{ not json');
    const b = await readRolledBack(d, 'B');
    assert.ok(b, 'still counts as rolled back');
    assert.equal(b.rolledBackAt, undefined);
  });
});
