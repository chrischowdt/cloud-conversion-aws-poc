import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTICE_SECTION_ID,
  buildMigrationNotice,
  countReferenceBlocks,
  publishedNotebookName,
  withMigrationNotice,
} from './notebook-publish.ts';

describe('publishedNotebookName', () => {
  it('drops the review prefix and marks the new notebook apart from the original', () => {
    assert.equal(publishedNotebookName('[MIGRATION REVIEW] EIF Notebook'), 'EIF Notebook (new AWS integration)');
  });

  it('is idempotent', () => {
    const once = publishedNotebookName('[MIGRATION REVIEW] Bala PCI');
    assert.equal(publishedNotebookName(once), once);
  });

  it('never yields an empty name', () => {
    assert.equal(publishedNotebookName('[MIGRATION REVIEW] '), 'Untitled notebook (new AWS integration)');
  });
});

describe('buildMigrationNotice', () => {
  const md = buildMigrationNotice({
    originalName: 'Kiran\'s Notebook',
    originalUrl: 'https://x.apps.dynatrace.com/ui/apps/dynatrace.notebooks/notebook/abc',
    reviewer: 'Rama Kotari',
    date: '2026-10-05',
  });

  it('links the original and says plainly that it was not modified', () => {
    assert.match(md, /\[Kiran's Notebook\]\(https:\/\/x\.apps\.dynatrace\.com\/.+\/abc\)/);
    assert.match(md, /original notebook was not modified/i);
    assert.match(md, /results of its past query runs/);
  });

  it('records when and by whom', () => {
    assert.match(md, /2026-10-05/);
    assert.match(md, /reviewed by Rama Kotari/);
  });

  it('degrades cleanly without a URL or reviewer', () => {
    const bare = buildMigrationNotice({ originalName: 'X', date: '2026-10-05' });
    assert.match(bare, /\*\*X\*\*/);
    assert.doesNotMatch(bare, /reviewed by/);
  });
});

describe('withMigrationNotice', () => {
  const content = {
    version: '7',
    sections: [
      { id: 'q1', type: 'dql', state: { input: { value: 'timeseries x' }, result: { stored: true } } },
      { id: 'm1', type: 'markdown', markdown: 'author notes' },
    ],
  };

  it('puts the notice FIRST and carries every other section over untouched', () => {
    const out = withMigrationNotice(content, 'NOTICE');
    assert.equal(out.sections![0]!['id'], NOTICE_SECTION_ID);
    assert.equal(out.sections![0]!['markdown'], 'NOTICE');
    assert.deepEqual(out.sections!.slice(1), content.sections, 'stored results and author sections preserved');
  });

  it('replaces an existing notice rather than stacking a second one', () => {
    const twice = withMigrationNotice(withMigrationNotice(content, 'OLD'), 'NEW');
    assert.equal(twice.sections!.filter((s) => s['id'] === NOTICE_SECTION_ID).length, 1);
    assert.equal(twice.sections![0]!['markdown'], 'NEW');
    assert.equal(twice.sections!.length, 3);
  });

  it('does not mutate its input', () => {
    const before = JSON.stringify(content);
    withMigrationNotice(content, 'N');
    assert.equal(JSON.stringify(content), before);
  });
});

describe('countReferenceBlocks', () => {
  it('counts the migration reference comments left in a notebook', () => {
    const c = { sections: [{ state: { input: { value: '//>>> ORIGINAL CLASSIC QUERY (migration reference — safe to delete) >>>\n// q\n//<<<\ntimeseries x' } } }] };
    assert.equal(countReferenceBlocks(c), 1);
    assert.equal(countReferenceBlocks({ sections: [] }), 0);
  });
});
