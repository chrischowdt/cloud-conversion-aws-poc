import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildClassicProblemDetails,
  buildEntityTags,
  buildAffectedEntities,
  classicStatus,
  classicTypeFromId,
  parseTag,
  toEpochMillis,
  type DavisProblemRecord,
  type DavisEventRecord,
} from './classic-problem.ts';

/**
 * Shaped from a real nic55601 problem. The null-heavy fields are not laziness —
 * `entity_tags`, `primary_tags`, `smartscape.affected_entity.names` and
 * `root_cause_entity_name` are ALL null on the AWS problems this runs against,
 * and the classic entity is the environment fallback.
 */
const PROBLEM: DavisProblemRecord = {
  'event.id': '-1035732575302979006_1789167300000V2',
  display_id: 'P-26091310801',
  'event.name': 'Amazon ApplicationELB TargetResponseTime [AWS] [Standard]',
  'event.category': 'CUSTOM_ALERT',
  'event.status': 'CLOSED',
  'event.status_transition': 'CLOSED',
  'event.start': '2026-09-11T23:07:00.000000000Z',
  'event.end': '2026-09-11T23:22:00.000000000Z',
  'dt.davis.impact_level': ['Infrastructure'],
  'dt.davis.event_ids': ['-1035732575302979006_1789167300000'],
  affected_entity_ids: ['ENVIRONMENT-0000000000000001'],
  affected_entity_names: ['United Lower Environments'],
  'smartscape.affected_entity.ids': ['AWS_ELASTICLOADBALANCINGV2_LOADBALANCER-4E8D175F77D1F07C'],
  'smartscape.affected_entity.types': ['AWS_ELASTICLOADBALANCINGV2_LOADBALANCER'],
  'labels.alerting_profile': ['Default'],
  'maintenance.is_under_maintenance': false,
  entity_tags: null,
  primary_tags: null,
  root_cause_entity_name: null,
};

const EVENT: DavisEventRecord = {
  'event.id': '-1035732575302979006_1789167300000',
  'event.name': 'Amazon ApplicationELB TargetResponseTime [AWS] [Standard]',
  'event.type': 'CUSTOM_ALERT',
  'event.status': 'CLOSED',
  'event.start': '2026-09-11T22:55:00.000000000Z',
  'event.end': '2026-09-11T23:22:00.000000000Z',
  'dt.event.correlation_id': 'db8c0f8814701fcdecd1b3b3bedc9907',
  'dt.davis.is_rootcause_relevant': true,
  'dt.smartscape_source.id': 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER-4E8D175F77D1F07C',
  'dt.smartscape_source.type': 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER',
  'dt.settings.object_id': 'vu9U3hXa3q0AAAABAB9idWlsdGlu',
  'dt.settings.schema_id': 'builtin:davis.anomaly-detectors',
  'dt.query': 'timeseries avg(cloud.aws.applicationelb.TargetResponseTime.By.LoadBalancer)',
  'event.provider': 'METRIC_EVENTS',
  'maintenance.is_under_maintenance': false,
};

const ENTITIES = [
  { applicationci: 'bbp', env: 'qa', ARN: 'arn:aws:elasticloadbalancing:us-east-1:313566431123:loadbalancer/app/x', entity_name: 'k8s-bbpeksup-upgrades-d748863ce2' },
];

describe('toEpochMillis / classicTypeFromId', () => {
  it('converts Grail ISO timestamps to the epoch millis classic uses', () => {
    assert.equal(toEpochMillis('2026-09-11T23:07:00.000000000Z'), Date.parse('2026-09-11T23:07:00Z'));
  });
  it('returns null rather than NaN for missing or unparseable times', () => {
    assert.equal(toEpochMillis(null), null);
    assert.equal(toEpochMillis('not a date'), null);
  });
  it('recovers the classic type from an entity id', () => {
    assert.equal(classicTypeFromId('ENVIRONMENT-0000000000000001'), 'ENVIRONMENT');
    assert.equal(classicTypeFromId('AWS_MSK_CLUSTER-739B99B8074B7E74'), 'AWS_MSK_CLUSTER');
  });
});

describe('classicStatus', () => {
  it('maps an open problem to OPEN', () => {
    assert.equal(classicStatus({ 'event.status': 'OPEN' }), 'OPEN');
  });
  it('maps CLOSED to CLOSED so the receiving system can resolve the alert', () => {
    assert.equal(classicStatus(PROBLEM), 'CLOSED');
  });
  it('treats a RECOVERED transition as closed', () => {
    // The closing event carries status_transition=RECOVERED; classic only knows
    // OPEN/CLOSED, and an alert that never closes is worse than no alert.
    assert.equal(classicStatus({ 'event.status': 'ACTIVE', 'event.status_transition': 'RECOVERED' }), 'CLOSED');
  });
  it('defaults to OPEN when the record says nothing', () => {
    assert.equal(classicStatus({}), 'OPEN');
  });
});

