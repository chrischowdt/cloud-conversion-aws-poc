/**
 * three-way-merge — reconcile a reviewed migration copy with an original that
 * the owner edited while it was in review.
 *
 *   base   = the original as it was when we staged the copy
 *   ours   = the reviewed copy (the migration + the reviewer's fixes)
 *   theirs = the original as it is NOW (the owner's later edits)
 *
 * The drift guard exists so a cutover never silently discards an owner's work.
 * Forcing past it does exactly that; re-staging instead discards the reviewer's.
 * Merging keeps both: in practice the two sides touch different things — the
 * reviewer rewrites queries, the owner adjusts layout and visualisations.
 *
 * Rules, per node:
 *   - only THEIRS changed  -> take theirs (an owner edit we must not lose)
 *   - only OURS changed    -> keep ours   (the migration)
 *   - BOTH changed         -> keep ours, and report it as a conflict
 * The migration wins conflicts because a half-migrated query is broken, whereas
 * a lost cosmetic tweak is re-appliable — but every conflict is surfaced rather
 * than swallowed, so nobody finds out by accident.
 *
 * Arrays whose elements carry a stable id are merged BY THAT ID, not by index:
 * if one side deleted an element every later index shifts and an index-wise
 * merge silently compares unrelated objects. Elements either side ADDED are
 * appended rather than dropped.
 *
 * Pure — no fs/fetch — so it is unit-testable and reusable.
 */

export interface MergeReport {
  /** Paths where an owner-only change was adopted. */
  ownerChangesTaken: string[];
  /** Paths present only on the owner's side that were appended. */
  ownerAdditions: string[];
  /** Paths both sides changed where the MIGRATION side was kept. */
  conflicts: string[];
  /** Paths both sides changed where the OWNER's (presentation) side was kept. */
  conflictsOwnerWon: string[];
}

/**
 * Presentation-only parts of a dashboard. On a conflict here the OWNER's value
 * wins: these carry no migration meaning (colours, units, chart type, layout),
 * the owner's edit is the more recent intent, and keeping the reviewer's stale
 * copy would quietly undo a deliberate change. Anything else — queries, metric
 * keys, variables that feed them — stays with the migration, because a
 * half-migrated query is broken rather than merely out of date.
 */
const PRESENTATION_PATH =
  /(^|\.)(visualizationSettings|layouts|coloring|unitsOverrides|chartSettings|colorRules|davis)(\.|\[|$)/;

const J = (v: unknown) => JSON.stringify(v);
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);
const idOf = (e: unknown): string | undefined =>
  isObj(e) ? ((e['key'] ?? e['id'] ?? e['name']) as string | undefined) : undefined;

export function threeWayMerge<T>(base: T, ours: T, theirs: T): { merged: T; report: MergeReport } {
  const report: MergeReport = { ownerChangesTaken: [], ownerAdditions: [], conflicts: [], conflictsOwnerWon: [] };
  const merged = walk(base, ours, theirs, '', report) as T;
  return { merged, report };
}

function walk(base: unknown, ours: unknown, theirs: unknown, path: string, r: MergeReport): unknown {
  const theirsChanged = J(theirs) !== J(base);
  const oursChanged = J(ours) !== J(base);
  if (!theirsChanged) return ours;                       // owner didn't touch it
  if (!oursChanged) { r.ownerChangesTaken.push(path); return theirs; }

  if (Array.isArray(base) && Array.isArray(ours) && Array.isArray(theirs)) {
    const keyed = [base, ours, theirs].every((a) => a.every((e) => idOf(e) !== undefined));
    if (keyed) {
      const bM = new Map(base.map((e) => [idOf(e), e]));
      const tM = new Map(theirs.map((e) => [idOf(e), e]));
      const out: unknown[] = [];
      for (const e of ours) {                            // reviewer's set + order wins
        const k = idOf(e);
        const b = bM.get(k), t = tM.get(k);
        out.push(b !== undefined && t !== undefined ? walk(b, e, t, `${path}[${k}]`, r) : e);
      }
      for (const e of theirs) {                          // owner-added elements survive
        const k = idOf(e);
        if (!bM.has(k) && !ours.some((o) => idOf(o) === k)) {
          out.push(e);
          r.ownerAdditions.push(`${path}[${k}]`);
        }
      }
      return out;
    }
    const n = Math.min(base.length, ours.length, theirs.length);
    const out: unknown[] = [];
    for (let i = 0; i < n; i++) out.push(walk(base[i], ours[i], theirs[i], `${path}[${i}]`, r));
    for (let i = n; i < ours.length; i++) out.push(ours[i]);
    for (let i = Math.max(n, base.length); i < theirs.length; i++) {
      out.push(theirs[i]);
      r.ownerAdditions.push(`${path}[${i}]`);
    }
    return out;
  }

  if (isObj(base) && isObj(ours) && isObj(theirs)) {
    const out: Record<string, unknown> = {};
    for (const k of new Set([...Object.keys(base), ...Object.keys(ours), ...Object.keys(theirs)])) {
      const p = path ? `${path}.${k}` : k;
      const inB = k in base, inO = k in ours, inT = k in theirs;
      if (!inT && inB) {                                  // owner deleted it
        if (!inO || J(ours[k]) === J(base[k])) { r.ownerChangesTaken.push(`${p} (deleted)`); continue; }
        out[k] = ours[k];
        continue;
      }
      if (!inO && inT && !inB) { out[k] = theirs[k]; r.ownerAdditions.push(p); continue; }
      if (!inO) continue;
      out[k] = inT ? walk(base[k], ours[k], theirs[k], p, r) : ours[k];
    }
    return out;
  }

  // Leaf conflict. Presentation is the owner's call — their edit is the more
  // recent intent and carries no migration meaning, so keeping the reviewer's
  // stale copy would quietly undo it. Everything else stays with the migration.
  if (PRESENTATION_PATH.test(path)) {
    r.conflictsOwnerWon.push(path);
    return theirs;
  }
  r.conflicts.push(path);
  return ours;
}
