import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { SharingState } from '../dynatrace/document.ts';
import { describeSharing, isNoop, planSharingMirror, sameSharing } from './doc-sharing.ts';

const state = (over: Partial<SharingState> = {}): SharingState => ({
  owner: 'owner-1',
  isPrivate: true,
  isReshareable: true,
  direct: [],
  environment: [],
  ...over,
});

describe('planSharingMirror', () => {
  it('the test pair: a public copy shared with the review group becomes private with no shares', () => {
    // Measured on nic55601: original private + no shares; published copy public + review-group share.
    const original = state();
    const copy = state({
      isPrivate: false,
      direct: [{ shareId: 's1', access: 'read-write', recipients: [{ id: 'review-group', type: 'group' }] }],
    });
    const p = planSharingMirror(original, copy);
    assert.deepEqual(p.flags, { isPrivate: true, isReshareable: true });
    assert.deepEqual(p.deleteDirect, ['s1']);
    assert.deepEqual(p.createDirect, []);
  });

  it('recreates the original direct shares, users and groups, with their access', () => {
    const original = state({
      direct: [
        { shareId: 'o1', access: 'read', recipients: [{ id: 'u1', type: 'user' }, { id: 'g1', type: 'group' }] },
        { shareId: 'o2', access: 'read-write', recipients: [{ id: 'u2', type: 'user' }] },
      ],
      environment: [{ shareId: 'oe', access: 'read' }],
    });
    const p = planSharingMirror(original, state());
    assert.equal(p.flags, null);
    assert.deepEqual(p.createDirect, [
      { access: 'read', recipients: [{ id: 'u1', type: 'user' }, { id: 'g1', type: 'group' }] },
      { access: 'read-write', recipients: [{ id: 'u2', type: 'user' }] },
    ]);
    assert.deepEqual(p.createEnvironment, ['read']);
  });

  it('keeps shares that already match instead of deleting and recreating them', () => {
    const share = { access: 'read' as const, recipients: [{ id: 'g1', type: 'group' }] };
    const p = planSharingMirror(
      state({ direct: [{ shareId: 'o1', ...share }] }),
      state({ direct: [{ shareId: 'c1', ...share }, { shareId: 'c2', access: 'read-write', recipients: [{ id: 'g9', type: 'group' }] }] })
    );
    assert.deepEqual(p.deleteDirect, ['c2']);
    assert.deepEqual(p.createDirect, []);
  });

  it('treats recipient order as irrelevant', () => {
    const p = planSharingMirror(
      state({ direct: [{ shareId: 'o', access: 'read', recipients: [{ id: 'a', type: 'user' }, { id: 'b', type: 'user' }] }] }),
      state({ direct: [{ shareId: 'c', access: 'read', recipients: [{ id: 'b', type: 'user' }, { id: 'a', type: 'user' }] }] })
    );
    assert.equal(isNoop(p), true);
  });

  it('distinguishes access levels for the same recipients', () => {
    const p = planSharingMirror(
      state({ direct: [{ shareId: 'o', access: 'read', recipients: [{ id: 'g', type: 'group' }] }] }),
      state({ direct: [{ shareId: 'c', access: 'read-write', recipients: [{ id: 'g', type: 'group' }] }] })
    );
    assert.deepEqual(p.deleteDirect, ['c']);
    assert.equal(p.createDirect[0]!.access, 'read');
  });

  it('adds users to the existing share at that access level instead of creating a second one', () => {
    // The first bulk publish: the copy's only read-write share was the review
    // group's; the original's read-write share was one user. A second read-write
    // share is HTTP 409, so the user must join the group's share, then the group leaves.
    const p = planSharingMirror(
      state({ direct: [{ shareId: 'o', access: 'read-write', recipients: [{ id: 'u1', type: 'user' }] }] }),
      state({ direct: [{ shareId: 'c', access: 'read-write', recipients: [{ id: 'review-group', type: 'group' }] }] })
    );
    assert.deepEqual(p.createDirect, []);
    assert.deepEqual(p.deleteDirect, [], 'the share the user is joining must survive');
    assert.deepEqual(p.addRecipients, [{ shareId: 'c', recipients: [{ id: 'u1', type: 'user' }] }]);
    assert.deepEqual(p.removeRecipients, [{ shareId: 'c', ids: ['review-group'] }]);
  });

  it("leaves out the copy's current owner (the API refuses it) — the post-transfer pass adds them", () => {
    const original = state({ owner: 'alice', direct: [{ shareId: 'o', access: 'read', recipients: [{ id: 'tool', type: 'user' }, { id: 'g', type: 'group' }] }] });
    const copy = state({ owner: 'tool' });
    assert.deepEqual(planSharingMirror(original, copy).createDirect, [{ access: 'read', recipients: [{ id: 'g', type: 'group' }] }]);
    const afterTransfer = state({ owner: 'alice', direct: [{ shareId: 'c', access: 'read', recipients: [{ id: 'g', type: 'group' }] }] });
    assert.deepEqual(planSharingMirror(original, afterTransfer).addRecipients, [{ shareId: 'c', recipients: [{ id: 'tool', type: 'user' }] }]);
  });

  it('removes an environment share the original does not have, and adds one it does', () => {
    assert.deepEqual(planSharingMirror(state(), state({ environment: [{ shareId: 'e', access: 'read-write' }] })).deleteEnvironment, ['e']);
    assert.deepEqual(planSharingMirror(state({ environment: [{ shareId: 'o', access: 'read-write' }] }), state()).createEnvironment, ['read-write']);
  });
});

