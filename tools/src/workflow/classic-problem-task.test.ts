import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildClassicProblemDetails as fromModule } from '../lib/classic-problem.ts';
import {
  buildClassicProblemDetails as fromTask,
  classicStatus,
  parseTag,
  buildEntityTags,
} from './classic-problem-task.js';

/**
 * The plain-JS file is what actually runs inside the workflow; the TS module is
 * the reference implementation. Nothing enforces that they agree except this —
 * so it runs both over the SAME real tenant record and compares the output.
 */
const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, '..', 'lib', '__fixtures__', 'davis-problem-aws.json'), 'utf8')
) as { problem: Record<string, unknown>; event: Record<string, unknown> };

const ENTITIES = [{ applicationci: 'bbp', env: 'qa', ARN: 'arn:aws:x', entity_name: 'k8s-bbpeksup-upgrades' }];

describe('workflow task matches the reference implementation', () => {
  it('produces byte-identical output on a real problem record', () => {
    const input = { problem: fixture.problem as never, events: [fixture.event as never], entities: ENTITIES };
    assert.deepEqual(fromTask(input), fromModule(input));
  });

  it('agrees on an empty record too — the degenerate case is where they drift', () => {
    assert.deepEqual(fromTask({ problem: {} }), fromModule({ problem: {} }));
  });

  it('agrees when tag arrays are null, which is what these problems carry', () => {
    const problem = { ...(fixture.problem as object), entity_tags: null, primary_tags: null } as never;
    assert.deepEqual(fromTask({ problem, entities: [] }), fromModule({ problem, entities: [] }));
  });
});

describe('workflow task — behaviour that keeps an alert from being lost', () => {
  it('closes on a RECOVERED transition so BigPanda can resolve the alert', () => {
    assert.equal(classicStatus({ 'event.status': 'ACTIVE', 'event.status_transition': 'RECOVERED' }), 'CLOSED');
  });

  it('splits a tag on the FIRST colon — real values contain colons', () => {
    assert.equal(parseTag('RiskDataClass:Moderate:Internal')!.value, 'Moderate:Internal');
  });

  it('treats null tag arrays as empty instead of throwing', () => {
    // This is the Jinja bug that motivated moving the work into JS:
    // `null | default([])` stays null in Jinja, and `list + null` raises.
    assert.deepEqual(buildEntityTags([], null), []);
    assert.deepEqual(buildEntityTags(null, null), []);
  });

  it('never throws on a bare problem record', () => {
    assert.doesNotThrow(() => fromTask({ problem: {} }));
    assert.equal(fromTask({ problem: {} }).status, 'OPEN');
  });
});
