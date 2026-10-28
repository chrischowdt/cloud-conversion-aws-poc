import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { applySourceBinding, bindingCandidate, bindsAnEntity, DAVIS_SERIES_CAP, emittedEntityColumn, resolveBinding, SOURCE_ID_BINDING } from './detector-binding.ts';
import type { DetectorRewriteResult } from './detector-rewrite.ts';

// The batch-09 shape a reviewer fixed by hand (CCL MSK OfflinePartitionsCount).
const MSK =
  'timeseries v = avg(cloud.aws.kafka.OfflinePartitionsCount.By.Cluster_Name), by:{aws.account.id, aws.region, `Cluster Name`}\n' +
  '| filter matchesValue(`Cluster Name`, "ccl-msk-cluster")';

describe('bindingCandidate', () => {
  it('adds the series entity next to enriched and spaced dims', () => {
    const c = bindingCandidate(MSK);
    assert.ok(c.ok);
    assert.match(c.query, /by:\{aws\.account\.id, aws\.region, `Cluster Name`, dt\.smartscape_source\.id\}/);
    assert.match(c.query, /\| filter matchesValue\(`Cluster Name`, "ccl-msk-cluster"\)$/);
  });

  it('adds a split when the query has none', () => {
    const q = 'timeseries v = max(cloud.aws.es.AutomatedSnapshotFailure.By.ClientId.DomainName), filter: in(aws.arn, array("arn:x"))';
    const c = bindingCandidate(q);
    assert.ok(c.ok);
    assert.equal(c.query, `${q}, by:{dt.smartscape_source.id}`);
  });

  it('keeps a trailing comment after the new split', () => {
    const q = 'timeseries v = sum(cloud.aws.sqs.NumberOfMessagesSent.By.QueueName) // per account\n';
    const c = bindingCandidate(q);
    assert.ok(c.ok);
    assert.equal(c.query, 'timeseries v = sum(cloud.aws.sqs.NumberOfMessagesSent.By.QueueName), by:{dt.smartscape_source.id} // per account\n');
  });

  it('leaves queries that already split by an entity', () => {
    assert.equal(bindsAnEntity('timeseries v = avg(cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier), by:{dt.smartscape.aws_rds_dbinstance}'), true);
    assert.equal(bindsAnEntity('timeseries v = avg(cloud.aws.kafka.X.By.Cluster_Name), by:{dt.smartscape_source.id = dt.smartscape.aws_msk_cluster}'), true);
    assert.equal(bindingCandidate('timeseries v = avg(cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier), by:{dt.smartscape_source.id}').ok, false);
  });

  it('treats a node dim used only in a filter as unbound', () => {
    // The filter reads the node, but no entity column comes out of the split.
    const q = 'timeseries v = avg(cloud.aws.kafka.SumOffsetLag.By.Cluster_Name.Consumer_Group.Topic), by:{`Cluster Name`}, filter: contains(lower(getNodeName(dt.smartscape.aws_msk_cluster)), "cpn")';
    assert.equal(bindsAnEntity(q), false);
    assert.ok(bindingCandidate(q).ok);
  });

  it('refuses when a later command could regroup the dimension', () => {
    const q = 'timeseries v = sum(cloud.aws.lambda.Errors.By.FunctionName), by:{FunctionName} | summarize t = sum(arraySum(v))';
    const c = bindingCandidate(q);
    assert.equal(c.ok, false);
    assert.match((c as { reason: string }).reason, /summarize/);
  });

  it('refuses account-level services and classic keys', () => {
    assert.equal(bindingCandidate('timeseries v = sum(cloud.aws.usage.CallCount.By.Class.Resource.Service.Type)').ok, false);
    assert.equal(bindingCandidate('timeseries v = avg(cloud.aws.lambda.errors_sum)').ok, false);
  });

  it('lists the new column in a later fieldsKeep', () => {
    // The CWE MSK broker CPU alerts (Lower), which computed cpu = user + system.
    const q =
      'timeseries u = avg(cloud.aws.kafka.CpuUser.By.Broker_ID.Cluster_Name), s = avg(cloud.aws.kafka.CpuSystem.By.Broker_ID.Cluster_Name), by: { `Broker ID`, `Cluster Name` }, interval: 1m' +
      '     | fieldsAdd cpu = u[] + s[]     | fieldsKeep cpu, `Broker ID`, `Cluster Name`, timeframe, interval // per broker\n';
    const c = bindingCandidate(q);
    assert.ok(c.ok);
    assert.match(c.query, /by: \{ `Broker ID`, `Cluster Name`, dt\.smartscape_source\.id \}/);
    assert.match(c.query, /\| fieldsKeep cpu, `Broker ID`, `Cluster Name`, timeframe, interval, dt\.smartscape_source\.id \/\/ per broker\n$/);
  });

  it('allows a fieldsRemove that does not name the new column', () => {
    const q =
      'timeseries {c=sum(`cloud.aws.dynamodb.ConsumedWriteCapacityUnits.By.TableName`),p=sum(`cloud.aws.dynamodb.ProvisionedWriteCapacityUnits.By.TableName`)}' +
      '|fieldsAdd expression=(c[]/p[])*100|fieldsRemove p,c';
    const c = bindingCandidate(q);
    assert.ok(c.ok);
    assert.match(c.query, /ProvisionedWriteCapacityUnits\.By\.TableName`\)\}, by:\{dt\.smartscape_source\.id\}\|fieldsAdd/);
    assert.equal(bindingCandidate('timeseries v = sum(cloud.aws.sqs.NumberOfMessagesSent.By.QueueName) | fieldsRemove dt.smartscape_source.id').ok, false);
  });

  it('ignores a pipe inside a string', () => {
    const q = 'timeseries v = avg(cloud.aws.sqs.ApproximateAgeOfOldestMessage.By.QueueName), by:{QueueName} | filter matchesValue(QueueName, "a|b")';
    assert.ok(bindingCandidate(q).ok);
  });
});

describe('emittedEntityColumn', () => {
  it('names the alias, not the node dim it renames', () => {
    // DSC / UDH MSK alerts in Lower: property was {dt.smartscape.aws_msk_cluster}, a column the query never emits.
    const q =
      'timeseries v = avg(cloud.aws.kafka.CpuSystem.By.Broker_ID.Cluster_Name), by:{aws.region,\n  ClusterName = `Cluster Name`, // the name\n  dt.smartscape_source.id = dt.smartscape.aws_msk_cluster}';
    assert.equal(emittedEntityColumn(q, '{dt.smartscape.aws_msk_cluster}'), 'dt.smartscape_source.id');
  });

  it('finds a native source id with no property at all', () => {
    assert.equal(emittedEntityColumn('timeseries v = sum(cloud.aws.states.ExecutionsFailed.By.StateMachineArn), by:{Region = aws.region, StateMachineArn, dt.smartscape_source.id}'), 'dt.smartscape_source.id');
  });

  it('keeps a property that already names an emitted column, else prefers the node dim', () => {
    const q = 'timeseries v = avg(cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier), by:{dt.smartscape.aws_rds_dbinstance, dt.smartscape_source.id}';
    assert.equal(emittedEntityColumn(q, '{dt.smartscape_source.id}'), 'dt.smartscape_source.id');
    assert.equal(emittedEntityColumn(q), 'dt.smartscape.aws_rds_dbinstance');
  });

  it('returns nothing when the split emits no entity', () => {
    assert.equal(emittedEntityColumn(MSK), undefined);
    assert.equal(emittedEntityColumn('timeseries v = avg(cloud.aws.kafka.X.By.Cluster_Name), filter: isNotNull(dt.smartscape.aws_msk_cluster)'), undefined);
  });
});

describe('resolveBinding', () => {
  const counts = (m: Record<string, number>) => async (q: string) => (q.includes('dt.smartscape_source.id') ? m.after : m.before)!;

  it('binds when the series count is unchanged', async () => {
    const out = await resolveBinding(MSK, counts({ before: 4, after: 4 }));
    assert.equal(out.kind, 'bound');
    assert.match(out.note!, /4 series/);
  });

  it('binds an aggregating alert per resource and asks for a threshold check', async () => {
    // Reviewers chose per resource in all 3 such alerts in batches 01-10.
    const out = await resolveBinding(MSK, counts({ before: 1, after: 5 }));
    assert.equal(out.kind, 'per-entity');
    assert.match(out.query!, /dt\.smartscape_source\.id/);
    assert.match(out.note!, /1 series became 5/);
    assert.equal(out.warning?.kind, 'alert-per-entity');
    assert.match(out.warning!.text, /threshold/);
  });

  it('binds without data, flagged as unchecked', async () => {
    const out = await resolveBinding(MSK, counts({ before: 0, after: 0 }));
    assert.equal(out.kind, 'unverified');
    assert.ok(out.query);
    assert.equal(out.warning?.kind, 'alert-per-entity');
  });

  it('stays unbound past the Davis series limit', async () => {
    const out = await resolveBinding(MSK, counts({ before: 3, after: DAVIS_SERIES_CAP + 1 }));
    assert.equal(out.kind, 'too-many');
    assert.equal(out.query, undefined);
    assert.equal(out.warning?.kind, 'alert-unbound');
  });
});

describe('applySourceBinding', () => {
  const result = (props: Array<{ key: string; value: string }>, changes: DetectorRewriteResult['eventTemplateChanges'] = []): DetectorRewriteResult => ({
    changed: true,
    query: { original: 'x', rewritten: MSK, transforms: [], warnings: [] } as never,
    eventTemplateChanges: changes,
    thresholdAction: { kind: 'none', reason: '' },
    warnings: [],
    transforms: [],
    rewrittenValue: { analyzer: { input: [{ key: 'query', value: MSK }] }, eventTemplate: { properties: props } },
  });

  it('writes the query and the matching property', () => {
    const r = result([{ key: 'dt.source_entity', value: '{dims:dt.entity.custom_device}' }]);
    applySourceBinding(r, 'BOUND', 'note');
    assert.equal(r.query!.rewritten, 'BOUND');
    assert.equal((r.rewrittenValue.analyzer as any).input[0].value, 'BOUND');
    const props = (r.rewrittenValue.eventTemplate as any).properties;
    assert.deepEqual(props, [{ key: 'dt.smartscape_source.id', value: SOURCE_ID_BINDING }]);
    assert.equal(r.targetDim, 'dt.smartscape_source.id');
  });

  it('corrects a property that named a dim the query never emits, as one change', () => {
    const r = result(
      [{ key: 'dt.smartscape_source.id', value: '{dt.smartscape.aws_msk_cluster}' }],
      [{ field: 'dt.smartscape_source.id', before: '(absent)', after: '{dt.smartscape.aws_msk_cluster}' }],
    );
    applySourceBinding(r, 'BOUND', 'note');
    assert.deepEqual(r.eventTemplateChanges, [{ field: 'dt.smartscape_source.id', before: '(absent)', after: SOURCE_ID_BINDING }]);
  });
});
