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

  it('applying a plan yields equal sharing', () => {
    const original = state({ isPrivate: false, environment: [{ shareId: 'e', access: 'read' }] });
    const copy = state({ direct: [{ shareId: 'c', access: 'read-write', recipients: [{ id: 'g', type: 'group' }] }] });
    const p = planSharingMirror(original, copy);
    const after: typeof copy = {
      ...copy,
      ...(p.flags ?? {}),
      direct: copy.direct.filter((d) => !p.deleteDirect.includes(d.shareId)).concat(p.createDirect.map((d, i) => ({ shareId: `n${i}`, ...d }))),
      environment: copy.environment.filter((e) => !p.deleteEnvironment.includes(e.shareId)).concat(p.createEnvironment.map((a, i) => ({ shareId: `ne${i}`, access: a }))),
    };
    assert.equal(sameSharing(original, after), true);
  });
});

describe('describeSharing', () => {
  it('summarises in one line', () => {
    assert.equal(describeSharing(state()), 'private; reshareable');
  });
});
