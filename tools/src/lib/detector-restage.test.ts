import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { planRestage } from './detector-restage.ts';

const md = (id: string, text: string) => ({ id: `md-${id}`, type: 'markdown', markdown: text });
const dql = (id: string, q: string, result?: unknown) => ({
  id: `dql-${id}`,
  type: 'dql',
  state: { input: { value: q, timeframe: { from: 'now()-24h', to: 'now()' } }, ...(result ? { result } : {}) },
});
const review = (id: string, status = 'Needs Review') => ({ id: `review-${id}`, type: 'markdown', markdown: `**Status:** ${status}` });
const nb = (sections: any[]) => ({ version: '7', sections });
const header = { id: 'header', type: 'markdown', markdown: '# batch' };

describe('planRestage — replace only the cards nobody has touched', () => {
  const base = nb([header, md('a', 'old a'), dql('a', 'q a'), review('a'), md('b', 'old b'), dql('b', 'q b'), review('b')]);
  const fresh = new Map([
    ['a', [md('a', 'new a'), dql('a', 'q a2')]],
    ['b', [md('b', 'new b'), dql('b', 'q b2')]],
  ]);

  it('restages an untouched card, keeping its place, and drops its stale stored result', () => {
    const live = nb([header, md('a', 'old a'), dql('a', 'q a', { records: [1] }), review('a'), md('b', 'old b'), dql('b', 'q b'), review('b')]);
    const r = planRestage(live, base, fresh, ['a', 'b'], new Set());
    assert.deepEqual(r.plans.map((p) => p.action), ['restage', 'restage']);
    assert.deepEqual(r.next.sections.map((s: any) => s.id), live.sections.map((s: any) => s.id));
    assert.equal((r.next.sections[2] as any).state.input.value, 'q a2');
    assert.equal((r.next.sections[2] as any).state.result, undefined);
    assert.equal((r.nextBase.sections[1] as any).markdown, 'new a');
  });

  it('keeps a card whose query, notes or verdict a reviewer edited — and its base', () => {
    const live = nb([header, md('a', 'old a'), dql('a', 'q a fixed'), review('a'), md('b', 'old b'), dql('b', 'q b'), review('b', 'Ready To Publish')]);
    const r = planRestage(live, base, fresh, ['a', 'b'], new Set());
    assert.deepEqual(r.plans.map((p) => p.action), ['edited', 'edited']);
    assert.deepEqual(r.next, live);
    assert.deepEqual(r.nextBase, base);
  });

  it('keeps a card the tracker records a decision for, even if the notebook is unchanged', () => {
    const r = planRestage(base, base, fresh, ['a', 'b'], new Set(['b']));
    assert.deepEqual(r.plans.map((p) => p.action), ['restage', 'reviewed']);
    assert.equal((r.next.sections[5] as any).state.input.value, 'q b');
  });

  it('leaves a card alone when the new rendering is the same, or there is none', () => {
    const same = new Map([['a', [md('a', 'old a'), dql('a', 'q a')]]]);
    const r = planRestage(base, base, same, ['a', 'b'], new Set());
    assert.deepEqual(r.plans.map((p) => p.action), ['current', 'unresolved']);
    assert.deepEqual(r.next, base);
  });

  it('never guesses when a section is missing from either side', () => {
    const live = nb([header, md('a', 'old a'), review('a'), md('b', 'old b'), dql('b', 'q b'), review('b')]);
    const r = planRestage(live, base, fresh, ['a', 'b'], new Set());
    assert.deepEqual(r.plans.map((p) => p.action), ['missing', 'restage']);
  });
});