describe('parseTag', () => {
  it('parses a contextless key:value tag', () => {
    assert.deepEqual(parseTag('applicationci:ccl'), {
      context: 'CONTEXTLESS', key: 'applicationci', value: 'ccl', stringRepresentation: 'applicationci:ccl',
    });
  });
  it('lifts a [AWS] context prefix out of the key', () => {
    const t = parseTag('[AWS]env:stg')!;
    assert.equal(t.context, 'AWS');
    assert.equal(t.key, 'env');
    assert.equal(t.value, 'stg');
  });
  it('splits on the FIRST colon only — tag values contain colons', () => {
    // Real tenant value: RiskDataClass = "Moderate:Internal".
    const t = parseTag('RiskDataClass:Moderate:Internal')!;
    assert.equal(t.key, 'RiskDataClass');
    assert.equal(t.value, 'Moderate:Internal');
  });
  it('handles a valueless tag and rejects empty input', () => {
    assert.equal(parseTag('justakey')!.value, undefined);
    assert.equal(parseTag('   '), null);
  });
});

describe('buildEntityTags', () => {
  it('turns the Smartscape lookup into classic tag objects', () => {
    const tags = buildEntityTags(ENTITIES);
    assert.deepEqual(tags.map((t) => t.stringRepresentation), ['applicationci:bbp', 'env:qa']);
  });
  it('de-duplicates across the lookup and the event tags', () => {
    const tags = buildEntityTags(ENTITIES, ['applicationci:bbp', '[AWS]env:qa']);
    // same key+value contextlessly is a dupe; the [AWS] one is a different context
    assert.equal(tags.filter((t) => t.key === 'applicationci').length, 1);
    assert.equal(tags.filter((t) => t.key === 'env').length, 2);
  });
  it('survives the null tag arrays these problems actually carry', () => {
    assert.deepEqual(buildEntityTags([], [null, undefined, '']), []);
    assert.deepEqual(buildEntityTags(undefined as never), []);
  });
});

describe('buildAffectedEntities', () => {
  it('puts the SMARTSCAPE entity here by default — BigPanda reads this field', () => {
    // The classic value is ENVIRONMENT-0000000000000001 for every migrated AWS
    // alert, which would collapse all of them onto one entity in BigPanda's
    // event metadata. The id and type below are real Smartscape identifiers,
    // not invented ones; only the field they sit in is non-classic.
    const out = buildAffectedEntities(PROBLEM, ENTITIES);
    assert.deepEqual(out, [
      {
        entityId: {
          id: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER-4E8D175F77D1F07C',
          type: 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER',
        },
        name: 'k8s-bbpeksup-upgrades-d748863ce2',
      },
    ]);
  });

  it('restores strict classic passthrough when asked', () => {
    // For when BigPanda can read the entity off the evidence entry instead.
    const out = buildAffectedEntities(PROBLEM, ENTITIES, false);
    assert.equal(out[0]!.entityId.id, 'ENVIRONMENT-0000000000000001');
    assert.equal(out[0]!.name, 'United Lower Environments');
  });

  it('falls back to the classic entity when there is no Smartscape one', () => {
    const noSs = { ...PROBLEM, 'smartscape.affected_entities': null, 'smartscape.affected_entity.ids': null };
    assert.equal(buildAffectedEntities(noSs, []) [0]!.entityId.id, 'ENVIRONMENT-0000000000000001');
  });

  it('uses the parallel id/type arrays when the object form is absent', () => {
    const arraysOnly = { ...PROBLEM, 'smartscape.affected_entities': null };
    const out = buildAffectedEntities(arraysOnly, ENTITIES);
    assert.equal(out[0]!.entityId.type, 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER');
  });

  it('returns an empty array when there is nothing to report', () => {
    assert.deepEqual(buildAffectedEntities({}, []), []);
  });
});

describe('buildClassicProblemDetails', () => {
  const out = buildClassicProblemDetails({ problem: PROBLEM, events: [EVENT], entities: ENTITIES });

  it('fills the problem envelope from Grail', () => {
    assert.equal(out.problemId, '-1035732575302979006_1789167300000V2');
    assert.equal(out.displayId, 'P-26091310801');
    assert.equal(out.status, 'CLOSED');
    assert.equal(out.severityLevel, 'CUSTOM_ALERT');
    assert.equal(out.impactLevel, 'Infrastructure');
    assert.equal(out.startTime, Date.parse('2026-09-11T23:07:00Z'));
  });

  it('builds one evidence entry per underlying Davis event', () => {
    assert.equal(out.evidenceDetails.totalCount, 1);
    const d = out.evidenceDetails.details[0]!;
    assert.equal(d.eventId, '-1035732575302979006_1789167300000');
    assert.equal(d.rootCauseRelevant, true);
    assert.equal(d.entity!.entityId.id, 'AWS_ELASTICLOADBALANCINGV2_LOADBALANCER-4E8D175F77D1F07C');
    assert.equal(d.entity!.name, 'k8s-bbpeksup-upgrades-d748863ce2');
  });

  it('carries the firing query and detector config, which classic never had', () => {
    const data = out.evidenceDetails.details[0]!.data;
    assert.match(String(data['dqlQuery']), /cloud\.aws\.applicationelb\.TargetResponseTime/);
    assert.equal(data['settingsSchemaId'], 'builtin:davis.anomaly-detectors');
    assert.equal(data['correlationId'], 'db8c0f8814701fcdecd1b3b3bedc9907');
  });

  it('never throws on a bare record — losing the alert is worse than a thin one', () => {
    const thin = buildClassicProblemDetails({ problem: {} });
    assert.equal(thin.status, 'OPEN');
    assert.deepEqual(thin.affectedEntities, []);
    assert.deepEqual(thin.entityTags, []);
    assert.equal(thin.evidenceDetails.totalCount, 0);
    assert.equal(thin.problemId, null);
  });

  it('produces JSON-serialisable output', () => {
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(out)));
  });
});