describe('sameSharing', () => {
  it('ignores share ids and owner, compares everything else', () => {
    const a = state({ owner: 'x', direct: [{ shareId: '1', access: 'read', recipients: [{ id: 'g', type: 'group' }] }] });
    const b = state({ owner: 'y', direct: [{ shareId: '2', access: 'read', recipients: [{ id: 'g', type: 'group' }] }] });
    assert.equal(sameSharing(a, b), true);
    assert.equal(sameSharing(a, { ...b, isPrivate: false }), false);
    assert.equal(sameSharing(a, { ...b, isReshareable: false }), false);
  });

  it('treats a share with no recipients as no share', () => {
    assert.equal(sameSharing(state(), state({ direct: [{ shareId: 'e', access: 'read-write', recipients: [] }] })), true);
  });

  it('applying a plan yields equal sharing', () => {
    const apply = (copy: SharingState, p: ReturnType<typeof planSharingMirror>): SharingState => ({
      ...copy,
      ...(p.flags ?? {}),
      direct: copy.direct
        .filter((d) => !p.deleteDirect.includes(d.shareId))
        .map((d) => ({
          ...d,
          recipients: d.recipients
            .filter((r) => !p.removeRecipients.some((x) => x.shareId === d.shareId && x.ids.includes(r.id)))
            .concat(p.addRecipients.filter((x) => x.shareId === d.shareId).flatMap((x) => x.recipients)),
        }))
        .concat(p.createDirect.map((d, i) => ({ shareId: `n${i}`, ...d }))),
      environment: copy.environment.filter((e) => !p.deleteEnvironment.includes(e.shareId)).concat(p.createEnvironment.map((a, i) => ({ shareId: `ne${i}`, access: a }))),
    });
    const cases: Array<[SharingState, SharingState]> = [
      [
        state({ isPrivate: false, environment: [{ shareId: 'e', access: 'read' }] }),
        state({ direct: [{ shareId: 'c', access: 'read-write', recipients: [{ id: 'g', type: 'group' }] }] }),
      ],
      [
        state({ direct: [
          { shareId: 'o1', access: 'read-write', recipients: [{ id: 'u1', type: 'user' }, { id: 'u2', type: 'user' }] },
          { shareId: 'o2', access: 'read', recipients: [{ id: 'u3', type: 'user' }] },
        ] }),
        state({ direct: [{ shareId: 'c', access: 'read-write', recipients: [{ id: 'g', type: 'group' }, { id: 'u2', type: 'user' }] }] }),
      ],
    ];
    for (const [original, copy] of cases) assert.equal(sameSharing(original, apply(copy, planSharingMirror(original, copy))), true);
  });
});

describe('describeSharing', () => {
  it('summarises in one line', () => {
    assert.equal(describeSharing(state()), 'private; reshareable');
  });
});
