/**
 * asset-extractors — pull DQL query strings out of the two new asset shapes.
 * Pure functions over parsed JSON, colocated-tested.
 *
 *   - Notebooks: DQL lives in `content.sections[].state.input.value`.
 *   - Davis anomaly detectors: DQL lives in `value.analyzer.input[]` under the
 *     entry whose `key == "query"`.
 */

import { looksLikeDql, type ExtractedQuery } from './asset-scan.ts';

/**
 * Notebook DQL. Primary location is each section's `state.input.value`; we also
 * sweep any other DQL-looking string in the section state so variant cell
 * shapes aren't missed. Deduped by (location, query).
 */
export function extractNotebookQueries(content: unknown): ExtractedQuery[] {
  const out: ExtractedQuery[] = [];
  const seen = new Set<string>();
  const push = (location: string, field: string, q: unknown) => {
    if (typeof q !== 'string' || q.length < 15 || !looksLikeDql(q)) return;
    // Dedupe by query content: the canonical slot and the sweep can hit the
    // same value at different paths, and identical DQL is one occurrence here.
    if (seen.has(q)) return;
    seen.add(q);
    out.push({ location, field, query: q });
  };

  const root = content as { sections?: unknown } | null;
  const sections = Array.isArray(root?.sections) ? root!.sections : [];
  sections.forEach((section, i) => {
    if (!section || typeof section !== 'object') return;
    const s = section as Record<string, any>;
    const loc = `section[${i}]${s.type ? `:${s.type}` : ''}`;
    push(loc, 'state.input.value', s.state?.input?.value);
    const walk = (o: any, path: string) => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (typeof v === 'string') push(`${loc}.${path}${k}`, k, v);
        else if (v && typeof v === 'object') walk(v, `${path}${k}.`);
      }
    };
    if (s.state && typeof s.state === 'object') walk(s.state, 'state.');
  });
  return out;
}

/**
 * Davis anomaly-detector DQL. The analyzer input array holds `{ key, value }`
 * pairs; the DQL is under `key == "query"`. We also accept any input whose
 * value looks like DQL, to be robust to analyzers that name the field
 * differently. Deduped by (key, query).
 */
export function extractDetectorQueries(value: unknown): ExtractedQuery[] {
  const out: ExtractedQuery[] = [];
  const seen = new Set<string>();
  const v = value as { analyzer?: { input?: unknown } } | null;
  const inputs = Array.isArray(v?.analyzer?.input) ? v!.analyzer!.input : [];
  inputs.forEach((inp, i) => {
    if (!inp || typeof inp !== 'object') return;
    const { key, value: val } = inp as { key?: unknown; value?: unknown };
    if (typeof val !== 'string' || val.length < 15 || !looksLikeDql(val)) return;
    if (key !== 'query' && !looksLikeDql(val)) return;
    if (seen.has(val)) return;
    seen.add(val);
    out.push({ location: `analyzer.input[${i}]`, field: String(key ?? 'query'), query: val });
  });
  return out;
}
