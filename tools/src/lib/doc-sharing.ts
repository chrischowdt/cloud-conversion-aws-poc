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
 * A document has at most ONE direct share per access level — a second
 * `read-write` share is refused with HTTP 409 ("Share of type 'direct' with
 * access 'read-write' already exists"). So direct shares are mirrored per access
 * level by editing the recipients of the share that is already there, not by
 * creating another. (Getting this wrong cost five users their access in the
 * first bulk publish: the 409 was taken for "already shared" and the review
 * group's share — the one the users should have been added to — was deleted.)
 *
 * Pure: plans and compares; the caller performs the writes.
 */

import type { SharingState, SsoEntity } from '../dynatrace/document.ts';

type Access = 'read' | 'read-write';

export interface SharingPlan {
  /** Flags to set, or null when they already match. */
  flags: { isPrivate: boolean; isReshareable: boolean } | null;
  /** Access levels the document has no direct share for yet. */
  createDirect: Array<{ access: Access; recipients: SsoEntity[] }>;
  /** Recipients to add to a direct share that already exists at that access level. */
  addRecipients: Array<{ shareId: string; recipients: SsoEntity[] }>;
  /** Recipients to take off a direct share that stays. */
  removeRecipients: Array<{ shareId: string; ids: string[] }>;
  /** Direct shares at an access level the target has nobody at. */
  deleteDirect: string[];
  deleteEnvironment: string[];
  createEnvironment: Access[];
}

const entityKey = (x: SsoEntity) => `${x.type}:${x.id}`;
const ACCESS_LEVELS: Access[] = ['read', 'read-write'];

/** Every recipient per access level, de-duplicated (the API's own model). */
function recipientsByAccess(s: SharingState): Map<Access, SsoEntity[]> {
  const out = new Map<Access, SsoEntity[]>();
  for (const d of s.direct) {
    const list = out.get(d.access) ?? [];
    for (const r of d.recipients) if (!list.some((x) => entityKey(x) === entityKey(r))) list.push({ id: r.id, type: r.type });
    out.set(d.access, list);
  }
  return out;
}

/**
 * What to do to `current` so its sharing equals `target`'s. Recipients who
 * should keep access stay on their share throughout — nothing is deleted and
 * recreated. Ownership is NOT part of the plan — it is transferred separately,
 * last, because the flags are owner-only.
 *
 * The API refuses to make a document's owner a recipient of its own share, so a
 * target recipient who is `current`'s owner is left out here. The caller plans
 * again after the ownership transfer, when that person is no longer the owner.
 */
export function planSharingMirror(target: SharingState, current: SharingState): SharingPlan {
  const flags =
    target.isPrivate !== current.isPrivate || target.isReshareable !== current.isReshareable
      ? { isPrivate: target.isPrivate, isReshareable: target.isReshareable }
      : null;

  const isCurrentOwner = (r: SsoEntity) => r.type === 'user' && !!current.owner && r.id === current.owner;
  const want = recipientsByAccess(target);
  const createDirect: SharingPlan['createDirect'] = [];
  const addRecipients: SharingPlan['addRecipients'] = [];
  const removeRecipients: SharingPlan['removeRecipients'] = [];
  const deleteDirect: string[] = [];
  for (const access of ACCESS_LEVELS) {
    const wanted = (want.get(access) ?? []).filter((r) => !isCurrentOwner(r));
    const wantedKeys = new Set((want.get(access) ?? []).map(entityKey));
    const [keep, ...extra] = current.direct.filter((d) => d.access === access);
    // Never expected (the API allows one per level), but don't leave strays behind.
    deleteDirect.push(...extra.map((d) => d.shareId));
    if (!keep) {
      if (wanted.length) createDirect.push({ access, recipients: wanted });
      continue;
    }
    if (!wantedKeys.size) {
      deleteDirect.push(keep.shareId);
      continue;
    }
    const have = new Set(keep.recipients.map(entityKey));
    const add = wanted.filter((r) => !have.has(entityKey(r)));
    const remove = keep.recipients.filter((r) => !wantedKeys.has(entityKey(r))).map((r) => r.id);
    if (add.length) addRecipients.push({ shareId: keep.shareId, recipients: add });
    if (remove.length) removeRecipients.push({ shareId: keep.shareId, ids: remove });
  }

  // Multiset match on environment shares.
  const wantEnv = target.environment.map((s) => ({ access: s.access, matched: false }));
  const deleteEnvironment: string[] = [];
  for (const cur of current.environment) {
    const hit = wantEnv.find((w) => !w.matched && w.access === cur.access);
    if (hit) hit.matched = true;
    else deleteEnvironment.push(cur.shareId);
  }
  const createEnvironment = wantEnv.filter((w) => !w.matched).map((w) => w.access);

  return { flags, createDirect, addRecipients, removeRecipients, deleteDirect, deleteEnvironment, createEnvironment };
}

/** True when the plan has nothing to do. */
export function isNoop(p: SharingPlan): boolean {
  return (
    !p.flags &&
    !p.createDirect.length &&
    !p.addRecipients.length &&
    !p.removeRecipients.length &&
    !p.deleteDirect.length &&
    !p.deleteEnvironment.length &&
    !p.createEnvironment.length
  );
}

/**
 * Sharing equality, ignoring share ids (and owner, which is checked on its own).
 * Compared as recipients per access level; a share with no recipients grants
 * nothing and counts as absent.
 */
export function sameSharing(a: SharingState, b: SharingState): boolean {
  const canon = (s: SharingState) => {
    const by = recipientsByAccess(s);
    return JSON.stringify({
      isPrivate: s.isPrivate,
      isReshareable: s.isReshareable,
      direct: ACCESS_LEVELS.map((acc) => `${acc}|${(by.get(acc) ?? []).map(entityKey).sort().join(',')}`),
      environment: s.environment.map((e) => e.access).sort(),
    });
  };
  return canon(a) === canon(b);
}

/** One-line human summary of a sharing state. */
export function describeSharing(s: SharingState): string {
  const parts = [s.isPrivate ? 'private' : 'public', s.isReshareable ? 'reshareable' : 'not reshareable'];
  for (const d of s.direct) parts.push(`direct ${d.access} → ${d.recipients.map((r) => `${r.type}:${r.id.slice(0, 8)}`).join(', ') || '(none)'}`);
  for (const e of s.environment) parts.push(`environment ${e.access}`);
  return parts.join('; ');
}
