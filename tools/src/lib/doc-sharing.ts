/**
 * Mirroring one document's sharing settings onto another.
 *
 * Used when a reviewed notebook is published as a new notebook: the new one must
 * be owned by — and visible to exactly the same people as — the original, not by
 * the migration tooling and the review group. "Sharing settings" means four
 * things on the Document API: the public flag (`isPrivate`), whether sharees may
 * re-share (`isReshareable`), every direct share (access + user/group
 * recipients), and every environment share (access).
 *
 * Pure: plans and compares; the caller performs the writes.
 */

import type { SharingState, SsoEntity } from '../dynatrace/document.ts';

export interface SharingPlan {
  /** Flags to set, or null when they already match. */
  flags: { isPrivate: boolean; isReshareable: boolean } | null;
  deleteDirect: string[];
  createDirect: Array<{ access: 'read' | 'read-write'; recipients: SsoEntity[] }>;
  deleteEnvironment: string[];
  createEnvironment: Array<'read' | 'read-write'>;
}

const recipientsKey = (r: SsoEntity[]) =>
  r.map((x) => `${x.type}:${x.id}`).sort().join(',');
const directKey = (s: { access: string; recipients: SsoEntity[] }) => `${s.access}|${recipientsKey(s.recipients)}`;

/**
 * What to do to `current` so its sharing equals `target`'s. Shares that already
 * match are kept rather than deleted and recreated, so nobody who should have
 * access loses it even for a moment. Ownership is NOT part of the plan — it is
 * transferred separately, last, because the flags are owner-only.
 */
export function planSharingMirror(target: SharingState, current: SharingState): SharingPlan {
  const flags =
    target.isPrivate !== current.isPrivate || target.isReshareable !== current.isReshareable
      ? { isPrivate: target.isPrivate, isReshareable: target.isReshareable }
      : null;

  // Multiset match on direct shares.
  const wanted = target.direct.map((s) => ({ key: directKey(s), s, matched: false }));
  const deleteDirect: string[] = [];
  for (const cur of current.direct) {
    const hit = wanted.find((w) => !w.matched && w.key === directKey(cur));
    if (hit) hit.matched = true;
    else deleteDirect.push(cur.shareId);
  }
  const createDirect = wanted
    .filter((w) => !w.matched)
    .map((w) => ({ access: w.s.access, recipients: w.s.recipients.map((r) => ({ id: r.id, type: r.type })) }));

  // Multiset match on environment shares.
  const wantEnv = target.environment.map((s) => ({ access: s.access, matched: false }));
  const deleteEnvironment: string[] = [];
  for (const cur of current.environment) {
    const hit = wantEnv.find((w) => !w.matched && w.access === cur.access);
    if (hit) hit.matched = true;
    else deleteEnvironment.push(cur.shareId);
  }
  const createEnvironment = wantEnv.filter((w) => !w.matched).map((w) => w.access);

  return { flags, deleteDirect, createDirect, deleteEnvironment, createEnvironment };
}

/** True when the plan has nothing to do. */
export function isNoop(p: SharingPlan): boolean {
  return !p.flags && !p.deleteDirect.length && !p.createDirect.length && !p.deleteEnvironment.length && !p.createEnvironment.length;
}

/** Sharing equality, ignoring share ids (and owner, which is checked on its own). */
export function sameSharing(a: SharingState, b: SharingState): boolean {
  const canon = (s: SharingState) =>
    JSON.stringify({
      isPrivate: s.isPrivate,
      isReshareable: s.isReshareable,
      direct: s.direct.map(directKey).sort(),
      environment: s.environment.map((e) => e.access).sort(),
    });
  return canon(a) === canon(b);
}

/** One-line human summary of a sharing state. */
export function describeSharing(s: SharingState): string {
  const parts = [s.isPrivate ? 'private' : 'public', s.isReshareable ? 'reshareable' : 'not reshareable'];
  for (const d of s.direct) parts.push(`direct ${d.access} → ${d.recipients.map((r) => `${r.type}:${r.id.slice(0, 8)}`).join(', ') || '(none)'}`);
  for (const e of s.environment) parts.push(`environment ${e.access}`);
  return parts.join('; ');
}
