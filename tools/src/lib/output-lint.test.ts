import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { lintQuery, lintAsset, summarize, liveQuery } from './output-lint.ts';

const ids = (q: string) => lintQuery(q).map((f) => f.ruleId);

describe('output-lint — shapes proven to return nothing', () => {
  it('blocks an AWS tag read on a Smartscape SERVICE', () => {
    // 0 of 24,426 SERVICE nodes carry a non-null tags:aws. This exact form is
    // live in 3 published dashboards.
    assert.ok(
      ids('timeseries v=avg(dt.service.request.response_time, filter:{ getNodeField(dt.smartscape.service, "tags:aws")[applicationci] == "cuw" })')
        .includes('service-tags-null')
    );
  });

  it('blocks a Smartscape dim handed to classicEntitySelector', () => {
    assert.ok(
      ids('timeseries v=avg(m, filter:{ in(dt.smartscape.service, classicEntitySelector("type(service),tag(\\"a:b\\")")) })')
        .includes('classic-selector-smartscape-dim')
    );
  });

  it('blocks a classic relationship projection with a Smartscape dim', () => {
    // Verified live: DQL 400 FIELD_DOES_NOT_EXIST.
    assert.ok(
      ids('fetch dt.entity.custom_device | fieldsAdd c = accessible_by[dt.smartscape.aws_credentials][0]')
        .includes('classic-relationship-smartscape-dim')
    );
  });

  it('blocks a record handed to a string function', () => {
    assert.ok(
      ids('smartscapeNodes AWS_ECS_CLUSTER | filter matchesPhrase(tags, "*fap*")')
        .includes('record-passed-to-string-function')
    );
    // …and accepts the wrapped form.
    assert.ok(
      !ids('smartscapeNodes AWS_ECS_CLUSTER | filter matchesPhrase(toString(tags), "*fap*")')
        .includes('record-passed-to-string-function')
    );
  });

  it('blocks the emr_ec2 namespace the connection never emits', () => {
    assert.ok(ids('timeseries v=avg(`cloud.aws.emr_ec2.HDFSUtilization.By.JobFlowId`)').includes('emr-ec2-namespace'));
  });

  it('blocks a padded literal given to the ~ match operator', () => {
    // `~` matches, it does not test substrings: the padded form returned 0 rows
    // where the trimmed form returned 1.
    assert.ok(ids('filter getNodeField(dt.smartscape.service, "name") ~ " United.Mobile.Api"').includes('match-operator-padded-literal'));
    assert.ok(!ids('filter getNodeField(dt.smartscape.service, "name") ~ "United.Mobile.Api"').includes('match-operator-padded-literal'));
  });
});

describe('output-lint — advisories, not blockers', () => {
  it('flags a Smartscape name filter as a semantics change', () => {
    const f = lintQuery('filter contains(getNodeField(dt.smartscape.service, "name"), "United")');
    const hit = f.find((x) => x.ruleId === 'smartscape-name-semantics');
    assert.ok(hit);
    // Advisory: it may well be correct — the names simply differ between models.
    assert.equal(hit!.severity, 'advisory');
  });

  it('flags an unconverted Metric Streams key without blocking it', () => {
    const f = lintQuery('timeseries v=avg(cloud.aws.kafka.maxOffsetLagByAccountIdClusterNameRegion)');
    assert.equal(f.find((x) => x.ruleId === 'metric-streams-left-unconverted')!.severity, 'advisory');
  });
});

describe('output-lint — does not fire on correct output', () => {
  it('accepts the verified service tag and name forms', () => {
    assert.deepEqual(ids('timeseries v=avg(m, filter:{ in("applicationci:cuw", entityAttr(dt.entity.service, "tags")) })'), []);
    assert.deepEqual(ids('timeseries v=avg(m, filter:{ contains(entityName(dt.entity.service), "United", caseSensitive: false) })'), []);
  });

  it('accepts a converted AWS metric query', () => {
    assert.deepEqual(
      ids('timeseries v=avg(`cloud.aws.kafka.MaxOffsetLag.By.Cluster_Name.Topic`), by:{`Cluster Name`, Topic}'),
      []
    );
  });
});

describe('output-lint — mechanics', () => {
  it('lints what RUNS, not the [CCT-ORIGINAL] reference comment', () => {
    // Staged copies carry the classic query as a `//` block. Linting that would
    // flag every asset for constructs it no longer executes.
    const q = '// getNodeField(dt.smartscape.service, "tags:aws")[x] == "y"\ntimeseries v=avg(m)';
    assert.deepEqual(ids(q), []);
    assert.match(liveQuery(q), /^timeseries/);
  });

  it('walks an asset and reports where each finding lives', () => {
    const asset = { tiles: { '7': { query: 'filter getNodeField(dt.smartscape.service, "tags:aws")[a] == "b"' } } };
    const f = lintAsset(asset);
    assert.equal(f.length, 1);
    assert.match(f[0]!.location, /7/);
  });

  it('separates blocking from advisory in the summary', () => {
    const f = lintAsset({
      a: { query: 'filter getNodeField(dt.smartscape.service, "tags:aws")[a] == "b"' },
      b: { query: 'timeseries v=avg(cloud.aws.kafka.fooByAccountIdRegion)' },
    });
    const s = summarize(f);
    assert.equal(s.blocking, 1);
    assert.equal(s.advisory, 1);
  });
});

describe('output-lint — ignores code the engine never runs', () => {
  it('skips constructs parked inside a /* … */ block', () => {
    // Reviewers keep an old version of a query in a block comment. Flagging it
    // trains people to ignore the lint.
    const q = '/* filter getNodeField(dt.smartscape.service, "tags:aws")[a] == "b" */\ntimeseries v=avg(m)';
    assert.deepEqual(lintQuery(q).map((f) => f.ruleId), []);
  });

  it('still flags the same construct when it is live', () => {
    const q = '/* an old note */\nfilter getNodeField(dt.smartscape.service, "tags:aws")[a] == "b"';
    assert.ok(lintQuery(q).some((f) => f.ruleId === 'service-tags-null'));
  });
});
