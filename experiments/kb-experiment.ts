/**
 * Run the KB-only conversion over the two chosen originals, write stageable
 * payloads, and compare against the hand-done final.
 *
 *   ORIGINAL  migration/pre-promote/<id>.json   (genuine pre-cutover classic)
 *   HAND-DONE migration/reviewed/<id>.json      (our rewriter + reviewer edits)
 *   KB-ONLY   produced here
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { kbConvert, type Note } from './kb-only-convert.ts';

const BASE = 'out/nic55601/migration';
const OUT = 'out/nic55601/kb-experiment';
mkdirSync(OUT, { recursive: true });

const TARGETS = [
  { id: '51c7e010-8cd1-4a2b-9869-7de959cd7a04', name: 'EQY-Metrics' },
  { id: 'c7e63a75-1b02-4922-9091-2ae1c9ecd4ef', name: 'AAP : JET : Dynamo DB Metrics' },
];

const wrapper = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const contentOf = (w: any) => (typeof w.content === 'string' ? JSON.parse(w.content) : (w.content ?? w));

/** Queries keyed by tile path so comparisons line up across versions. */
const queries = (o: unknown): Map<string, string> => {
  const out = new Map<string, string>();
  const walk = (x: any, path: string) => {
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      if ((k === 'query' || k === 'value') && typeof v === 'string' && v.trim()) out.set(path, v);
      else if (v && typeof v === 'object') walk(v, path ? `${path}/${(v as any).key ?? k}` : String((v as any).key ?? k));
    }
  };
  walk(o, '');
  return out;
};
const live = (q: string) => q.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join(' ').replace(/\s+/g, ' ').trim();

/** Apply kbConvert to every query in a deep clone. */
function convertInPlace(content: any): { notes: Note[]; unresolved: string[]; changed: number } {
  const notes: Note[] = [];
  const unresolved: string[] = [];
  let changed = 0;
  const walk = (x: any) => {
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      if ((k === 'query' || k === 'value') && typeof v === 'string' && v.trim()) {
        const r = kbConvert(v);
        if (r.out !== v) changed++;
        (x as any)[k] = r.out;
        notes.push(...r.notes);
        unresolved.push(...r.unresolved);
      } else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(content);
  return { notes, unresolved, changed };
}

const report: string[] = ['# Knowledgebase-only conversion experiment', ''];

for (const t of TARGETS) {
  const origW = wrapper(join(BASE, 'pre-promote', `${t.id}.json`));
  const orig = contentOf(origW);
  const hand = contentOf(wrapper(join(BASE, 'reviewed', `${t.id}.json`)));

  const kb = structuredClone(orig);
  const { notes, unresolved, changed } = convertInPlace(kb);

  const oq = queries(orig);
  const kq = queries(kb);
  const hq = queries(hand);

  let kbSame = 0, handSame = 0, agree = 0, differ = 0, onlyHand = 0, onlyKb = 0;
  const examples: Array<{ path: string; orig: string; kb: string; hand: string }> = [];
  for (const [path, o] of oq) {
    const k = kq.get(path), h = hq.get(path);
    if (k === undefined || h === undefined) continue;
    const lo = live(o), lk = live(k), lh = live(h);
    if (lk === lo) kbSame++;                 // KB left it untouched
    if (lh === lo) handSame++;               // hand-done left it untouched
    if (lk === lh) agree++;
    else {
      differ++;
      if (lk === lo && lh !== lo) onlyHand++;   // only the hand process converted it
      if (lh === lo && lk !== lo) onlyKb++;     // only the KB touched it
      if (examples.length < 6) examples.push({ path, orig: lo, kb: lk, hand: lh });
    }
  }

  const byRule: Record<string, number> = {};
  for (const n of notes) byRule[n.rule] = (byRule[n.rule] ?? 0) + 1;
  const byUnresolved: Record<string, number> = {};
  for (const u of unresolved) {
    const kind = u.split(':')[0]!;
    byUnresolved[kind] = (byUnresolved[kind] ?? 0) + 1;
  }

  // Stageable payload, clearly marked.
  const name = `[KB-ONLY TEST — DO NOT USE] ${t.name}`;
  writeFileSync(join(OUT, `${t.id}.kb-only.json`), JSON.stringify({ name, type: 'dashboard', content: kb }, null, 2));

  report.push(`## ${t.name}`, '');
  report.push(`- tiles compared: **${[...oq].filter(([p]) => kq.has(p) && hq.has(p)).length}**`);
  report.push(`- queries the KB conversion changed: **${changed}**`);
  report.push(`- KB output identical to the hand-done final: **${agree}**`);
  report.push(`- differed: **${differ}** (of which: only the hand process converted **${onlyHand}**, only the KB touched **${onlyKb}**)`);
  report.push(`- KB left untouched: ${kbSame} · hand-done left untouched: ${handSame}`, '');
  report.push(`**Rules the KB fired:** ${Object.entries(byRule).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}×${n}`).join(', ') || 'none'}`, '');
  report.push(`**No KB rule available:** ${Object.entries(byUnresolved).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}×${n}`).join(', ') || 'none'}`, '');
  for (const e of examples) {
    report.push(`### tile \`${e.path}\``, '```', `CLASSIC : ${e.orig.slice(0, 220)}`, `KB-ONLY : ${e.kb.slice(0, 220)}`, `HAND    : ${e.hand.slice(0, 220)}`, '```', '');
  }

  console.log(`${t.name}: compared ${agree + differ}, agree ${agree}, differ ${differ} (hand-only ${onlyHand}, kb-only ${onlyKb})`);
  console.log(`   rules: ${JSON.stringify(byRule)}`);
  console.log(`   no KB rule: ${JSON.stringify(byUnresolved)}`);
}

writeFileSync(join(OUT, 'comparison.md'), report.join('\n'));
console.log(`\nWrote ${OUT}/comparison.md and two .kb-only.json payloads`);
