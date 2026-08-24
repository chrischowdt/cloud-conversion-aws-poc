import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractAwsTagPredicates,
  mzFilterExpression,
  tagDimension,
  buildMzIndex,
} from './mz-tags.ts';
import { translateSelector } from './classic-selector-translator.ts';
import { parseSelector } from './classic-selector-parser.ts';

/** Shape mirrors a real builtin:management-zones value (trimmed). */
const CPN_QA = {
  name: 'CPN : PSS SEATS INVENTORY : QA',
  rules: [
    // metric-dimension rule for a DIFFERENT data source — must be ignored
    {
      enabled: true,
      type: 'DIMENSION',
      dimensionRule: {
        appliesTo: 'METRIC',
        conditions: [
          { conditionType: 'DIMENSION', key: 'environment', ruleMatcher: 'EQUALS', value: 'qa' },
          { conditionType: 'METRIC_KEY', ruleMatcher: 'BEGINS_WITH', value: 'fluentd' },
        ],
      },
    },
    // non-AWS selector — ignored (no [AWS] tags)
    { enabled: true, type: 'SELECTOR', entitySelector: 'type("SERVICE"),entityName.startsWith("cpn-")' },
    // AWS selectors — the signal
    { enabled: true, type: 'SELECTOR', entitySelector: 'type("HOST"),tag("[AWS]ApplicationCI:cpn"),tag("[AWS]env:qa")' },
    { enabled: true, type: 'SELECTOR', entitySelector: 'type(AWS_LAMBDA_FUNCTION),tag("[AWS]ApplicationCI:cpn"),tag("[AWS]env:qa")' },
    // ME rule on an AWS entity type — also the signal, different shape
    {
      enabled: true,
      type: 'ME',
      attributeRule: {
        entityType: 'AWS_NETWORK_LOAD_BALANCER',
        conditions: [
          { key: 'AWS_NETWORK_LOAD_BALANCER_TAGS', operator: 'EQUALS', tag: 'env:qa' },
          { key: 'AWS_NETWORK_LOAD_BALANCER_TAGS', operator: 'EQUALS', tag: 'applicationci:cpn' },
        ],
      },
    },
  ],
};

describe('extractAwsTagPredicates', () => {
  it('reduces a template-generated zone to its AWS tag pair', () => {
    const preds = extractAwsTagPredicates(CPN_QA);
    const asMap = Object.fromEntries(preds.map((p) => [p.key.toLowerCase(), p.value]));
    assert.deepEqual(asMap, { applicationci: 'cpn', env: 'qa' });
  });

  it('ignores DIMENSION rules and non-AWS selectors', () => {
    const preds = extractAwsTagPredicates(CPN_QA);
    // `environment` (the fluentd DIMENSION rule) must not leak in
    assert.ok(!preds.some((p) => p.key.toLowerCase() === 'environment'));
  });

  it('skips disabled rules', () => {
    const zone = { rules: [{ enabled: false, type: 'SELECTOR', entitySelector: 'type(HOST),tag("[AWS]env:prod")' }] };
    assert.deepEqual(extractAwsTagPredicates(zone), []);
  });

  it('bails when a tag key resolves to conflicting values (union, not equality)', () => {
    const zone = {
      rules: [
        { enabled: true, type: 'SELECTOR', entitySelector: 'type(HOST),tag("[AWS]env:qa")' },
        { enabled: true, type: 'SELECTOR', entitySelector: 'type(HOST),tag("[AWS]env:prod")' },
      ],
    };
    assert.deepEqual(extractAwsTagPredicates(zone), [], 'ambiguous zone must not be reduced');
  });

  it('returns nothing for a zone with no AWS rules', () => {
    assert.deepEqual(extractAwsTagPredicates({ rules: [{ enabled: true, type: 'SELECTOR', entitySelector: 'type(SERVICE)' }] }), []);
  });
});

describe('tagDimension / mzFilterExpression', () => {
  it('lowercases the tag key onto the enriched metric dimension', () => {
    assert.equal(tagDimension('ApplicationCI'), 'aws.tags.applicationci');
  });
  it('renders a backticked equality filter', () => {
    const f = mzFilterExpression([{ key: 'ApplicationCI', value: 'cpn' }, { key: 'env', value: 'qa' }]);
    assert.equal(f, '`aws.tags.applicationci` == "cpn" and `aws.tags.env` == "qa"');
  });
});

describe('mzName translation through the selector translator', () => {
  const idx = buildMzIndex({ zones: [{ name: 'CPN : PSS SEATS INVENTORY : QA', tags: [{ key: 'ApplicationCI', value: 'cpn' }, { key: 'env', value: 'qa' }] }] });

  it('translates mzName() to a native dimension filter when the zone is known', () => {
    const ast = parseSelector('type(CUSTOM_DEVICE),mzName("CPN : PSS SEATS INVENTORY : QA")');
    const t = translateSelector(ast, 'dt.smartscape.aws_rds_dbinstance', { defaultTagContext: 'aws', mzTags: idx });
    assert.equal(t.complete, true);
    assert.equal(t.filter, '`aws.tags.applicationci` == "cpn" and `aws.tags.env` == "qa"');
    // dimension filter, not an entity lookup
    assert.ok(!t.filter.includes('getNodeField('));
  });

  it('leaves an UNKNOWN zone untranslated so the panel keeps blocking', () => {
    const ast = parseSelector('type(CUSTOM_DEVICE),mzName("Some Other Zone")');
    const t = translateSelector(ast, 'dt.smartscape.aws_rds_dbinstance', { defaultTagContext: 'aws', mzTags: idx });
    assert.equal(t.complete, false, 'must not silently narrow an alert to nothing');
    assert.equal(t.filter, '');
  });

  it('without an index at all, behaviour is unchanged (still untranslated)', () => {
    const ast = parseSelector('type(CUSTOM_DEVICE),mzName("CPN : PSS SEATS INVENTORY : QA")');
    const t = translateSelector(ast, 'dt.smartscape.aws_rds_dbinstance', { defaultTagContext: 'aws' });
    assert.equal(t.complete, false);
  });
});

describe('mzName rewrite is withheld when the metric did not convert', () => {
  it('leaves the selector classic if the metric key is unknown', async () => {
    // A classic metric carries no `aws.tags.*` dimension, so emitting the
    // zone's tag filter against it would return nothing and silently collapse
    // the alert's scope. Verified on tenant: classic kafka key returns data
    // unfiltered, zero rows with the tag filter applied.
    const { rewriteDql } = await import('./dql-rewriter.ts');
    const idx = buildMzIndex({
      zones: [{ name: 'Z', tags: [{ key: 'ApplicationCI', value: 'cpn' }] }],
    });
    const index = {
      byClassicId: new Map(),
      byDqlClassicKey: new Map(),
      mzTags: idx,
    } as any;
    const q =
      'timeseries v=avg(cloud.aws.kafka.some_unmapped_metric_by_topic,' +
      'filter:{in(dt.entity.custom_device,classicEntitySelector("type(CUSTOM_DEVICE),mzName(\\"Z\\")"))})';
    const r = rewriteDql(q, index);
    assert.ok(r.warnings.some((w) => w.kind === 'unknown-metric'), 'metric should be unknown');
    assert.ok(!r.rewritten.includes('aws.tags.'), 'must NOT emit a dimension filter on a classic metric');
  });
});
