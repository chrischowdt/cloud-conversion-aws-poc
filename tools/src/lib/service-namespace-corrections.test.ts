import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { correctServiceNamespace, SERVICE_NS_CORRECTIONS } from './service-namespace-corrections.ts';

describe('correctServiceNamespace', () => {
  it('rewrites each recommended namespace to its autodiscovered form', () => {
    assert.equal(
      correctServiceNamespace('cloud.aws.emr_ec2.HDFSBytesRead.By.JobFlowId'),
      'cloud.aws.elasticmapreduce.HDFSBytesRead.By.JobFlowId'
    );
    assert.equal(
      correctServiceNamespace('cloud.aws.opensearch_domain.SearchableDocuments.By.ClientId'),
      'cloud.aws.es.SearchableDocuments.By.ClientId'
    );
    assert.equal(
      correctServiceNamespace('cloud.aws.kafka_connect.x.By.y'),
      'cloud.aws.kafkaconnect.x.By.y'
    );
  });

  it('only touches the service segment, keeps metric + dims intact', () => {
    const out = correctServiceNamespace('cloud.aws.kinesisdatastreams.GetRecords.Latency.By.StreamName');
    assert.equal(out, 'cloud.aws.kinesis.GetRecords.Latency.By.StreamName');
  });

  it('handles builtin:/ext:/dt. prefixes', () => {
    assert.equal(correctServiceNamespace('ext:cloud.aws.flink.x.By.y'), 'ext:cloud.aws.kinesisanalytics.x.By.y');
    assert.equal(correctServiceNamespace('dt.cloud.aws.emr_serverless.x'), 'dt.cloud.aws.emrserverless.x');
  });

  it('is a no-op for uncorrected services and non-matches', () => {
    assert.equal(correctServiceNamespace('cloud.aws.lambda.Invocations.By.FunctionName'), 'cloud.aws.lambda.Invocations.By.FunctionName');
    assert.equal(correctServiceNamespace('cloud.aws.dynamodb.ConsumedReadCapacityUnits.By.TableName'), 'cloud.aws.dynamodb.ConsumedReadCapacityUnits.By.TableName');
    assert.equal(correctServiceNamespace(''), '');
    assert.equal(correctServiceNamespace(null), null);
    assert.equal(correctServiceNamespace(undefined), undefined);
  });

  it('does not match a service name as a substring (must be a full segment)', () => {
    // `flinkfoo` is not `flink` — the trailing `.` boundary must hold.
    assert.equal(correctServiceNamespace('cloud.aws.flinkfoo.x.By.y'), 'cloud.aws.flinkfoo.x.By.y');
  });

  it('covers all 12 documented corrections', () => {
    assert.equal(Object.keys(SERVICE_NS_CORRECTIONS).length, 12);
  });
});
