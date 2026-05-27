/**
 * Convention check for AWS_ENTITY_MAPPINGS:
 *
 *   smartscapeDimension MUST equal `dt.smartscape.${smartscapeNodeType.toLowerCase()}`
 *
 * Verified empirically on the tenant 2026-05-12: every AWS smartscape series
 * dimension uses this exact convention. Drift in the table silently produces
 * `by:` clauses that the new metric series doesn't carry, collapsing real
 * groupings to a single null-keyed row — exactly the bug that motivated this
 * test (eCargo Lambda compare returned 1 row instead of ~2,500).
 *
 * `not-planned` and `ambiguous` entries with empty dims are skipped.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AWS_ENTITY_MAPPINGS } from './entity-mappings.ts';

describe('AWS_ENTITY_MAPPINGS — dim/node-type convention', () => {
  it('every populated smartscapeDimension matches dt.smartscape.<lowercase_node_type>', () => {
    const offenders: string[] = [];
    for (const m of AWS_ENTITY_MAPPINGS) {
      if (!m.smartscapeDimension || !m.smartscapeNodeType) continue; // skip not-planned
      const expected = `dt.smartscape.${m.smartscapeNodeType.toLowerCase()}`;
      if (m.smartscapeDimension !== expected) {
        offenders.push(
          `${m.classicEntityType}: dim='${m.smartscapeDimension}' but expected '${expected}'`
        );
      }
    }
    assert.equal(
      offenders.length,
      0,
      'smartscapeDimension drift detected:\n  ' + offenders.join('\n  ')
    );
  });

  it('not-planned entries have empty dim and node type', () => {
    for (const m of AWS_ENTITY_MAPPINGS) {
      if (m.status === 'not-planned') {
        assert.equal(m.smartscapeDimension, '', `${m.classicEntityType} should have empty dim`);
        assert.equal(m.smartscapeNodeType, '', `${m.classicEntityType} should have empty node type`);
      }
    }
  });
});
