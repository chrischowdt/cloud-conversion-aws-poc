import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PUBLISH_OVERRIDES, parsePublishOverride } from './decision-states.ts';

describe('parsePublishOverride', () => {
  it('maps each dropdown value to its override', () => {
    assert.equal(parsePublishOverride('Publish per resource'), 'per-resource');
    assert.equal(parsePublishOverride('Publish without entity'), 'without-entity');
  });

  it('tolerates case, surrounding space and trailing punctuation', () => {
    assert.equal(parsePublishOverride('  publish WITHOUT entity. '), 'without-entity');
    assert.equal(parsePublishOverride('PUBLISH PER RESOURCE;'), 'per-resource');
  });

  it('treats an empty or missing cell as no override', () => {
    assert.equal(parsePublishOverride(''), undefined);
    assert.equal(parsePublishOverride('   '), undefined);
    assert.equal(parsePublishOverride(undefined), undefined);
  });

  it('flags anything else as invalid rather than guessing', () => {
    assert.equal(parsePublishOverride('yes'), 'invalid');
    assert.equal(parsePublishOverride('Publish per'), 'invalid');
    assert.equal(parsePublishOverride('constructor'), 'invalid');
  });

  it('accepts every value the dropdown offers', () => {
    for (const v of PUBLISH_OVERRIDES) {
      assert.notEqual(parsePublishOverride(v), 'invalid', v);
      assert.notEqual(parsePublishOverride(v), undefined, v);
    }
  });
});
