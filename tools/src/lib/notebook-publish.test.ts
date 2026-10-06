import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTICE_SECTION_ID,
  POINTER_SECTION_ID,
  SUPERSEDED_LABEL,
  UPGRADED_LABEL,
  isSupersededOriginal,
  mergeLabels,
  removeLabels,
  buildMigrationNotice,
  buildOriginalPointer,
  sameSectionsExcept,
  withoutSection,
  countReferenceBlocks,
  publishedNotebookName,
  withMigrationNotice,
} from './notebook-publish.ts';

describe('publishedNotebookName', () => {
  it('keeps the original title — only the review prefix goes', () => {
    // Later upgrades would otherwise stack suffixes onto the title.
    assert.equal(publishedNotebookName('[MIGRATION REVIEW] EIF Notebook'), 'EIF Notebook');
    assert.equal(publishedNotebookName('EIF Notebook'), 'EIF Notebook');
  });

  it('never yields an empty name', () => {
    assert.equal(publishedNotebookName('[MIGRATION REVIEW] '), 'Untitled notebook');
  });
});

describe('labels', () => {
  it("merges ours into the owner's existing labels, without duplicates", () => {
    assert.deepEqual(mergeLabels(['team-x'], [UPGRADED_LABEL]), ['team-x', UPGRADED_LABEL]);
    assert.deepEqual(mergeLabels([UPGRADED_LABEL], [UPGRADED_LABEL]), [UPGRADED_LABEL]);
    assert.deepEqual(mergeLabels(undefined, [SUPERSEDED_LABEL]), [SUPERSEDED_LABEL]);
  });

  it('removes only ours on rollback', () => {
    assert.deepEqual(removeLabels(['team-x', SUPERSEDED_LABEL], [SUPERSEDED_LABEL]), ['team-x']);
    assert.deepEqual(removeLabels(undefined, [SUPERSEDED_LABEL]), []);
  });

  it('recognises a superseded original by its pointer tile', () => {
    assert.equal(isSupersededOriginal({ sections: [{ id: POINTER_SECTION_ID }, { id: 'q' }] }), true);
    assert.equal(isSupersededOriginal({ sections: [{ id: 'q' }] }), false);
    assert.equal(isSupersededOriginal(null), false);
  });
});

describe('buildMigrationNotice', () => {
  const md = buildMigrationNotice({
    originalName: 'Kiran\'s Notebook',
    originalUrl: 'https://x.apps.dynatrace.com/ui/apps/dynatrace.notebooks/notebook/abc',
    reviewer: 'Rama Kotari',
    date: '2026-10-05',
  });

  it('links the original and says its queries and results were left as they were', () => {
    assert.match(md, /\[the original notebook\]\(https:\/\/x\.apps\.dynatrace\.com\/.+\/abc\)/);
    assert.match(md, /results of its past runs were left exactly as they were/i);
    assert.match(md, /link to this notebook at the top/);
  });

  it('records when and by whom', () => {
    assert.match(md, /2026-10-05/);
    assert.match(md, /reviewed by Rama Kotari/);
  });

  it('degrades cleanly without a URL or reviewer', () => {
    const bare = buildMigrationNotice({ originalName: 'X', date: '2026-10-05' });
    assert.match(bare, /upgraded version of the original notebook\./);
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

describe('the pointer tile on the ORIGINAL notebook', () => {
  const original = {
    version: '7',
    sections: [
      { id: 'q1', type: 'dql', state: { input: { value: 'timeseries classic' }, result: { rows: [1, 2, 3] } } },
      { id: 'm1', type: 'markdown', markdown: 'what we found in May' },
    ],
  };
  const md = buildOriginalPointer({
    newName: 'EIF Notebook (new AWS integration)',
    newUrl: 'https://x.apps.dynatrace.com/ui/apps/dynatrace.notebooks/notebook/new-id',
    date: '2026-10-05',
  });

  it('links to the new notebook and says nothing else changed', () => {
    assert.match(md, /\[Open the upgraded version\]\(https:\/\/x\.apps\.dynatrace\.com\/.+\/new-id\)/);
    assert.match(md, /Nothing else in this notebook was changed/);
    assert.ok(md.includes('\n'), 'multi-line markdown');
  });

  it('goes first, and leaves every existing section — stored results included — identical', () => {
    const out = withMigrationNotice(original, md, POINTER_SECTION_ID);
    assert.equal(out.sections![0]!['id'], POINTER_SECTION_ID);
    assert.equal(sameSectionsExcept(original, out, POINTER_SECTION_ID), true);
    assert.deepEqual(out.sections!.slice(1), original.sections);
  });

  it('notices if anything other than the pointer differs', () => {
    const tampered = withMigrationNotice(original, md, POINTER_SECTION_ID) as any;
    tampered.sections[1].state.result = { rows: [] };
    assert.equal(sameSectionsExcept(original, tampered, POINTER_SECTION_ID), false);
  });

  it('is removable exactly, which is what rollback relies on', () => {
    const back = withoutSection(withMigrationNotice(original, md, POINTER_SECTION_ID), POINTER_SECTION_ID);
    assert.deepEqual(back, original);
  });

  it('keeps the pointer and the new-notebook notice independent', () => {
    const both = withMigrationNotice(withMigrationNotice(original, 'N', NOTICE_SECTION_ID), md, POINTER_SECTION_ID);
    assert.deepEqual(both.sections!.map((s) => s['id']), [POINTER_SECTION_ID, NOTICE_SECTION_ID, 'q1', 'm1']);
  });
});
