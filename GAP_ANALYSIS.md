# AWS Classic → New Integration Gap Analysis

_Generated 2026-04-21 from `mappings/aws_mapping.json`._

## Summary

- Classic services mapped: **94**
- New support-matrix resource blocks: **172** (matched: **47**, new-only: **10**)
- Classic builtin metrics (the 9 `-builtin` pages, DT-curated `builtin:cloud.aws.*` keys): **92**
  - direct: 65, unit_conversion: 11, no_direct_equivalent: 16
- Classic raw-CloudWatch metric rows (all services): **3384** (of which 933 flagged Recommended)
  - direct: 530, dimension_change: 357, requires_custom_metric: 1869, no_new_coverage: 628

## Category definitions

Applied to the **builtin** metrics (9 DT-curated services):
- **direct** — classic `builtin:*` key maps 1:1 to a CloudWatch metric in the new integration; same unit.
- **unit_conversion** — the same CloudWatch metric exists but classic pre-normalises it (per-second rate, kB/s, %), so DQL must apply `rate:` or divide by the statistic period.
- **no_direct_equivalent** — classic metric is Dynatrace-computed (AZ/ASG rollups, ratios, utilisation %); rebuild from Smartscape or multi-metric DQL.

Applied to the **raw-CloudWatch** metric rows (every classic page):
- **direct** — the new integration's recommended-metrics list covers this CloudWatch name with the same (or superset) dimensions.
- **dimension_change** — the new integration exposes the same CloudWatch metric but under a different dimension combo; DQL filters need to be rewritten.
- **requires_custom_metric** — the CloudWatch metric is published by AWS and is in the classic page, but the new integration's recommended set omits it. Customer must enable **Recommended + custom** MCS and add it explicitly.
- **no_new_coverage** — the new integration has no support-matrix block matching this classic service at all.

## Per-service mapping

### DynamoDB (`dynamodb`)

- Classic entity: `cloud:aws:dynamodb` (dimension `TableName`)
- New block: `AWS::DynamoDB::Table` → Smartscape `AWS_DYNAMODB_TABLE`
- Namespaces: `AWS/DynamoDB`
- New recommended metrics: 28

**Built-in `builtin:cloud.aws.*` metrics**

| Classic metric | Unit | Category | CloudWatch name | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `builtin:cloud.aws.dynamo.capacityUnits.consumed.read` | Count | direct | `ConsumedReadCapacityUnits` | `cloud.aws.dynamodb.ConsumedReadCapacityUnits.By.TableName` | TableName |  |
| `builtin:cloud.aws.dynamo.capacityUnits.consumed.write` | Count | direct | `ConsumedWriteCapacityUnits` | `cloud.aws.dynamodb.ConsumedWriteCapacityUnits.By.TableName` | TableName |  |
| `builtin:cloud.aws.dynamo.capacityUnits.provisioned.read` | Count | direct | `ProvisionedReadCapacityUnits` | `cloud.aws.dynamodb.ProvisionedReadCapacityUnits.By.TableName` | TableName |  |
| `builtin:cloud.aws.dynamo.capacityUnits.provisioned.write` | Count | direct | `ProvisionedWriteCapacityUnits` | `cloud.aws.dynamodb.ProvisionedWriteCapacityUnits.By.TableName` | TableName |  |
| `builtin:cloud.aws.dynamo.capacityUnits.read` | Percent | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace utilisation % — rebuild: Consumed/Provisioned*100 |
| `builtin:cloud.aws.dynamo.capacityUnits.write` | Percent | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace utilisation % — rebuild: Consumed/Provisioned*100 |
| `builtin:cloud.aws.dynamo.errors.system` | Count | direct | `SystemErrors` | `cloud.aws.dynamodb.SystemErrors.By.TableName` | TableName |  |
| `builtin:cloud.aws.dynamo.errors.user` | Count | direct | `UserErrors` | _—_ | _—_ | CW metric exists in AWS but is not in the new integration's recommended-metrics list — enable recommended+custom MCS and add explicitly |
| `builtin:cloud.aws.dynamo.requests.latency` | MilliSecond | direct | `SuccessfulRequestLatency` | `cloud.aws.dynamodb.SuccessfulRequestLatency.By.TableName` | TableName |  |
| `builtin:cloud.aws.dynamo.requests.returnedItems` | Count | direct | `ReturnedItemCount` | `cloud.aws.dynamodb.ReturnedItemCount.By.TableName` | TableName |  |
| `builtin:cloud.aws.dynamo.requests.throttled` | Count | direct | `ThrottledRequests` | `cloud.aws.dynamodb.ThrottledRequests.By.TableName` | TableName |  |
| `builtin:cloud.aws.dynamo.throttledEvents.read` | Count | direct | `ReadThrottleEvents` | `cloud.aws.dynamodb.ReadThrottleEvents.By.TableName` | TableName |  |
| `builtin:cloud.aws.dynamo.throttledEvents.write` | Count | direct | `WriteThrottleEvents` | `cloud.aws.dynamodb.WriteThrottleEvents.By.TableName` | TableName |  |
| `builtin:cloud.aws.dynamo.tables` | Count | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace-computed table count per AZ — use smartscapeNodes "AWS_DYNAMODB_TABLE" |

### EC2 (`ec2`)

- Classic entity: `EC2_INSTANCE` (dimension `InstanceId`)
- New block: `AWS::EC2::Instance` → Smartscape `AWS_EC2_INSTANCE`
- Namespaces: `AWS/EC2`
- New recommended metrics: 30

**Built-in `builtin:cloud.aws.*` metrics**

| Classic metric | Unit | Category | CloudWatch name | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `builtin:cloud.aws.ec2.cpu.usage` | Percent | direct | `CPUUtilization` | `cloud.aws.ec2.CPUUtilization.By.InstanceId` | InstanceId | both Percent |
| `builtin:cloud.aws.ec2.disk.readOps` | PerSecond | unit_conversion | `DiskReadOps` | `cloud.aws.ec2.DiskReadOps.By.InstanceId` | InstanceId | classic is per-second rate; CW is count/period — apply rate: |
| `builtin:cloud.aws.ec2.disk.readRate` | KiloBytePerSecond | unit_conversion | `DiskReadBytes` | `cloud.aws.ec2.DiskReadBytes.By.InstanceId` | InstanceId | kB/s vs bytes/period — divide by period*1024 |
| `builtin:cloud.aws.ec2.disk.writeOps` | PerSecond | unit_conversion | `DiskWriteOps` | `cloud.aws.ec2.DiskWriteOps.By.InstanceId` | InstanceId | rate vs count/period |
| `builtin:cloud.aws.ec2.disk.writeRate` | KiloBytePerSecond | unit_conversion | `DiskWriteBytes` | `cloud.aws.ec2.DiskWriteBytes.By.InstanceId` | InstanceId | kB/s vs bytes/period |
| `builtin:cloud.aws.ec2.net.rx` | BytePerSecond | unit_conversion | `NetworkIn` | `cloud.aws.ec2.NetworkIn.By.InstanceId` | InstanceId | Byte/s vs bytes/period — divide by period |
| `builtin:cloud.aws.ec2.net.tx` | BytePerSecond | unit_conversion | `NetworkOut` | `cloud.aws.ec2.NetworkOut.By.InstanceId` | InstanceId | Byte/s vs bytes/period |
| `builtin:cloud.aws.az.running` | Count | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace AZ rollup — reconstruct via smartscapeNodes "AWS_EC2_INSTANCE" | filter state=="running" |
| `builtin:cloud.aws.az.stopped` | Count | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace AZ rollup — same pattern, filter state=="stopped" |
| `builtin:cloud.aws.az.terminated` | Count | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace AZ rollup — use CloudTrail events |

### EC2AutoScaling (`ec2_autoscaling`)

- Classic entity: `AUTO_SCALING_GROUP` (dimension `AutoScalingGroupName`)
- **New block: no match** — new integration does not yet cover this service.

**Built-in `builtin:cloud.aws.*` metrics**

| Classic metric | Unit | Category | CloudWatch name | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `builtin:cloud.aws.asg.running` | Count | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace ASG rollup — use GroupInServiceInstances from AWS/AutoScaling or smartscapeNodes under AWS_AUTOSCALING_AUTOSCALINGGROUP |
| `builtin:cloud.aws.asg.stopped` | Count | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace ASG rollup — no CW equivalent |
| `builtin:cloud.aws.asg.terminated` | Count | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace ASG rollup — use CloudTrail events |

### Lambda (`lambda`)

- Classic entity: `AWS_LAMBDA_FUNCTION` (dimension `FunctionName`)
- New block: `AWS::Lambda::Function` → Smartscape `AWS_LAMBDA_FUNCTION`
- Namespaces: `AWS/Lambda`
- New recommended metrics: 9

**Built-in `builtin:cloud.aws.*` metrics**

| Classic metric | Unit | Category | CloudWatch name | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `builtin:cloud.aws.lambda.concExecutions` | Count | direct | `ConcurrentExecutions` | `cloud.aws.lambda.ConcurrentExecutions.By.FunctionName` | FunctionName |  |
| `builtin:cloud.aws.lambda.duration` | MilliSecond | direct | `Duration` | `cloud.aws.lambda.Duration.By.FunctionName` | FunctionName |  |
| `builtin:cloud.aws.lambda.errors` | Count | direct | `Errors` | `cloud.aws.lambda.Errors.By.FunctionName` | FunctionName |  |
| `builtin:cloud.aws.lambda.errorsRate` | Percent | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace ratio Errors/Invocations — rebuild in DQL as a ratio |
| `builtin:cloud.aws.lambda.invocations` | Count | direct | `Invocations` | `cloud.aws.lambda.Invocations.By.FunctionName` | FunctionName |  |
| `builtin:cloud.aws.lambda.provConcExecutions` | Count | direct | `ProvisionedConcurrentExecutions` | `cloud.aws.lambda.ProvisionedConcurrentExecutions.By.FunctionName` | FunctionName |  |
| `builtin:cloud.aws.lambda.provConcInvocations` | Count | direct | `ProvisionedConcurrencyInvocations` | _—_ | _—_ | CW metric exists in AWS but is not in the new integration's recommended-metrics list — enable recommended+custom MCS and add explicitly |
| `builtin:cloud.aws.lambda.provConcSpilloverInvocations` | Count | direct | `ProvisionedConcurrencySpilloverInvocations` | _—_ | _—_ | CW metric exists in AWS but is not in the new integration's recommended-metrics list — enable recommended+custom MCS and add explicitly |
| `builtin:cloud.aws.lambda.throttlers` | Count | direct | `Throttles` | `cloud.aws.lambda.Throttles.By.FunctionName` | FunctionName | typo-ish classic name — maps to Throttles |

### ApplicationNetworkLoadBalancer (`alb_nlb`)

- Classic entity: `AWS_APPLICATION_LOAD_BALANCER` (dimension `LoadBalancer`)
- Matched 2 new blocks:
  - `AWS::ElasticLoadBalancingV2::LoadBalancer` → `AWS_ELASTICLOADBALANCINGV2_LOADBALANCER` (namespaces: `AWS/ApplicationELB`, `AWS/NetworkELB`, recommended: 24)
  - `AWS::ElasticLoadBalancing::LoadBalancer` → `AWS_ELASTICLOADBALANCING_LOADBALANCER` (namespaces: `AWS/ELB`, recommended: 12)

**Built-in `builtin:cloud.aws.*` metrics**

| Classic metric | Unit | Category | CloudWatch name | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `builtin:cloud.aws.alb.connections.active` | Count | direct | `ActiveConnectionCount` | `cloud.aws.applicationelb.ActiveConnectionCount.By.LoadBalancer` | LoadBalancer |  |
| `builtin:cloud.aws.alb.connections.new` | Count | direct | `NewConnectionCount` | _—_ | _—_ | CW metric exists in AWS but is not in the new integration's recommended-metrics list — enable recommended+custom MCS and add explicitly |
| `builtin:cloud.aws.alb.errors.alb.http4xx` | Count | direct | `HTTPCode_ELB_4XX_Count` | `cloud.aws.applicationelb.HTTPCode_ELB_4XX_Count.By.LoadBalancer` | LoadBalancer |  |
| `builtin:cloud.aws.alb.errors.alb.http5xx` | Count | direct | `HTTPCode_ELB_5XX_Count` | _—_ | _—_ | CW metric exists in AWS but is not in the new integration's recommended-metrics list — enable recommended+custom MCS and add explicitly |
| `builtin:cloud.aws.alb.errors.target.http4xx` | Count | direct | `HTTPCode_Target_4XX_Count` | `cloud.aws.applicationelb.HTTPCode_Target_4XX_Count.By.LoadBalancer.TargetGroup` | LoadBalancer, TargetGroup |  |
| `builtin:cloud.aws.alb.errors.target.http5xx` | Count | direct | `HTTPCode_Target_5XX_Count` | `cloud.aws.applicationelb.HTTPCode_Target_5XX_Count.By.LoadBalancer` | LoadBalancer |  |
| `builtin:cloud.aws.alb.errors.rejCon` | Count | direct | `RejectedConnectionCount` | `cloud.aws.applicationelb.RejectedConnectionCount.By.LoadBalancer` | LoadBalancer |  |
| `builtin:cloud.aws.alb.errors.targConn` | Count | direct | `TargetConnectionErrorCount` | _—_ | _—_ | CW metric exists in AWS but is not in the new integration's recommended-metrics list — enable recommended+custom MCS and add explicitly |
| `builtin:cloud.aws.alb.errors.tlsNeg` | Count | direct | `ClientTLSNegotiationErrorCount` | `cloud.aws.networkelb.ClientTLSNegotiationErrorCount.By.LoadBalancer` | LoadBalancer |  |
| `builtin:cloud.aws.alb.bytes` | Count | direct | `ProcessedBytes` | _—_ | _—_ | AWS/ApplicationELB namespace; CW metric exists in AWS but is not in the new integration's recommended-metrics list — enable recommended+custom MCS and add explicitly |
| `builtin:cloud.aws.alb.lcus` | Count | direct | `ConsumedLCUs` | _—_ | _—_ | CW metric exists in AWS but is not in the new integration's recommended-metrics list — enable recommended+custom MCS and add explicitly |
| `builtin:cloud.aws.alb.requests` | Count | direct | `RequestCount` | `cloud.aws.applicationelb.RequestCount.By.LoadBalancer` | LoadBalancer |  |
| `builtin:cloud.aws.alb.respTime` | Second | direct | `TargetResponseTime` | `cloud.aws.applicationelb.TargetResponseTime.By.LoadBalancer` | LoadBalancer |  |
| `builtin:cloud.aws.nlb.flow.active` | Count | direct | `ActiveFlowCount` | _—_ | _—_ | CW metric exists in AWS but is not in the new integration's recommended-metrics list — enable recommended+custom MCS and add explicitly |
| `builtin:cloud.aws.nlb.flow.new` | Count | direct | `NewFlowCount` | _—_ | _—_ | CW metric exists in AWS but is not in the new integration's recommended-metrics list — enable recommended+custom MCS and add explicitly |
| `builtin:cloud.aws.nlb.tcp.reset.client` | Count | direct | `TCP_Client_Reset_Count` | `cloud.aws.networkelb.TCP_Client_Reset_Count.By.LoadBalancer` | LoadBalancer |  |
| `builtin:cloud.aws.nlb.tcp.reset.elb` | Count | direct | `TCP_ELB_Reset_Count` | `cloud.aws.networkelb.TCP_ELB_Reset_Count.By.LoadBalancer` | LoadBalancer |  |
| `builtin:cloud.aws.nlb.tcp.reset.target` | Count | direct | `TCP_Target_Reset_Count` | `cloud.aws.networkelb.TCP_Target_Reset_Count.By.LoadBalancer` | LoadBalancer |  |
| `builtin:cloud.aws.nlb.bytes` | Count | direct | `ProcessedBytes` | _—_ | _—_ | AWS/NetworkELB namespace; CW metric exists in AWS but is not in the new integration's recommended-metrics list — enable recommended+custom MCS and add explicitly |
| `builtin:cloud.aws.nlb.lcus` | Count | direct | `ConsumedLCUs` | _—_ | _—_ | AWS/NetworkELB namespace; CW metric exists in AWS but is not in the new integration's recommended-metrics list — enable recommended+custom MCS and add explicitly |

### ElasticLoadBalancer (`elb`)

- Classic entity: `ELASTIC_LOAD_BALANCER` (dimension `LoadBalancerName`)
- Matched 2 new blocks:
  - `AWS::ElasticLoadBalancing::LoadBalancer` → `AWS_ELASTICLOADBALANCING_LOADBALANCER` (namespaces: `AWS/ELB`, recommended: 12)
  - `AWS::ElasticLoadBalancingV2::LoadBalancer` → `AWS_ELASTICLOADBALANCINGV2_LOADBALANCER` (namespaces: `AWS/ApplicationELB`, `AWS/NetworkELB`, recommended: 24)

**Built-in `builtin:cloud.aws.*` metrics**

| Classic metric | Unit | Category | CloudWatch name | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `builtin:cloud.aws.elb.errors.backend.connection` | Count | direct | `BackendConnectionErrors` | `cloud.aws.elb.BackendConnectionErrors.By.LoadBalancerName` | LoadBalancerName |  |
| `builtin:cloud.aws.elb.errors.backend.http2xx` | Count | direct | `HTTPCode_Backend_2XX` | `cloud.aws.elb.HTTPCode_Backend_2XX.By.LoadBalancerName` | LoadBalancerName |  |
| `builtin:cloud.aws.elb.errors.backend.http3xx` | Count | direct | `HTTPCode_Backend_3XX` | `cloud.aws.elb.HTTPCode_Backend_3XX.By.LoadBalancerName` | LoadBalancerName |  |
| `builtin:cloud.aws.elb.errors.backend.http4xx` | Count | direct | `HTTPCode_Backend_4XX` | `cloud.aws.elb.HTTPCode_Backend_4XX.By.LoadBalancerName` | LoadBalancerName |  |
| `builtin:cloud.aws.elb.errors.backend.http5xx` | Count | direct | `HTTPCode_Backend_5XX` | `cloud.aws.elb.HTTPCode_Backend_5XX.By.LoadBalancerName` | LoadBalancerName |  |
| `builtin:cloud.aws.elb.errors.elb.http4xx` | Count | direct | `HTTPCode_ELB_4XX` | `cloud.aws.elb.HTTPCode_ELB_4XX.By.LoadBalancerName` | LoadBalancerName |  |
| `builtin:cloud.aws.elb.errors.elb.http5xx` | Count | direct | `HTTPCode_ELB_5XX` | `cloud.aws.elb.HTTPCode_ELB_5XX.By.LoadBalancerName` | LoadBalancerName |  |
| `builtin:cloud.aws.elb.errors.frontend` | Percent | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace-computed frontend error % — rebuild as HTTPCode_ELB_[45]XX / RequestCount |
| `builtin:cloud.aws.elb.hosts.healthy` | Count | direct | `HealthyHostCount` | `cloud.aws.elb.HealthyHostCount.By.LoadBalancerName` | LoadBalancerName |  |
| `builtin:cloud.aws.elb.hosts.unhealthy` | Count | direct | `UnHealthyHostCount` | `cloud.aws.elb.UnHealthyHostCount.By.LoadBalancerName` | LoadBalancerName |  |
| `builtin:cloud.aws.elb.latency` | Second | direct | `Latency` | `cloud.aws.elb.Latency.By.LoadBalancerName` | LoadBalancerName |  |
| `builtin:cloud.aws.elb.reqCompl` | Count | direct | `RequestCount` | `cloud.aws.elb.RequestCount.By.LoadBalancerName` | LoadBalancerName |  |

### RDS (`rds`)

- Classic entity: `RELATIONAL_DATABASE_SERVICE` (dimension `DBInstanceIdentifier`)
- New block: `AWS::RDS::DBInstance` → Smartscape `AWS_RDS_DBINSTANCE`
- Namespaces: `AWS/RDS`
- New recommended metrics: 13

**Built-in `builtin:cloud.aws.*` metrics**

| Classic metric | Unit | Category | CloudWatch name | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `builtin:cloud.aws.rds.cpu.usage` | Percent | direct | `CPUUtilization` | `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier | both Percent |
| `builtin:cloud.aws.rds.latency.read` | Second | direct | `ReadLatency` | `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `builtin:cloud.aws.rds.latency.write` | Second | direct | `WriteLatency` | `cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `builtin:cloud.aws.rds.memory.freeable` | Byte | direct | `FreeableMemory` | `cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `builtin:cloud.aws.rds.memory.swap` | Byte | direct | `SwapUsage` | `cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `builtin:cloud.aws.rds.net.rx` | BytePerSecond | direct | `NetworkReceiveThroughput` | `cloud.aws.rds.NetworkReceiveThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier | both are Bytes/second |
| `builtin:cloud.aws.rds.net.tx` | BytePerSecond | direct | `NetworkTransmitThroughput` | `cloud.aws.rds.NetworkTransmitThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `builtin:cloud.aws.rds.ops.read` | PerSecond | direct | `ReadIOPS` | `cloud.aws.rds.ReadIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier | both are per-second |
| `builtin:cloud.aws.rds.ops.write` | PerSecond | direct | `WriteIOPS` | `cloud.aws.rds.WriteIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `builtin:cloud.aws.rds.throughput.read` | BytePerSecond | direct | `ReadThroughput` | `cloud.aws.rds.ReadThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier | both Bytes/second |
| `builtin:cloud.aws.rds.throughput.write` | BytePerSecond | direct | `WriteThroughput` | `cloud.aws.rds.WriteThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `builtin:cloud.aws.rds.connections` | Count | direct | `DatabaseConnections` | `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `builtin:cloud.aws.rds.free` | Percent | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace-computed free storage % — rebuild: FreeStorageSpace / AllocatedStorage*100 |
| `builtin:cloud.aws.rds.restarts` | Count | no_direct_equivalent | _—_ | _—_ | _—_ | No CW metric; RDS restart events come via EventBridge/RDS events |

### EBS (`ebs`)

- Classic entity: `EBS_VOLUME` (dimension `VolumeId`)
- New block: `AWS::EC2::Volume` → Smartscape `AWS_EC2_VOLUME`
- Namespaces: `AWS/EBS`
- New recommended metrics: 12

**Built-in `builtin:cloud.aws.*` metrics**

| Classic metric | Unit | Category | CloudWatch name | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `builtin:cloud.aws.ebs.latency.read` | Second | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace-computed — rebuild: VolumeTotalReadTime / VolumeReadOps |
| `builtin:cloud.aws.ebs.latency.write` | Second | no_direct_equivalent | _—_ | _—_ | _—_ | Dynatrace-computed — rebuild: VolumeTotalWriteTime / VolumeWriteOps |
| `builtin:cloud.aws.ebs.ops.consumed` | PerSecond | no_direct_equivalent | _—_ | _—_ | _—_ | Sum of read+write OPS — rebuild: VolumeReadOps + VolumeWriteOps, divide by period |
| `builtin:cloud.aws.ebs.ops.read` | PerSecond | unit_conversion | `VolumeReadOps` | `cloud.aws.ebs.VolumeReadOps.By.VolumeId` | VolumeId | rate vs count/period |
| `builtin:cloud.aws.ebs.ops.write` | PerSecond | unit_conversion | `VolumeWriteOps` | `cloud.aws.ebs.VolumeWriteOps.By.VolumeId` | VolumeId | rate vs count/period |
| `builtin:cloud.aws.ebs.throughput.percent` | Percent | direct | `VolumeThroughputPercentage` | `cloud.aws.ebs.VolumeThroughputPercentage.By.VolumeId` | VolumeId | both Percent; io1 volumes only |
| `builtin:cloud.aws.ebs.throughput.read` | PerSecond | unit_conversion | `VolumeReadBytes` | `cloud.aws.ebs.VolumeReadBytes.By.VolumeId` | VolumeId | Bytes/second vs bytes/period |
| `builtin:cloud.aws.ebs.throughput.write` | PerSecond | unit_conversion | `VolumeWriteBytes` | `cloud.aws.ebs.VolumeWriteBytes.By.VolumeId` | VolumeId |  |
| `builtin:cloud.aws.ebs.idleTime` | Percent | unit_conversion | `VolumeIdleTime` | `cloud.aws.ebs.VolumeIdleTime.By.VolumeId` | VolumeId | classic is % of period idle; CW is seconds idle — divide by period and *100 |
| `builtin:cloud.aws.ebs.queue` | Count | direct | `VolumeQueueLength` | `cloud.aws.ebs.VolumeQueueLength.By.VolumeId` | VolumeId |  |

### DynamoDB_new (`dynamodb_other`)

- Classic entity: `cloud:aws:dynamodb` (dimension `TableName`)
- New block: `AWS::DynamoDB::Table` → Smartscape `AWS_DYNAMODB_TABLE`
- Namespaces: `AWS/DynamoDB`
- New recommended metrics: 28

**Raw CloudWatch metrics — Recommended (13)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ConsumedReadCapacityUnits` | Count | TableName | direct | `cloud.aws.dynamodb.ConsumedReadCapacityUnits.By.TableName` | TableName |  |
| `SuccessfulRequestLatency` | Milliseconds | TableName, Operation | direct | `cloud.aws.dynamodb.SuccessfulRequestLatency.By.Operation.TableName` | Operation, TableName |  |
| `ReturnedItemCount` | Count | TableName, Operation | direct | `cloud.aws.dynamodb.ReturnedItemCount.By.Operation.TableName` | Operation, TableName |  |
| `ConsumedWriteCapacityUnits` | Count | TableName | direct | `cloud.aws.dynamodb.ConsumedWriteCapacityUnits.By.TableName` | TableName |  |
| `ProvisionedReadCapacityUnits` | Count | TableName | direct | `cloud.aws.dynamodb.ProvisionedReadCapacityUnits.By.TableName` | TableName |  |
| `ProvisionedWriteCapacityUnits` | Count | TableName | direct | `cloud.aws.dynamodb.ProvisionedWriteCapacityUnits.By.TableName` | TableName |  |
| `ConditionalCheckFailedRequests` | Count | TableName | direct | `cloud.aws.dynamodb.ConditionalCheckFailedRequests.By.TableName` | TableName |  |
| `ReadThrottleEvents` | Count | TableName | direct | `cloud.aws.dynamodb.ReadThrottleEvents.By.TableName` | TableName |  |
| `SystemErrors` | Count | TableName, Operation | direct | `cloud.aws.dynamodb.SystemErrors.By.Operation.TableName` | Operation, TableName |  |
| `ThrottledRequests` | Count | TableName, Operation | direct | `cloud.aws.dynamodb.ThrottledRequests.By.Operation.TableName` | Operation, TableName |  |
| `TransactionConflict` | Count | TableName | direct | `cloud.aws.dynamodb.TransactionConflict.By.TableName` | TableName |  |
| `UserErrors` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `WriteThrottleEvents` | Count | TableName | direct | `cloud.aws.dynamodb.WriteThrottleEvents.By.TableName` | TableName |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (29)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ConsumedReadCapacityUnits` | Count | TableName, GlobalSecondaryIndexName | direct | `cloud.aws.dynamodb.ConsumedReadCapacityUnits.By.GlobalSecondaryIndexName.TableName` | GlobalSecondaryIndexName, TableName |
| `MaxProvisionedTableReadCapacityUtilization` | Percent | Region | requires_custom_metric | _—_ | _—_ |
| `AccountProvisionedReadCapacityUtilization` | Percent | Region | requires_custom_metric | _—_ | _—_ |
| `MaxProvisionedTableWriteCapacityUtilization` | Percent | Region | requires_custom_metric | _—_ | _—_ |
| `AccountMaxTableLevelWrites` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `AccountMaxReads` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ConsumedWriteCapacityUnits` | Count | TableName, GlobalSecondaryIndexName | direct | `cloud.aws.dynamodb.ConsumedWriteCapacityUnits.By.GlobalSecondaryIndexName.TableName` | GlobalSecondaryIndexName, TableName |
| `AccountMaxTableLevelReads` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ProvisionedReadCapacityUnits` | Count | TableName, GlobalSecondaryIndexName | direct | `cloud.aws.dynamodb.ProvisionedReadCapacityUnits.By.GlobalSecondaryIndexName.TableName` | GlobalSecondaryIndexName, TableName |
| `ProvisionedWriteCapacityUnits` | Count | TableName, GlobalSecondaryIndexName | direct | `cloud.aws.dynamodb.ProvisionedWriteCapacityUnits.By.GlobalSecondaryIndexName.TableName` | GlobalSecondaryIndexName, TableName |
| `AccountProvisionedWriteCapacityUtilization` | Percent | Region | requires_custom_metric | _—_ | _—_ |
| `AccountMaxWrites` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `AgeOfOldestUnreplicatedRecord` | Milliseconds | TableName, DelegatedOperation | requires_custom_metric | _—_ | _—_ |
| `ConsumedChangeDataCaptureUnits` | Count | TableName, DelegatedOperation | requires_custom_metric | _—_ | _—_ |
| `FailedToReplicateRecordCount` | Count | TableName, DelegatedOperation | requires_custom_metric | _—_ | _—_ |
| `OnlineIndexConsumedWriteCapacity` | Count | TableName | direct | `cloud.aws.dynamodb.OnlineIndexConsumedWriteCapacity.By.TableName` | TableName |
| `OnlineIndexConsumedWriteCapacity` | Count | TableName, GlobalSecondaryIndexName | direct | `cloud.aws.dynamodb.OnlineIndexConsumedWriteCapacity.By.GlobalSecondaryIndexName.TableName` | GlobalSecondaryIndexName, TableName |
| `OnlineIndexPercentageProgress` | Count | TableName | direct | `cloud.aws.dynamodb.OnlineIndexPercentageProgress.By.TableName` | TableName |
| `OnlineIndexPercentageProgress` | Count | TableName, GlobalSecondaryIndexName | direct | `cloud.aws.dynamodb.OnlineIndexPercentageProgress.By.GlobalSecondaryIndexName.TableName` | GlobalSecondaryIndexName, TableName |
| `OnlineIndexThrottleEvents` | Count | TableName | direct | `cloud.aws.dynamodb.OnlineIndexThrottleEvents.By.TableName` | TableName |
| `OnlineIndexThrottleEvents` | Count | TableName, GlobalSecondaryIndexName | direct | `cloud.aws.dynamodb.OnlineIndexThrottleEvents.By.GlobalSecondaryIndexName.TableName` | GlobalSecondaryIndexName, TableName |
| `PendingReplicationCount` | Count | TableName, ReceivingRegion | requires_custom_metric | _—_ | _—_ |
| `ReadThrottleEvents` | Count | TableName, GlobalSecondaryIndexName | direct | `cloud.aws.dynamodb.ReadThrottleEvents.By.GlobalSecondaryIndexName.TableName` | GlobalSecondaryIndexName, TableName |
| `ReplicationLatency` | Milliseconds | TableName, ReceivingRegion | requires_custom_metric | _—_ | _—_ |
| `ReturnedBytes` | Bytes | TableName, Operation, StreamLabel | requires_custom_metric | _—_ | _—_ |
| `ReturnedRecordsCount` | Count | TableName, Operation, StreamLabel | requires_custom_metric | _—_ | _—_ |
| `TimeToLiveDeletedItemCount` | Count | TableName | requires_custom_metric | _—_ | _—_ |
| `ThrottledPutRecordCount` | Count | TableName, DelegatedOperation | requires_custom_metric | _—_ | _—_ |
| `WriteThrottleEvents` | Count | TableName, GlobalSecondaryIndexName | direct | `cloud.aws.dynamodb.WriteThrottleEvents.By.GlobalSecondaryIndexName.TableName` | GlobalSecondaryIndexName, TableName |

</details>

### EBS_new (`ebs_other`)

- Classic entity: `cloud:aws:ebs` (dimension `VolumeId`)
- New block: `AWS::EC2::Volume` → Smartscape `AWS_EC2_VOLUME`
- Namespaces: `AWS/EBS`
- New recommended metrics: 12

**Raw CloudWatch metrics — Recommended (4)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `VolumeIdleTime` | Seconds | VolumeId | direct | `cloud.aws.ebs.VolumeIdleTime.By.VolumeId` | VolumeId |  |
| `VolumeQueueLength` | Count | VolumeId | direct | `cloud.aws.ebs.VolumeQueueLength.By.VolumeId` | VolumeId |  |
| `VolumeReadOps` | Count | VolumeId | direct | `cloud.aws.ebs.VolumeReadOps.By.VolumeId` | VolumeId |  |
| `VolumeWriteOps` | Count | VolumeId | direct | `cloud.aws.ebs.VolumeWriteOps.By.VolumeId` | VolumeId |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (15)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `BurstBalance` | Percent | VolumeId | direct | `cloud.aws.ebs.BurstBalance.By.VolumeId` | VolumeId |
| `EBSByteBalance%` | Percent | VolumeId | requires_custom_metric | _—_ | _—_ |
| `EBSIOBalance%` | Percent | VolumeId | requires_custom_metric | _—_ | _—_ |
| `EBSReadBytes` | Bytes | VolumeId | requires_custom_metric | _—_ | _—_ |
| `EBSReadOps` | Count | VolumeId | requires_custom_metric | _—_ | _—_ |
| `EBSWriteBytes` | Bytes | VolumeId | requires_custom_metric | _—_ | _—_ |
| `EBSWriteOps` | Count | VolumeId | requires_custom_metric | _—_ | _—_ |
| `FastSnapshotRestoreCreditsBalance` | None | AvailabilityZone, SnapshotId | requires_custom_metric | _—_ | _—_ |
| `FastSnapshotRestoreCreditsBucketSize` | None | AvailabilityZone, SnapshotId | requires_custom_metric | _—_ | _—_ |
| `VolumeConsumedReadWriteOps` | Count | VolumeId | requires_custom_metric | _—_ | _—_ |
| `VolumeReadBytes` | Bytes | VolumeId | direct | `cloud.aws.ebs.VolumeReadBytes.By.VolumeId` | VolumeId |
| `VolumeThroughputPercentage` | Percent | VolumeId | direct | `cloud.aws.ebs.VolumeThroughputPercentage.By.VolumeId` | VolumeId |
| `VolumeTotalReadTime` | Seconds | VolumeId | direct | `cloud.aws.ebs.VolumeTotalReadTime.By.VolumeId` | VolumeId |
| `VolumeTotalWriteTime` | Seconds | VolumeId | direct | `cloud.aws.ebs.VolumeTotalWriteTime.By.VolumeId` | VolumeId |
| `VolumeWriteBytes` | Bytes | VolumeId | direct | `cloud.aws.ebs.VolumeWriteBytes.By.VolumeId` | VolumeId |

</details>

### Lambda_new (`lambda_other`)

- Classic entity: `cloud:aws:lambda` (dimension `FunctionName`)
- New block: `AWS::Lambda::Function` → Smartscape `AWS_LAMBDA_FUNCTION`
- Namespaces: `AWS/Lambda`
- New recommended metrics: 9

**Raw CloudWatch metrics — Recommended (15)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ConcurrentExecutions` | Count | Region | dimension_change | `cloud.aws.lambda.ConcurrentExecutions.By.FunctionName` | FunctionName | same CW metric, different dimensioning (classic=['Region'] vs new=['FunctionName']) |
| `Duration` | Milliseconds | FunctionName | direct | `cloud.aws.lambda.Duration.By.FunctionName` | FunctionName |  |
| `Duration` | Milliseconds | Region | dimension_change | `cloud.aws.lambda.Duration.By.FunctionName` | FunctionName | same CW metric, different dimensioning (classic=['Region'] vs new=['FunctionName']) |
| `Errors` | Count | FunctionName | direct | `cloud.aws.lambda.Errors.By.FunctionName` | FunctionName |  |
| `Errors` | Count | Region | dimension_change | `cloud.aws.lambda.Errors.By.FunctionName` | FunctionName | same CW metric, different dimensioning (classic=['Region'] vs new=['FunctionName']) |
| `Invocations` | Count | FunctionName | direct | `cloud.aws.lambda.Invocations.By.FunctionName` | FunctionName |  |
| `Invocations` | Count | Region | dimension_change | `cloud.aws.lambda.Invocations.By.FunctionName` | FunctionName | same CW metric, different dimensioning (classic=['Region'] vs new=['FunctionName']) |
| `PostRuntimeExtensionsDuration` | Milliseconds | FunctionName, Resource | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PostRuntimeExtensionsDuration` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ProvisionedConcurrencyInvocations` | Count | FunctionName, Resource | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ProvisionedConcurrencyInvocations` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ProvisionedConcurrentExecutions` | Count | FunctionName, Resource | direct | `cloud.aws.lambda.ProvisionedConcurrentExecutions.By.FunctionName` | FunctionName | dimension set differs slightly (classic=['FunctionName', 'Resource'] vs new=['FunctionName']) |
| `ProvisionedConcurrentExecutions` | Count | Region | dimension_change | `cloud.aws.lambda.ProvisionedConcurrentExecutions.By.FunctionName` | FunctionName | same CW metric, different dimensioning (classic=['Region'] vs new=['FunctionName']) |
| `Throttles` | Count | FunctionName | direct | `cloud.aws.lambda.Throttles.By.FunctionName` | FunctionName |  |
| `Throttles` | Count | Region | dimension_change | `cloud.aws.lambda.Throttles.By.FunctionName` | FunctionName | same CW metric, different dimensioning (classic=['Region'] vs new=['FunctionName']) |

<details><summary>Raw CloudWatch metrics — Non-recommended (40)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `AsyncEventAge` | Milliseconds | FunctionName, Resource | requires_custom_metric | _—_ | _—_ |
| `AsyncEventAge` | Milliseconds | FunctionName | requires_custom_metric | _—_ | _—_ |
| `AsyncEventAge` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `AsyncEventsDropped` | Count | FunctionName, Resource | requires_custom_metric | _—_ | _—_ |
| `AsyncEventsDropped` | Count | FunctionName | requires_custom_metric | _—_ | _—_ |
| `AsyncEventsDropped` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `AsyncEventsReceived` | Count | FunctionName, Resource | requires_custom_metric | _—_ | _—_ |
| `AsyncEventsReceived` | Count | FunctionName | requires_custom_metric | _—_ | _—_ |
| `AsyncEventsReceived` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ConcurrentExecutions` | Count | FunctionName, Resource | direct | `cloud.aws.lambda.ConcurrentExecutions.By.FunctionName` | FunctionName |
| `ConcurrentExecutions` | Count | FunctionName | direct | `cloud.aws.lambda.ConcurrentExecutions.By.FunctionName` | FunctionName |
| `DeadLetterErrors` | Count | FunctionName, Resource | direct | `cloud.aws.lambda.DeadLetterErrors.By.FunctionName` | FunctionName |
| `DeadLetterErrors` | Count | FunctionName | direct | `cloud.aws.lambda.DeadLetterErrors.By.FunctionName` | FunctionName |
| `DeadLetterErrors` | Count | Region | dimension_change | `cloud.aws.lambda.DeadLetterErrors.By.FunctionName` | FunctionName |
| `DestinationDeliveryFailures` | Count | FunctionName, Resource | direct | `cloud.aws.lambda.DestinationDeliveryFailures.By.FunctionName` | FunctionName |
| `DestinationDeliveryFailures` | Count | FunctionName | direct | `cloud.aws.lambda.DestinationDeliveryFailures.By.FunctionName` | FunctionName |
| `DestinationDeliveryFailures` | Count | Region | dimension_change | `cloud.aws.lambda.DestinationDeliveryFailures.By.FunctionName` | FunctionName |
| `Duration` | Milliseconds | FunctionName, Resource | direct | `cloud.aws.lambda.Duration.By.FunctionName` | FunctionName |
| `Errors` | Count | FunctionName, Resource | direct | `cloud.aws.lambda.Errors.By.FunctionName` | FunctionName |
| `Invocations` | Count | FunctionName, Resource | direct | `cloud.aws.lambda.Invocations.By.FunctionName` | FunctionName |
| `IteratorAge` | Milliseconds | FunctionName, Resource | direct | `cloud.aws.lambda.IteratorAge.By.FunctionName` | FunctionName |
| `IteratorAge` | Milliseconds | FunctionName | direct | `cloud.aws.lambda.IteratorAge.By.FunctionName` | FunctionName |
| `IteratorAge` | Milliseconds | Region | dimension_change | `cloud.aws.lambda.IteratorAge.By.FunctionName` | FunctionName |
| `OffsetLag` | Milliseconds | FunctionName, Resource | requires_custom_metric | _—_ | _—_ |
| `OffsetLag` | Milliseconds | FunctionName | requires_custom_metric | _—_ | _—_ |
| `OffsetLag` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `PostRuntimeExtensionsDuration` | Milliseconds | FunctionName | requires_custom_metric | _—_ | _—_ |
| `ProvisionedConcurrencyInvocations` | Count | FunctionName | requires_custom_metric | _—_ | _—_ |
| `ProvisionedConcurrencySpilloverInvocations` | Count | FunctionName, Resource | requires_custom_metric | _—_ | _—_ |
| `ProvisionedConcurrencySpilloverInvocations` | Count | FunctionName | requires_custom_metric | _—_ | _—_ |
| `ProvisionedConcurrencySpilloverInvocations` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ProvisionedConcurrencyUtilization` | Count | FunctionName, Resource | requires_custom_metric | _—_ | _—_ |
| `ProvisionedConcurrencyUtilization` | Count | FunctionName | requires_custom_metric | _—_ | _—_ |
| `ProvisionedConcurrencyUtilization` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ProvisionedConcurrentExecutions` | Count | FunctionName | direct | `cloud.aws.lambda.ProvisionedConcurrentExecutions.By.FunctionName` | FunctionName |
| `RecursiveInvocationsDropped` | Count | FunctionName, Resource | requires_custom_metric | _—_ | _—_ |
| `RecursiveInvocationsDropped` | Count | FunctionName | requires_custom_metric | _—_ | _—_ |
| `RecursiveInvocationsDropped` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Throttles` | Count | FunctionName, Resource | direct | `cloud.aws.lambda.Throttles.By.FunctionName` | FunctionName |
| `UnreservedConcurrentExecutions` | Count | Region | requires_custom_metric | _—_ | _—_ |

</details>

### RDS_new (`rds_other`)

- Classic entity: `cloud:aws:rds` (dimension `DBInstanceIdentifier`)
- Matched 2 new blocks:
  - `AWS::RDS::DBInstance` → `AWS_RDS_DBINSTANCE` (namespaces: `AWS/RDS`, recommended: 13)
  - `AWS::RDS::DBCluster` → `AWS_RDS_DBCLUSTER` (namespaces: `AWS/RDS`, recommended: 6)

**Raw CloudWatch metrics — Recommended (26)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `EBSIOBalance%` | Percent | Region, EngineName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DiskQueueDepth` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `BinLogDiskUsage` | Bytes | Region, EngineName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DatabaseConnections` | Count | Region, EngineName | dimension_change | `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBInstanceIdentifier']) |
| `FreeStorageSpace` | Bytes | Region, EngineName | dimension_change | `cloud.aws.rds.FreeStorageSpace.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBInstanceIdentifier']) |
| `EBSByteBalance%` | Percent | Region, EngineName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CPUUtilization` | Percent | Region, EngineName | dimension_change | `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBInstanceIdentifier']) |
| `LVMWriteIOPS` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `LVMReadIOPS` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `FreeableMemory` | Bytes | DBInstanceIdentifier | direct | `cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `FreeableMemory` | Bytes | Region, EngineName | dimension_change | `cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBInstanceIdentifier']) |
| `ReadLatency` | Seconds | DBInstanceIdentifier | direct | `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `NetworkReceiveThroughput` | Bytes/Second | DBInstanceIdentifier | direct | `cloud.aws.rds.NetworkReceiveThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `BinLogDiskUsage` | Bytes | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DatabaseConnections` | Count | DBInstanceIdentifier | direct | `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `CPUUtilization` | Percent | DBInstanceIdentifier | direct | `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `DiskQueueDepth` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `NetworkReceiveThroughput` | Bytes/Second | Region, EngineName | dimension_change | `cloud.aws.rds.NetworkReceiveThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBInstanceIdentifier']) |
| `BurstBalance` | Percent | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `EBSByteBalance%` | Percent | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `LVMReadIOPS` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `EBSIOBalance%` | Percent | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `BurstBalance` | Percent | Region, EngineName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `FreeStorageSpace` | Bytes | DBInstanceIdentifier | direct | `cloud.aws.rds.FreeStorageSpace.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `WriteLatency` | Seconds | DBInstanceIdentifier | direct | `cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |  |
| `LVMWriteIOPS` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (539)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `Aurora_pq_request_not_chosen_tx_isolation` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_tx_isolation` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_tx_isolation` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_tx_isolation` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_tx_isolation` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `SumBinaryLogSize` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `SumBinaryLogSize` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `SumBinaryLogSize` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `SumBinaryLogSize` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `SumBinaryLogSize` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DeleteThroughput` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Deadlocks` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Deadlocks` | Count/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Deadlocks` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `Deadlocks` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Deadlocks` | Count/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_bit` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_bit` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_bit` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_bit` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_bit` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `TotalBackupStorageBilled` | Bytes | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `TotalBackupStorageBilled` | Bytes | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `DeleteLatency` | Milliseconds | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `DeleteLatency` | Milliseconds | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DeleteLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `DeleteLatency` | Milliseconds | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `DeleteLatency` | Milliseconds | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_high_buffer_pool_pct` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `DDLLatency` | Milliseconds | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `DDLLatency` | Milliseconds | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DDLLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `DDLLatency` | Milliseconds | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `DDLLatency` | Milliseconds | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DMLLatency` | Milliseconds | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `DMLLatency` | Milliseconds | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DMLLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `DMLLatency` | Milliseconds | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `DMLLatency` | Milliseconds | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DDLThroughput` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `DDLThroughput` | Count/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DDLThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `DDLThroughput` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `DDLThroughput` | Count/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `CommitThroughput` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `CommitThroughput` | Count/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `CommitThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `CommitThroughput` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `CommitThroughput` | Count/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaReadWaitLatency` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_custom_charset` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_custom_charset` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_custom_charset` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_custom_charset` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_custom_charset` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `BlockedTransactions` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `BlockedTransactions` | Count/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `BlockedTransactions` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `BlockedTransactions` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `BlockedTransactions` | Count/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `EBSIOBalance%` | Percent | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `EBSIOBalance%` | Percent | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `EBSIOBalance%` | Percent | Region | requires_custom_metric | _—_ | _—_ |
| `EBSIOBalance%` | Percent | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `SwapUsage` | Bytes | Region, DatabaseClass | dimension_change | `cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `SwapUsage` | Bytes | Region, DBClusterIdentifier | dimension_change | `cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `SwapUsage` | Bytes | Region | dimension_change | `cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `SwapUsage` | Bytes | Region, EngineName | dimension_change | `cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `SwapUsage` | Bytes | Region, DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ForwardingReplicaDMLThroughput` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_attempted` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `LoginFailures` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `LoginFailures` | Count/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `LoginFailures` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `LoginFailures` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `LoginFailures` | Count/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | Region, DatabaseClass | dimension_change | `cloud.aws.rds.NetworkTransmitThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkTransmitThroughput` | Bytes/Second | Region, DBClusterIdentifier | dimension_change | `cloud.aws.rds.NetworkTransmitThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkTransmitThroughput` | Bytes/Second | Region | dimension_change | `cloud.aws.rds.NetworkTransmitThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkTransmitThroughput` | Bytes/Second | Region, EngineName | dimension_change | `cloud.aws.rds.NetworkTransmitThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkTransmitThroughput` | Bytes/Second | Region, DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.NetworkTransmitThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NumBinaryLogFiles` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `NumBinaryLogFiles` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `NumBinaryLogFiles` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `NumBinaryLogFiles` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `NumBinaryLogFiles` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DBLoadCPU` | None | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_failed` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `BlockedTransactions` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaReadWaitThroughput` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ReadThroughput` | Bytes/Second | Region, DatabaseClass | dimension_change | `cloud.aws.rds.ReadThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadThroughput` | Bytes/Second | Region | dimension_change | `cloud.aws.rds.ReadThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadThroughput` | Bytes/Second | Region, EngineName | dimension_change | `cloud.aws.rds.ReadThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `Aurora_pq_request_not_chosen_long_trx` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_long_trx` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_long_trx` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_long_trx` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_long_trx` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DeleteThroughput` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `DeleteThroughput` | Count/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DeleteThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `DeleteThroughput` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `DeleteThroughput` | Count/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DBLoadCPU` | None | Region | requires_custom_metric | _—_ | _—_ |
| `CommitLatency` | Milliseconds | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `CommitLatency` | Milliseconds | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `CommitLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `CommitLatency` | Milliseconds | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `CommitLatency` | Milliseconds | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaOpenSessions` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaOpenSessions` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaOpenSessions` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaOpenSessions` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaOpenSessions` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `BackupRetentionPeriodStorageUsed` | Bytes | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `BackupRetentionPeriodStorageUsed` | Bytes | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `InsertLatency` | Milliseconds | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `InsertLatency` | Milliseconds | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `InsertLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `InsertLatency` | Milliseconds | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `InsertLatency` | Milliseconds | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DMLThroughput` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `DMLThroughput` | Count/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DMLThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `DMLThroughput` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `DMLThroughput` | Count/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_attempted` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_attempted` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_attempted` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_attempted` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_attempted` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DiskQueueDepth` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `DiskQueueDepth` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_temporary_table` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_temporary_table` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_temporary_table` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_temporary_table` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_temporary_table` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `BinLogDiskUsage` | Bytes | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `BinLogDiskUsage` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterDMLThroughput` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterDMLThroughput` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterDMLThroughput` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterDMLThroughput` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterDMLThroughput` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Queries` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_unsupported_access` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_unsupported_access` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_unsupported_access` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_unsupported_access` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_unsupported_access` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `AuroraSlowConnectionHandleCount` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `AuroraSlowConnectionHandleCount` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `AuroraSlowConnectionHandleCount` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `AuroraSlowConnectionHandleCount` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `AuroraSlowConnectionHandleCount` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_geometry` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_geometry` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_geometry` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_geometry` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_geometry` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `CommitThroughput` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `RollbackSegmentHistoryListLength` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `RollbackSegmentHistoryListLength` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `RollbackSegmentHistoryListLength` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `RollbackSegmentHistoryListLength` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `RollbackSegmentHistoryListLength` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `SelectLatency` | Milliseconds | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `SelectLatency` | Milliseconds | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `SelectLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `SelectLatency` | Milliseconds | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `SelectLatency` | Milliseconds | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaDMLLatency` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaDMLLatency` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaDMLLatency` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaDMLLatency` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaDMLLatency` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkThroughput` | Bytes/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_few_pages_outside_buffer_pool` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `DatabaseConnections` | Count | Region, DatabaseClass | dimension_change | `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `DatabaseConnections` | Count | Region, DBClusterIdentifier | dimension_change | `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `DatabaseConnections` | Count | Region | dimension_change | `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `DatabaseConnections` | Count | Region, DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `Aurora_pq_request_not_chosen_custom_charset` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_small_table` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_small_table` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_small_table` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_small_table` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_small_table` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_row_length_too_long` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_row_length_too_long` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_row_length_too_long` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_row_length_too_long` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_row_length_too_long` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `FreeStorageSpace` | Bytes | Region, DatabaseClass | dimension_change | `cloud.aws.rds.FreeStorageSpace.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `FreeStorageSpace` | Bytes | Region | dimension_change | `cloud.aws.rds.FreeStorageSpace.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `Aurora_pq_request_not_chosen_column_lob` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_lob` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_lob` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_lob` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_lob` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `AuroraVolumeBytesLeftTotal` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `AbortedClients` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `AbortedClients` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `AbortedClients` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `AbortedClients` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `AbortedClients` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `BufferCacheHitRatio` | Percent | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `BufferCacheHitRatio` | Percent | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `BufferCacheHitRatio` | Percent | Region | requires_custom_metric | _—_ | _—_ |
| `BufferCacheHitRatio` | Percent | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `BufferCacheHitRatio` | Percent | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `AuroraSlowHandshakeCount` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `AuroraSlowHandshakeCount` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `AuroraSlowHandshakeCount` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `AuroraSlowHandshakeCount` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `AuroraSlowHandshakeCount` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_innodb_table_format` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_innodb_table_format` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_innodb_table_format` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_innodb_table_format` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_innodb_table_format` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterDMLLatency` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Queries` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Queries` | Count/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Queries` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `Queries` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Queries` | Count/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `EBSByteBalance%` | Percent | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `EBSByteBalance%` | Percent | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `EBSByteBalance%` | Percent | Region | requires_custom_metric | _—_ | _—_ |
| `EBSByteBalance%` | Percent | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ActiveTransactions` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ActiveTransactions` | Count/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ActiveTransactions` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `ActiveTransactions` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ActiveTransactions` | Count/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `InsertThroughput` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `InsertThroughput` | Count/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `InsertThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `InsertThroughput` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `InsertThroughput` | Count/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterOpenSessions` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterOpenSessions` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterOpenSessions` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterOpenSessions` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterOpenSessions` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `SwapUsage` | Bytes | DBInstanceIdentifier | direct | `cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `VolumeReadIOPs` | Count | Region, DbClusterIdentifier, EngineName | dimension_change | `cloud.aws.rds.VolumeReadIOPs.By.DBClusterIdentifier` | DBClusterIdentifier |
| `VolumeReadIOPs` | Count | Region, DBClusterIdentifier | direct | `cloud.aws.rds.VolumeReadIOPs.By.DBClusterIdentifier` | DBClusterIdentifier |
| `VolumeReadIOPs` | Count | Region, EngineName | dimension_change | `cloud.aws.rds.VolumeReadIOPs.By.DBClusterIdentifier` | DBClusterIdentifier |
| `ForwardingWriterDMLThroughput` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `AuroraVolumeBytesLeftTotal` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `AuroraVolumeBytesLeftTotal` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `AuroraVolumeBytesLeftTotal` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `AuroraVolumeBytesLeftTotal` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `AuroraVolumeBytesLeftTotal` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_no_where_clause` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_no_where_clause` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_no_where_clause` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_no_where_clause` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_no_where_clause` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `VolumeBytesUsed` | Bytes | Region, DbClusterIdentifier, EngineName | dimension_change | `cloud.aws.rds.VolumeBytesUsed.By.DBClusterIdentifier` | DBClusterIdentifier |
| `VolumeBytesUsed` | Bytes | Region, DBClusterIdentifier | direct | `cloud.aws.rds.VolumeBytesUsed.By.DBClusterIdentifier` | DBClusterIdentifier |
| `VolumeBytesUsed` | Bytes | Region, EngineName | dimension_change | `cloud.aws.rds.VolumeBytesUsed.By.DBClusterIdentifier` | DBClusterIdentifier |
| `Aurora_pq_request_not_chosen_range_scan` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `UpdateLatency` | Milliseconds | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `UpdateLatency` | Milliseconds | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `UpdateLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `UpdateLatency` | Milliseconds | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `UpdateLatency` | Milliseconds | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `UpdateThroughput` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `UpdateThroughput` | Count/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `UpdateThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `UpdateThroughput` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `UpdateThroughput` | Count/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `CPUUtilization` | Percent | Region, DatabaseClass | dimension_change | `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `CPUUtilization` | Percent | Region, DBClusterIdentifier | dimension_change | `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `CPUUtilization` | Percent | Region | dimension_change | `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `CPUUtilization` | Percent | Region, DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `Aurora_pq_request_in_progress` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_in_progress` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_in_progress` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_in_progress` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_in_progress` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaDMLThroughput` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaDMLThroughput` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaDMLThroughput` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaDMLThroughput` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaDMLThroughput` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `LVMWriteIOPS` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `LVMWriteIOPS` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaSelectThroughput` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaSelectThroughput` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaSelectThroughput` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaSelectThroughput` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaSelectThroughput` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_failed` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_failed` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_failed` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_failed` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_failed` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_range_scan` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_range_scan` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_range_scan` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_range_scan` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_range_scan` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_few_pages_outside_buffer_pool` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_few_pages_outside_buffer_pool` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_few_pages_outside_buffer_pool` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_few_pages_outside_buffer_pool` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_few_pages_outside_buffer_pool` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ConnectionAttempts` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ConnectionAttempts` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ConnectionAttempts` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ConnectionAttempts` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ConnectionAttempts` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterOpenSessions` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkThroughput` | Bytes/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `NetworkThroughput` | Bytes/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkThroughput` | Bytes/Second | Region | requires_custom_metric | _—_ | _—_ |
| `NetworkThroughput` | Bytes/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `NetworkThroughput` | Bytes/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `RollbackSegmentHistoryListLength` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `SnapshotStorageUsed` | Bytes | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `SnapshotStorageUsed` | Bytes | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `AuroraBinlogReplicaLag` | Seconds | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `AuroraBinlogReplicaLag` | Seconds | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `AuroraBinlogReplicaLag` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `AuroraBinlogReplicaLag` | Seconds | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `AuroraBinlogReplicaLag` | Seconds | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaSelectLatency` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaSelectLatency` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaSelectLatency` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaSelectLatency` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaSelectLatency` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `LVMReadIOPS` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `LVMReadIOPS` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_index_hint` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkReceiveThroughput` | Bytes/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkReceiveThroughput` | Bytes/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkReceiveThroughput` | Bytes/Second | Region | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkReceiveThroughput` | Bytes/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkReceiveThroughput` | Bytes/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_executed` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_executed` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_executed` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_executed` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_executed` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ReadLatency` | Seconds | Region, DatabaseClass | dimension_change | `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadLatency` | Seconds | Region, DBClusterIdentifier | dimension_change | `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadLatency` | Seconds | Region | dimension_change | `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadLatency` | Seconds | Region, EngineName | dimension_change | `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadLatency` | Seconds | Region, DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `Aurora_pq_request_not_chosen_update_delete_stmts` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_update_delete_stmts` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_update_delete_stmts` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_update_delete_stmts` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_update_delete_stmts` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_below_min_rows` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_below_min_rows` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_below_min_rows` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_below_min_rows` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_below_min_rows` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `AuroraSlowConnectionHandleCount` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkThroughput` | Bytes/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkThroughput` | Bytes/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkThroughput` | Bytes/Second | Region | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkThroughput` | Bytes/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkThroughput` | Bytes/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ActiveTransactions` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_virtual` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_virtual` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_virtual` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_virtual` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_virtual` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `LoginFailures` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaReadWaitThroughput` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaReadWaitThroughput` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaReadWaitThroughput` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaReadWaitThroughput` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaReadWaitThroughput` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `SelectLatency` | Milliseconds | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `VolumeWriteIOPs` | Count | Region, DbClusterIdentifier, EngineName | dimension_change | `cloud.aws.rds.VolumeWriteIOPs.By.DBClusterIdentifier` | DBClusterIdentifier |
| `VolumeWriteIOPs` | Count | Region, DBClusterIdentifier | direct | `cloud.aws.rds.VolumeWriteIOPs.By.DBClusterIdentifier` | DBClusterIdentifier |
| `VolumeWriteIOPs` | Count | Region, EngineName | dimension_change | `cloud.aws.rds.VolumeWriteIOPs.By.DBClusterIdentifier` | DBClusterIdentifier |
| `Aurora_pq_request_not_chosen_full_text_index` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_full_text_index` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_full_text_index` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_full_text_index` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_full_text_index` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `AuroraBinlogReplicaLag` | Seconds | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `RowLockTime` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `RowLockTime` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `RowLockTime` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `RowLockTime` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `RowLockTime` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_bit` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_high_buffer_pool_pct` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_high_buffer_pool_pct` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_high_buffer_pool_pct` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_high_buffer_pool_pct` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_high_buffer_pool_pct` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterDMLLatency` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterDMLLatency` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterDMLLatency` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterDMLLatency` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ForwardingWriterDMLLatency` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_index_hint` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_index_hint` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_index_hint` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_index_hint` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_index_hint` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `CommitLatency` | Milliseconds | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaSelectLatency` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ReadIOPS` | Count/Second | Region, DatabaseClass | dimension_change | `cloud.aws.rds.ReadIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadIOPS` | Count/Second | Region | dimension_change | `cloud.aws.rds.ReadIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadIOPS` | Count/Second | Region, EngineName | dimension_change | `cloud.aws.rds.ReadIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `StorageNetworkTransmitThroughput` | Bytes/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_innodb_table_format` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `WriteLatency` | Seconds | Region, DatabaseClass | dimension_change | `cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteLatency` | Seconds | Region, DBClusterIdentifier | dimension_change | `cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteLatency` | Seconds | Region | dimension_change | `cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteLatency` | Seconds | Region, EngineName | dimension_change | `cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteLatency` | Seconds | Region, DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `SelectThroughput` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `SelectThroughput` | Count/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `SelectThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `SelectThroughput` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `SelectThroughput` | Count/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `FreeableMemory` | Bytes | Region, DatabaseClass | dimension_change | `cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `FreeableMemory` | Bytes | Region, DBClusterIdentifier | dimension_change | `cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `FreeableMemory` | Bytes | Region | dimension_change | `cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `FreeableMemory` | Bytes | Region, DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `DMLLatency` | Milliseconds | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_unsupported_access` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `UpdateLatency` | Milliseconds | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `DBLoad` | None | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_row_length_too_long` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_no_where_clause` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `DDLLatency` | Milliseconds | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `SumBinaryLogSize` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_below_min_rows` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_in_progress` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaReadWaitLatency` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaReadWaitLatency` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaReadWaitLatency` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaReadWaitLatency` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaReadWaitLatency` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `AbortedClients` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ReadThroughput` | Bytes/Second | DBInstanceIdentifier | direct | `cloud.aws.rds.ReadThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `Aurora_pq_request_not_chosen_column_virtual` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_throttled` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_throttled` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_throttled` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_throttled` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_throttled` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `AuroraDMLRejectedWriterFull` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `AuroraDMLRejectedWriterFull` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `AuroraDMLRejectedWriterFull` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `AuroraDMLRejectedWriterFull` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `AuroraDMLRejectedWriterFull` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaDMLLatency` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `WriteThroughput` | Bytes/Second | DBInstanceIdentifier | direct | `cloud.aws.rds.WriteThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `Aurora_pq_request_not_chosen_full_text_index` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaOpenSessions` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkTransmitThroughput` | Bytes/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkTransmitThroughput` | Bytes/Second | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkTransmitThroughput` | Bytes/Second | Region | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkTransmitThroughput` | Bytes/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkTransmitThroughput` | Bytes/Second | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_long_trx` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_temporary_table` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `RowLockTime` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_tx_isolation` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkReceiveThroughput` | Bytes/Second | Region, DatabaseClass | dimension_change | `cloud.aws.rds.NetworkReceiveThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkReceiveThroughput` | Bytes/Second | Region, DBClusterIdentifier | dimension_change | `cloud.aws.rds.NetworkReceiveThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkReceiveThroughput` | Bytes/Second | Region | dimension_change | `cloud.aws.rds.NetworkReceiveThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkReceiveThroughput` | Bytes/Second | Region, DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.NetworkReceiveThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `Aurora_pq_request_not_chosen_small_table` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `DBLoadNonCPU` | None | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `WriteIOPS` | Count/Second | Region, DatabaseClass | dimension_change | `cloud.aws.rds.WriteIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteIOPS` | Count/Second | Region | dimension_change | `cloud.aws.rds.WriteIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteIOPS` | Count/Second | Region, EngineName | dimension_change | `cloud.aws.rds.WriteIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `Aurora_pq_request_not_chosen_column_lob` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_instant_ddl` | Count | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_instant_ddl` | Count | Region, DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_instant_ddl` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_instant_ddl` | Count | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_instant_ddl` | Count | Region, DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DMLThroughput` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `WriteIOPS` | Count/Second | DBInstanceIdentifier | direct | `cloud.aws.rds.WriteIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteThroughput` | Bytes/Second | Region, DatabaseClass | dimension_change | `cloud.aws.rds.WriteThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteThroughput` | Bytes/Second | Region | dimension_change | `cloud.aws.rds.WriteThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteThroughput` | Bytes/Second | Region, EngineName | dimension_change | `cloud.aws.rds.WriteThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `BufferCacheHitRatio` | Percent | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ConnectionAttempts` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | DBInstanceIdentifier | direct | `cloud.aws.rds.NetworkTransmitThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `Aurora_pq_request_executed` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `UpdateThroughput` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ForwardingReplicaSelectThroughput` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `StorageNetworkReceiveThroughput` | Bytes/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `DeleteLatency` | Milliseconds | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `DDLThroughput` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ReadIOPS` | Count/Second | DBInstanceIdentifier | direct | `cloud.aws.rds.ReadIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkThroughput` | Bytes/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `DBLoad` | None | Region | requires_custom_metric | _—_ | _—_ |
| `Deadlocks` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `AuroraSlowHandshakeCount` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_throttled` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `NumBinaryLogFiles` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `BurstBalance` | Percent | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `BurstBalance` | Percent | Region | requires_custom_metric | _—_ | _—_ |
| `DBLoadNonCPU` | None | Region | requires_custom_metric | _—_ | _—_ |
| `AuroraDMLRejectedWriterFull` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `InsertLatency` | Milliseconds | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_instant_ddl` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_update_delete_stmts` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `SelectThroughput` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `InsertThroughput` | Count/Second | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `Aurora_pq_request_not_chosen_column_geometry` | Count | DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |

</details>

### ACMPCA (`acm_pca`)

- Classic entity: `cloud:aws:acmprivateca` (dimension `PrivateCAArn`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (4)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CRLGenerated` | None | PrivateCAArn | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Failure` | None | Operation, PrivateCAArn | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `MisconfiguredCRLBucket` | None | PrivateCAArn | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Success` | None | Operation, PrivateCAArn | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (4)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `Failure` | None | Operation, Region | no_new_coverage | _—_ | _—_ |
| `Success` | None | Operation, Region | no_new_coverage | _—_ | _—_ |
| `Time` | None | Operation, PrivateCAArn | no_new_coverage | _—_ | _—_ |
| `Time` | None | Operation, Region | no_new_coverage | _—_ | _—_ |

</details>

### APIGateway (`api_gateway`)

- Classic entity: `cloud:aws:api_gateway` (dimension `ApiName`)
- Matched 2 new blocks:
  - `AWS::ApiGateway::RestApi` → `AWS_APIGATEWAY_RESTAPI` (namespaces: `AWS/ApiGateway`, recommended: 14)
  - `AWS::ApiGatewayV2::Api` → `AWS_APIGATEWAYV2_API` (namespaces: `AWS/ApiGateway`, recommended: 12)

**Raw CloudWatch metrics — Recommended (5)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `4XXError` | Count | ApiName | direct | `cloud.aws.apigateway.4XXError.By.ApiName` | ApiName |  |
| `5XXError` | Count | ApiName | direct | `cloud.aws.apigateway.5XXError.By.ApiName` | ApiName |  |
| `Count` | Count | ApiName | direct | `cloud.aws.apigateway.Count.By.ApiName` | ApiName |  |
| `IntegrationLatency` | Milliseconds | ApiName | direct | `cloud.aws.apigateway.IntegrationLatency.By.ApiName` | ApiName |  |
| `Latency` | Milliseconds | ApiName | direct | `cloud.aws.apigateway.Latency.By.ApiName` | ApiName |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (16)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `4XXError` | Count | ApiName, Stage | direct | `cloud.aws.apigateway.4XXError.By.ApiName.Stage` | ApiName, Stage |
| `4XXError` | Count | ApiName, Method, Resource, Stage | direct | `cloud.aws.apigateway.4XXError.By.ApiName` | ApiName |
| `5XXError` | Count | ApiName, Stage | direct | `cloud.aws.apigateway.5XXError.By.ApiName.Stage` | ApiName, Stage |
| `5XXError` | Count | ApiName, Method, Resource, Stage | direct | `cloud.aws.apigateway.5XXError.By.ApiName` | ApiName |
| `CacheHitCount` | Count | ApiName | direct | `cloud.aws.apigateway.CacheHitCount.By.ApiName` | ApiName |
| `CacheHitCount` | Count | ApiName, Method, Resource, Stage | direct | `cloud.aws.apigateway.CacheHitCount.By.ApiName` | ApiName |
| `CacheMissCount` | Count | ApiName | direct | `cloud.aws.apigateway.CacheMissCount.By.ApiName` | ApiName |
| `CacheMissCount` | Count | ApiName, Stage | direct | `cloud.aws.apigateway.CacheMissCount.By.ApiName.Stage` | ApiName, Stage |
| `CacheMissCount` | Count | ApiName, Method, Resource, Stage | direct | `cloud.aws.apigateway.CacheMissCount.By.ApiName` | ApiName |
| `Count` | Count | Region | dimension_change | `cloud.aws.apigateway.Count.By.ApiName` | ApiName |
| `Count` | Count | ApiName, Stage | direct | `cloud.aws.apigateway.Count.By.ApiName.Stage` | ApiName, Stage |
| `Count` | Count | ApiName, Method, Resource, Stage | direct | `cloud.aws.apigateway.Count.By.ApiName` | ApiName |
| `IntegrationLatency` | Milliseconds | ApiName, Stage | direct | `cloud.aws.apigateway.IntegrationLatency.By.ApiName.Stage` | ApiName, Stage |
| `IntegrationLatency` | Milliseconds | ApiName, Method, Resource, Stage | direct | `cloud.aws.apigateway.IntegrationLatency.By.ApiName` | ApiName |
| `Latency` | Milliseconds | ApiName, Stage | direct | `cloud.aws.apigateway.Latency.By.ApiName.Stage` | ApiName, Stage |
| `Latency` | Milliseconds | ApiName, Method, Resource, Stage | direct | `cloud.aws.apigateway.Latency.By.ApiName` | ApiName |

</details>

### AppRunner (`app_runner`)

- Classic entity: `cloud:aws:apprunner` (dimension `ServiceName`)
- New block: `AWS::AppRunner::Service` → Smartscape `AWS_APPRUNNER_SERVICE`
- Namespaces: `AWS/AppRunner`
- New recommended metrics: 11

**Raw CloudWatch metrics — Recommended (4)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `2xxStatusResponses` | Count | ServiceID, ServiceName | direct | `cloud.aws.apprunner.2xxStatusResponses.By.ServiceID.ServiceName` | ServiceID, ServiceName |  |
| `4xxStatusResponses` | Count | ServiceID, ServiceName | direct | `cloud.aws.apprunner.4xxStatusResponses.By.ServiceID.ServiceName` | ServiceID, ServiceName |  |
| `ActiveInstances` | Count | ServiceID, ServiceName | direct | `cloud.aws.apprunner.ActiveInstances.By.ServiceID.ServiceName` | ServiceID, ServiceName |  |
| `RequestLatency` | Milliseconds | ServiceID, ServiceName | direct | `cloud.aws.apprunner.RequestLatency.By.ServiceID.ServiceName` | ServiceID, ServiceName |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (3)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `CPUUtilization` | Percent | Instance, ServiceID, ServiceName | direct | `cloud.aws.apprunner.CPUUtilization.By.Instance.ServiceID.ServiceName` | Instance, ServiceID, ServiceName |
| `MemoryUtilization` | Megabytes | Instance, ServiceID, ServiceName | direct | `cloud.aws.apprunner.MemoryUtilization.By.Instance.ServiceID.ServiceName` | Instance, ServiceID, ServiceName |
| `Requests` | Count | ServiceID, ServiceName | direct | `cloud.aws.apprunner.Requests.By.ServiceID.ServiceName` | ServiceID, ServiceName |

</details>

### AppStream (`appstream`)

- Classic entity: `cloud:aws:appstream` (dimension `Fleet`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (6)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ActualCapacity` | Count | Fleet | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `AvailableCapacity` | Count | Fleet | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `CapacityUtilization` | Percent | Fleet | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `DesiredCapacity` | Count | Fleet | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `InUseCapacity` | Count | Fleet | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `PendingCapacity` | Count | Fleet | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (1)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `InsufficientCapacityError` | Count | Fleet | no_new_coverage | _—_ | _—_ |

</details>

### AppSync (`appsync`)

- Classic entity: `cloud:aws:appsync` (dimension `GraphQLAPIId`)
- New block: `AWS::ApiGateway::RestApi` → Smartscape `AWS_APIGATEWAY_RESTAPI`
- Namespaces: `AWS/ApiGateway`
- New recommended metrics: 14

**Raw CloudWatch metrics — Recommended (21)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ActiveConnections` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ActiveSubscriptions` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ConnectClientError` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ConnectServerError` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ConnectSuccess` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ConnectionDuration` | Milliseconds | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DisconnectClientError` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DisconnectServerError` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DisconnectSuccess` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `Latency` | Milliseconds | GraphQLAPIId | dimension_change | `cloud.aws.apigateway.Latency.By.ApiName` | ApiName | same CW metric, different dimensioning (classic=['GraphQLAPIId'] vs new=['ApiName']) |
| `PublishDataMessageClientError` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PublishDataMessageServerError` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PublishDataMessageSize` | Bytes | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PublishDataMessageSuccess` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `SubscribeServerError` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `SubscribeSuccess` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `UnsubscribeClientError` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `UnsubscribeServerError` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `UnsubscribeSuccess` | Count | GraphQLAPIId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `4XXError` | Count | GraphQLAPIId | dimension_change | `cloud.aws.apigateway.4XXError.By.ApiName` | ApiName | same CW metric, different dimensioning (classic=['GraphQLAPIId'] vs new=['ApiName']) |
| `5XXError` | Count | GraphQLAPIId | dimension_change | `cloud.aws.apigateway.5XXError.By.ApiName` | ApiName | same CW metric, different dimensioning (classic=['GraphQLAPIId'] vs new=['ApiName']) |

### Athena (`athena`)

- Classic entity: `cloud:aws:athena` (dimension `WorkGroup`)
- New block: `AWS::Athena::WorkGroup` → Smartscape `AWS_ATHENA_WORKGROUP`
- Namespaces: `AWS/Athena`
- New recommended metrics: 8

**Raw CloudWatch metrics — Recommended (6)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `EngineExecutionTime` | Milliseconds | WorkGroup, QueryState, QueryType | direct | `cloud.aws.athena.EngineExecutionTime.By.QueryState.QueryType.WorkGroup` | QueryState, QueryType, WorkGroup |  |
| `ProcessedBytes` | Bytes | WorkGroup, QueryState, QueryType | direct | `cloud.aws.athena.ProcessedBytes.By.QueryState.QueryType.WorkGroup` | QueryState, QueryType, WorkGroup |  |
| `QueryPlanningTime` | Milliseconds | WorkGroup, QueryState, QueryType | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `QueryQueueTime` | Milliseconds | WorkGroup, QueryState, QueryType | direct | `cloud.aws.athena.QueryQueueTime.By.QueryState.QueryType.WorkGroup` | QueryState, QueryType, WorkGroup |  |
| `ServiceProcessingTime` | Milliseconds | WorkGroup, QueryState, QueryType | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TotalExecutionTime` | Milliseconds | WorkGroup, QueryState, QueryType | direct | `cloud.aws.athena.TotalExecutionTime.By.QueryState.QueryType.WorkGroup` | QueryState, QueryType, WorkGroup |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (6)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `EngineExecutionTime` | Milliseconds | Region, QueryState, QueryType | dimension_change | `cloud.aws.athena.EngineExecutionTime.By.QueryState.QueryType.WorkGroup` | QueryState, QueryType, WorkGroup |
| `ProcessedBytes` | Bytes | Region, QueryState, QueryType | dimension_change | `cloud.aws.athena.ProcessedBytes.By.QueryState.QueryType.WorkGroup` | QueryState, QueryType, WorkGroup |
| `QueryPlanningTime` | Milliseconds | Region, QueryState, QueryType | requires_custom_metric | _—_ | _—_ |
| `QueryQueueTime` | Milliseconds | Region, QueryState, QueryType | dimension_change | `cloud.aws.athena.QueryQueueTime.By.QueryState.QueryType.WorkGroup` | QueryState, QueryType, WorkGroup |
| `ServiceProcessingTime` | Milliseconds | Region, QueryState, QueryType | requires_custom_metric | _—_ | _—_ |
| `TotalExecutionTime` | Milliseconds | Region, QueryState, QueryType | dimension_change | `cloud.aws.athena.TotalExecutionTime.By.QueryState.QueryType.WorkGroup` | QueryState, QueryType, WorkGroup |

</details>

### Aurora (`aurora`)

- Classic entity: `cloud:aws:aurora` (dimension `DBClusterIdentifier`)
- New block: `AWS::RDS::DBInstance` → Smartscape `AWS_RDS_DBINSTANCE`
- Namespaces: `AWS/RDS`
- New recommended metrics: 13

**Raw CloudWatch metrics — Recommended (4)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `DeleteThroughput` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `InsertThroughput` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `Queries` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `UpdateThroughput` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (266)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ActiveTransactions` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ActiveTransactions` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ActiveTransactions` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `ActiveTransactions` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `ActiveTransactions` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `AuroraBinlogReplicaLag` | Seconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `AuroraBinlogReplicaLag` | Seconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `AuroraBinlogReplicaLag` | Seconds | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `AuroraBinlogReplicaLag` | Seconds | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `AuroraBinlogReplicaLag` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLagMaximum` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLagMaximum` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLagMaximum` | Milliseconds | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLagMaximum` | Milliseconds | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLagMaximum` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLagMinimum` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLagMinimum` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLagMinimum` | Milliseconds | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLagMinimum` | Milliseconds | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLagMinimum` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLag` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLag` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLag` | Milliseconds | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLag` | Milliseconds | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `AuroraReplicaLag` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `BacktrackChangeRecordsCreationRate` | Count | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `BacktrackChangeRecordsCreationRate` | Count | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `BacktrackChangeRecordsCreationRate` | Count | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `BacktrackChangeRecordsCreationRate` | Count | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `BacktrackChangeRecordsCreationRate` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `BacktrackChangeRecordsStored` | Count | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `BacktrackChangeRecordsStored` | Count | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `BacktrackChangeRecordsStored` | Count | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `BacktrackChangeRecordsStored` | Count | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `BacktrackChangeRecordsStored` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `BacktrackWindowActual` | Count | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `BacktrackWindowActual` | Count | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `BacktrackWindowActual` | Count | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `BacktrackWindowActual` | Count | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `BacktrackWindowActual` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `BacktrackWindowAlert` | Count | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `BacktrackWindowAlert` | Count | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `BacktrackWindowAlert` | Count | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `BacktrackWindowAlert` | Count | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `BacktrackWindowAlert` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `BinLogDiskUsage` | Bytes | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `BinLogDiskUsage` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `BinLogDiskUsage` | Bytes | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `BinLogDiskUsage` | Bytes | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `BinLogDiskUsage` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `BlockedTransactions` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `BlockedTransactions` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `BlockedTransactions` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `BlockedTransactions` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `BlockedTransactions` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `BufferCacheHitRatio` | Percent | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `BufferCacheHitRatio` | Percent | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `BufferCacheHitRatio` | Percent | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `BufferCacheHitRatio` | Percent | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `BufferCacheHitRatio` | Percent | Region | requires_custom_metric | _—_ | _—_ |
| `CPUCreditBalance` | Count | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `CPUCreditBalance` | Count | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `CPUCreditBalance` | Count | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `CPUCreditBalance` | Count | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `CPUCreditBalance` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `CPUCreditUsage` | Count | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `CPUCreditUsage` | Count | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `CPUCreditUsage` | Count | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `CPUCreditUsage` | Count | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `CPUCreditUsage` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `CPUUtilization` | Percent | DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `CPUUtilization` | Percent | DBClusterIdentifier | dimension_change | `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `CPUUtilization` | Percent | DatabaseClass, Region | dimension_change | `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `CPUUtilization` | Percent | EngineName, Region | dimension_change | `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `CPUUtilization` | Percent | Region | dimension_change | `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `CommitLatency` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `CommitLatency` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `CommitLatency` | Milliseconds | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `CommitLatency` | Milliseconds | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `CommitLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `CommitThroughput` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `CommitThroughput` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `CommitThroughput` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `CommitThroughput` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `CommitThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `DDLLatency` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DDLLatency` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DDLLatency` | Milliseconds | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `DDLLatency` | Milliseconds | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `DDLLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `DDLThroughput` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DDLThroughput` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DDLThroughput` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `DDLThroughput` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `DDLThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `DMLLatency` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DMLLatency` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DMLLatency` | Milliseconds | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `DMLLatency` | Milliseconds | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `DMLLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `DMLThroughput` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DMLThroughput` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DMLThroughput` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `DMLThroughput` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `DMLThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `DatabaseConnections` | Count | DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `DatabaseConnections` | Count | DBClusterIdentifier | dimension_change | `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `DatabaseConnections` | Count | DatabaseClass, Region | dimension_change | `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `DatabaseConnections` | Count | EngineName, Region | dimension_change | `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `DatabaseConnections` | Count | Region | dimension_change | `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `Deadlocks` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Deadlocks` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `Deadlocks` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `Deadlocks` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `Deadlocks` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `DeleteLatency` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DeleteLatency` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DeleteLatency` | Milliseconds | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `DeleteLatency` | Milliseconds | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `DeleteLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `DeleteThroughput` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DeleteThroughput` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `DeleteThroughput` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `DeleteThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `DiskQueueDepth` | Count | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DiskQueueDepth` | Count | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DiskQueueDepth` | Count | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `DiskQueueDepth` | Count | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `DiskQueueDepth` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `FreeableMemory` | Bytes | DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `FreeableMemory` | Bytes | DBClusterIdentifier | dimension_change | `cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `FreeableMemory` | Bytes | DatabaseClass, Region | dimension_change | `cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `FreeableMemory` | Bytes | EngineName, Region | dimension_change | `cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `FreeableMemory` | Bytes | Region | dimension_change | `cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `InsertLatency` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `InsertLatency` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `InsertLatency` | Milliseconds | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `InsertLatency` | Milliseconds | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `InsertLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `InsertThroughput` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `InsertThroughput` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `InsertThroughput` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `InsertThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `LoginFailures` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `LoginFailures` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `LoginFailures` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `LoginFailures` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `LoginFailures` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `MaximumUsedTransactionIDs` | Count | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `MaximumUsedTransactionIDs` | Count | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `MaximumUsedTransactionIDs` | Count | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `MaximumUsedTransactionIDs` | Count | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `MaximumUsedTransactionIDs` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `NetworkReceiveThroughput` | Bytes/Second | DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.NetworkReceiveThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkReceiveThroughput` | Bytes/Second | DBClusterIdentifier | dimension_change | `cloud.aws.rds.NetworkReceiveThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkReceiveThroughput` | Bytes/Second | DatabaseClass, Region | dimension_change | `cloud.aws.rds.NetworkReceiveThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkReceiveThroughput` | Bytes/Second | EngineName, Region | dimension_change | `cloud.aws.rds.NetworkReceiveThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkReceiveThroughput` | Bytes/Second | Region | dimension_change | `cloud.aws.rds.NetworkReceiveThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkThroughput` | Bytes/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `NetworkThroughput` | Bytes/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkThroughput` | Bytes/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `NetworkThroughput` | Bytes/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `NetworkThroughput` | Bytes/Second | Region | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.NetworkTransmitThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkTransmitThroughput` | Bytes/Second | DBClusterIdentifier | dimension_change | `cloud.aws.rds.NetworkTransmitThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkTransmitThroughput` | Bytes/Second | DatabaseClass, Region | dimension_change | `cloud.aws.rds.NetworkTransmitThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkTransmitThroughput` | Bytes/Second | EngineName, Region | dimension_change | `cloud.aws.rds.NetworkTransmitThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkTransmitThroughput` | Bytes/Second | Region | dimension_change | `cloud.aws.rds.NetworkTransmitThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `Queries` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `Queries` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `Queries` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `Queries` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `RDSToAuroraPostgreSQLReplicaLag` | Seconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `RDSToAuroraPostgreSQLReplicaLag` | Seconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `RDSToAuroraPostgreSQLReplicaLag` | Seconds | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `RDSToAuroraPostgreSQLReplicaLag` | Seconds | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `RDSToAuroraPostgreSQLReplicaLag` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `ReadIOPS` | Count/Second | DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.ReadIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadIOPS` | Count/Second | DBClusterIdentifier | dimension_change | `cloud.aws.rds.ReadIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadIOPS` | Count/Second | DatabaseClass, Region | dimension_change | `cloud.aws.rds.ReadIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadIOPS` | Count/Second | EngineName, Region | dimension_change | `cloud.aws.rds.ReadIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadIOPS` | Count/Second | Region | dimension_change | `cloud.aws.rds.ReadIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadLatency` | Seconds | DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadLatency` | Seconds | DBClusterIdentifier | dimension_change | `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadLatency` | Seconds | DatabaseClass, Region | dimension_change | `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadLatency` | Seconds | EngineName, Region | dimension_change | `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadLatency` | Seconds | Region | dimension_change | `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadThroughput` | Bytes/Second | DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.ReadThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadThroughput` | Bytes/Second | DBClusterIdentifier | dimension_change | `cloud.aws.rds.ReadThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadThroughput` | Bytes/Second | DatabaseClass, Region | dimension_change | `cloud.aws.rds.ReadThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadThroughput` | Bytes/Second | EngineName, Region | dimension_change | `cloud.aws.rds.ReadThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadThroughput` | Bytes/Second | Region | dimension_change | `cloud.aws.rds.ReadThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ResultSetCacheHitRatio` | Percent | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ResultSetCacheHitRatio` | Percent | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ResultSetCacheHitRatio` | Percent | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `ResultSetCacheHitRatio` | Percent | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `ResultSetCacheHitRatio` | Percent | Region | requires_custom_metric | _—_ | _—_ |
| `SelectLatency` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `SelectLatency` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `SelectLatency` | Milliseconds | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `SelectLatency` | Milliseconds | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `SelectLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `SelectThroughput` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `SelectThroughput` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `SelectThroughput` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `SelectThroughput` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `SelectThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `SwapUsage` | Bytes | DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `SwapUsage` | Bytes | DBClusterIdentifier | dimension_change | `cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `SwapUsage` | Bytes | DatabaseClass, Region | dimension_change | `cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `SwapUsage` | Bytes | EngineName, Region | dimension_change | `cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `SwapUsage` | Bytes | Region | dimension_change | `cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `TransactionLogsDiskUsage` | Bytes | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `TransactionLogsDiskUsage` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `TransactionLogsDiskUsage` | Bytes | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `TransactionLogsDiskUsage` | Bytes | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `TransactionLogsDiskUsage` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `UpdateLatency` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `UpdateLatency` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `UpdateLatency` | Milliseconds | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `UpdateLatency` | Milliseconds | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `UpdateLatency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `UpdateThroughput` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `UpdateThroughput` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `UpdateThroughput` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `UpdateThroughput` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `VolumeBytesUsed` | Bytes | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `VolumeBytesUsed` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `VolumeBytesUsed` | Bytes | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `VolumeBytesUsed` | Bytes | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `VolumeBytesUsed` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `VolumeReadIOPs` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `VolumeReadIOPs` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `VolumeReadIOPs` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `VolumeReadIOPs` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `VolumeReadIOPs` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `VolumeWriteIOPs` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `VolumeWriteIOPs` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `VolumeWriteIOPs` | Count/Second | DatabaseClass, Region | requires_custom_metric | _—_ | _—_ |
| `VolumeWriteIOPs` | Count/Second | EngineName, Region | requires_custom_metric | _—_ | _—_ |
| `VolumeWriteIOPs` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `WriteIOPS` | Count/Second | DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.WriteIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteIOPS` | Count/Second | DBClusterIdentifier | dimension_change | `cloud.aws.rds.WriteIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteIOPS` | Count/Second | DatabaseClass, Region | dimension_change | `cloud.aws.rds.WriteIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteIOPS` | Count/Second | EngineName, Region | dimension_change | `cloud.aws.rds.WriteIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteIOPS` | Count/Second | Region | dimension_change | `cloud.aws.rds.WriteIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteLatency` | Seconds | DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteLatency` | Seconds | DBClusterIdentifier | dimension_change | `cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteLatency` | Seconds | DatabaseClass, Region | dimension_change | `cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteLatency` | Seconds | EngineName, Region | dimension_change | `cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteLatency` | Seconds | Region | dimension_change | `cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteThroughput` | Bytes/Second | DBClusterIdentifier, Role | dimension_change | `cloud.aws.rds.WriteThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteThroughput` | Bytes/Second | DBClusterIdentifier | dimension_change | `cloud.aws.rds.WriteThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteThroughput` | Bytes/Second | DatabaseClass, Region | dimension_change | `cloud.aws.rds.WriteThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteThroughput` | Bytes/Second | EngineName, Region | dimension_change | `cloud.aws.rds.WriteThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteThroughput` | Bytes/Second | Region | dimension_change | `cloud.aws.rds.WriteThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |

</details>

### Billing (`billing`)

- Classic entity: `None` (dimension `None`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (2)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `EstimatedCharges` | Count | ServiceName, Currency | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `EstimatedCharges` | Count | Region, Currency | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

### Chatbot (`chatbot`)

- Classic entity: `None` (dimension `None`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (7)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `EventsProcessed` | Count | ConfigurationName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `EventsProcessed` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `EventsThrottled` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `MessageDeliveryFailure` | Count | ConfigurationName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `MessageDeliveryFailure` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `UnsupportedEvents` | Count | ConfigurationName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `UnsupportedEvents` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (2)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `MessageDeliverySuccess` | Count | ConfigurationName | no_new_coverage | _—_ | _—_ |
| `MessageDeliverySuccess` | Count | Region | no_new_coverage | _—_ | _—_ |

</details>

### CloudFront (`cloudfront`)

- Classic entity: `cloud:aws:cloud_front` (dimension `DistributionId`)
- New block: `AWS::CloudFront::Distribution` → Smartscape `AWS_CLOUDFRONT_DISTRIBUTION`
- Namespaces: `AWS/CloudFront`
- New recommended metrics: 6

**Raw CloudWatch metrics — Recommended (2)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `Requests` | None | DistributionId, Region | direct | `cloud.aws.cloudfront.Requests.By.DistributionId.Region` | DistributionId, Region |  |
| `TotalErrorRate` | Percent | DistributionId, Region | direct | `cloud.aws.cloudfront.TotalErrorRate.By.DistributionId.Region` | DistributionId, Region |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (4)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `4xxErrorRate` | Percent | DistributionId, Region | direct | `cloud.aws.cloudfront.4xxErrorRate.By.DistributionId.Region` | DistributionId, Region |
| `5xxErrorRate` | Percent | DistributionId, Region | direct | `cloud.aws.cloudfront.5xxErrorRate.By.DistributionId.Region` | DistributionId, Region |
| `BytesDownloaded` | None | DistributionId, Region | direct | `cloud.aws.cloudfront.BytesDownloaded.By.DistributionId.Region` | DistributionId, Region |
| `BytesUploaded` | None | DistributionId, Region | direct | `cloud.aws.cloudfront.BytesUploaded.By.DistributionId.Region` | DistributionId, Region |

</details>

### CloudHSMv2 (`cloudhsm_v2`)

- Classic entity: `cloud:aws:cloudhsm` (dimension `ClusterId`)
- New block: `AWS::CloudHSM::Cluster` → Smartscape `AWS_CLOUDHSM_CLUSTER`
- Namespaces: `AWS/CloudHSM`
- New recommended metrics: 8

**Raw CloudWatch metrics — Recommended (19)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `HsmUnhealthy` | None | ClusterId, HsmId | direct | `cloud.aws.cloudhsm.HsmUnhealthy.By.ClusterId.HsmId` | ClusterId, HsmId |  |
| `HsmUnhealthy` | None | ClusterId | direct | `cloud.aws.cloudhsm.HsmUnhealthy.By.ClusterId.HsmId` | ClusterId, HsmId | dimension set differs slightly (classic=['ClusterId'] vs new=['ClusterId', 'HsmId']) |
| `HsmUnhealthy` | None | Region | dimension_change | `cloud.aws.cloudhsm.HsmUnhealthy.By.ClusterId.HsmId` | ClusterId, HsmId | same CW metric, different dimensioning (classic=['Region'] vs new=['ClusterId', 'HsmId']) |
| `HsmTemperature` | None | ClusterId, HsmId | direct | `cloud.aws.cloudhsm.HsmTemperature.By.ClusterId.HsmId` | ClusterId, HsmId |  |
| `HsmTemperature` | None | ClusterId | direct | `cloud.aws.cloudhsm.HsmTemperature.By.ClusterId.HsmId` | ClusterId, HsmId | dimension set differs slightly (classic=['ClusterId'] vs new=['ClusterId', 'HsmId']) |
| `HsmKeysSessionOccupied` | Count | ClusterId, HsmId | direct | `cloud.aws.cloudhsm.HsmKeysSessionOccupied.By.ClusterId.HsmId` | ClusterId, HsmId |  |
| `HsmKeysSessionOccupied` | Count | ClusterId | direct | `cloud.aws.cloudhsm.HsmKeysSessionOccupied.By.ClusterId.HsmId` | ClusterId, HsmId | dimension set differs slightly (classic=['ClusterId'] vs new=['ClusterId', 'HsmId']) |
| `HsmKeysSessionOccupied` | Count | Region | dimension_change | `cloud.aws.cloudhsm.HsmKeysSessionOccupied.By.ClusterId.HsmId` | ClusterId, HsmId | same CW metric, different dimensioning (classic=['Region'] vs new=['ClusterId', 'HsmId']) |
| `HsmKeysTokenOccupied` | Count | ClusterId, HsmId | direct | `cloud.aws.cloudhsm.HsmKeysTokenOccupied.By.ClusterId.HsmId` | ClusterId, HsmId |  |
| `HsmKeysTokenOccupied` | Count | ClusterId | direct | `cloud.aws.cloudhsm.HsmKeysTokenOccupied.By.ClusterId.HsmId` | ClusterId, HsmId | dimension set differs slightly (classic=['ClusterId'] vs new=['ClusterId', 'HsmId']) |
| `HsmKeysTokenOccupied` | Count | Region | dimension_change | `cloud.aws.cloudhsm.HsmKeysTokenOccupied.By.ClusterId.HsmId` | ClusterId, HsmId | same CW metric, different dimensioning (classic=['Region'] vs new=['ClusterId', 'HsmId']) |
| `HsmSslCtxsOccupied` | Count | ClusterId, HsmId | direct | `cloud.aws.cloudhsm.HsmSslCtxsOccupied.By.ClusterId.HsmId` | ClusterId, HsmId |  |
| `HsmSslCtxsOccupied` | Count | ClusterId | direct | `cloud.aws.cloudhsm.HsmSslCtxsOccupied.By.ClusterId.HsmId` | ClusterId, HsmId | dimension set differs slightly (classic=['ClusterId'] vs new=['ClusterId', 'HsmId']) |
| `HsmSessionCount` | Count | ClusterId, HsmId | direct | `cloud.aws.cloudhsm.HsmSessionCount.By.ClusterId.HsmId` | ClusterId, HsmId |  |
| `HsmSessionCount` | Count | ClusterId | direct | `cloud.aws.cloudhsm.HsmSessionCount.By.ClusterId.HsmId` | ClusterId, HsmId | dimension set differs slightly (classic=['ClusterId'] vs new=['ClusterId', 'HsmId']) |
| `HsmUsersAvailable` | Count | ClusterId, HsmId | direct | `cloud.aws.cloudhsm.HsmUsersAvailable.By.ClusterId.HsmId` | ClusterId, HsmId |  |
| `HsmUsersAvailable` | Count | ClusterId | direct | `cloud.aws.cloudhsm.HsmUsersAvailable.By.ClusterId.HsmId` | ClusterId, HsmId | dimension set differs slightly (classic=['ClusterId'] vs new=['ClusterId', 'HsmId']) |
| `HsmUsersMax` | Count | ClusterId, HsmId | direct | `cloud.aws.cloudhsm.HsmUsersMax.By.ClusterId.HsmId` | ClusterId, HsmId |  |
| `HsmUsersMax` | Count | ClusterId | direct | `cloud.aws.cloudhsm.HsmUsersMax.By.ClusterId.HsmId` | ClusterId, HsmId | dimension set differs slightly (classic=['ClusterId'] vs new=['ClusterId', 'HsmId']) |

<details><summary>Raw CloudWatch metrics — Non-recommended (29)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `HsmTemperature` | None | Region | dimension_change | `cloud.aws.cloudhsm.HsmTemperature.By.ClusterId.HsmId` | ClusterId, HsmId |
| `HsmSslCtxsOccupied` | Count | Region | dimension_change | `cloud.aws.cloudhsm.HsmSslCtxsOccupied.By.ClusterId.HsmId` | ClusterId, HsmId |
| `HsmSessionCount` | Count | Region | dimension_change | `cloud.aws.cloudhsm.HsmSessionCount.By.ClusterId.HsmId` | ClusterId, HsmId |
| `HsmUsersAvailable` | Count | Region | dimension_change | `cloud.aws.cloudhsm.HsmUsersAvailable.By.ClusterId.HsmId` | ClusterId, HsmId |
| `HsmUsersMax` | Count | Region | dimension_change | `cloud.aws.cloudhsm.HsmUsersMax.By.ClusterId.HsmId` | ClusterId, HsmId |
| `InterfaceEth2DroppedInput` | Count | ClusterId, HsmId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2DroppedInput` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2DroppedInput` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2ErrorsInput` | Count | ClusterId, HsmId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2ErrorsInput` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2ErrorsInput` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2OctetsInput` | Count | ClusterId, HsmId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2OctetsInput` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2OctetsInput` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2PacketsInput` | Count | ClusterId, HsmId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2PacketsInput` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2PacketsInput` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2DroppedOutput` | Count | ClusterId, HsmId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2DroppedOutput` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2DroppedOutput` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2ErrorsOutput` | Count | ClusterId, HsmId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2ErrorsOutput` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2ErrorsOutput` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2OctetsOutput` | Count | ClusterId, HsmId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2OctetsOutput` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2OctetsOutput` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2PacketsOutput` | Count | ClusterId, HsmId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2PacketsOutput` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `InterfaceEth2PacketsOutput` | Count | Region | requires_custom_metric | _—_ | _—_ |

</details>

### CloudSearch (`cloudsearch`)

- Classic entity: `cloud:aws:cloudsearch` (dimension `DomainName`)
- Matched 2 new blocks:
  - `AWS::OpenSearch::Domain` → `AWS_OPENSEARCH_DOMAIN` (namespaces: `AWS/ES`, recommended: 54)
  - `AWS::OpenSearchServerless::Collection` → `AWS_OPENSEARCHSERVERLESS_COLLECTION` (namespaces: `AWS/AOSS`, recommended: 24)

**Raw CloudWatch metrics — Recommended (4)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `IndexUtilization` | Percent | DomainName, ClientId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `Partitions` | Count | DomainName, ClientId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `SearchableDocuments` | Count | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.SearchableDocuments.By.ClientId.DomainName` | ClientId, DomainName |  |
| `SuccessfulRequests` | Count | DomainName, ClientId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

### CloudWatchLogs (`cloudwatch_logs`)

- Classic entity: `cloud:aws:logs` (dimension `LogGroupName`)
- New block: `AWS::Logs::LogGroup` → Smartscape `AWS_LOGS_LOGGROUP`
- Namespaces: `AWS/Logs`
- New recommended metrics: 12

**Raw CloudWatch metrics — Recommended (8)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `DeliveryErrors` | Count | LogGroupName, DestinationType, FilterName | direct | `cloud.aws.logs.DeliveryErrors.By.LogGroupName` | LogGroupName | dimension set differs slightly (classic=['LogGroupName', 'DestinationType', 'FilterName'] vs new=['LogGroupName']) |
| `DeliveryThrottling` | Count | LogGroupName, DestinationType, FilterName | direct | `cloud.aws.logs.DeliveryThrottling.By.LogGroupName` | LogGroupName | dimension set differs slightly (classic=['LogGroupName', 'DestinationType', 'FilterName'] vs new=['LogGroupName']) |
| `ForwardedBytes` | Bytes | LogGroupName, DestinationType, FilterName | direct | `cloud.aws.logs.ForwardedBytes.By.DestinationType.FilterName.LogGroupName` | DestinationType, FilterName, LogGroupName |  |
| `ForwardedLogEvents` | Count | LogGroupName, DestinationType, FilterName | direct | `cloud.aws.logs.ForwardedLogEvents.By.LogGroupName` | LogGroupName | dimension set differs slightly (classic=['LogGroupName', 'DestinationType', 'FilterName'] vs new=['LogGroupName']) |
| `IncomingBytes` | Bytes | LogGroupName | direct | `cloud.aws.logs.IncomingBytes.By.LogGroupName` | LogGroupName |  |
| `IncomingBytes` | Bytes | Region | dimension_change | `cloud.aws.logs.IncomingBytes.By.LogGroupName` | LogGroupName | same CW metric, different dimensioning (classic=['Region'] vs new=['LogGroupName']) |
| `IncomingLogEvents` | Count | LogGroupName | direct | `cloud.aws.logs.IncomingLogEvents.By.LogGroupName` | LogGroupName |  |
| `IncomingLogEvents` | Count | Region | dimension_change | `cloud.aws.logs.IncomingLogEvents.By.LogGroupName` | LogGroupName | same CW metric, different dimensioning (classic=['Region'] vs new=['LogGroupName']) |

### APIUsage (`api_usage`)

- Classic entity: `None` (dimension `None`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (2)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CallCount` | Count | Service, Class, Resource, Type | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ResourceCount` | Count | Service, Class, Resource, Type | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

### CodeBuild (`codebuild`)

- Classic entity: `cloud:aws:codebuild` (dimension `ProjectName`)
- New block: `AWS::ECS::Cluster` → Smartscape `AWS_ECS_CLUSTER`
- Namespaces: _none_
- New recommended metrics: 23

**Raw CloudWatch metrics — Recommended (13)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `BuildDuration` | Seconds | ProjectName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `Builds` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `Builds` | Count | ProjectName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CPUUtilizedPercent` | Percent | ProjectName, BuildId, BuildNumber | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `Duration` | Seconds | ProjectName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `FailedBuilds` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `FailedBuilds` | Count | ProjectName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MemoryUtilizedPercent` | Percent | ProjectName, BuildId, BuildNumber | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `QueuedDuration` | Seconds | ProjectName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `StorageReadBytes` | Bytes/Second | ProjectName, BuildId, BuildNumber | dimension_change | `cloud.aws.ecs_containerinsights.StorageReadBytes.By.ClusterName` | ClusterName | same CW metric, different dimensioning (classic=['ProjectName', 'BuildId', 'BuildNumber'] vs new=['ClusterName']) |
| `StorageWriteBytes` | Bytes/Second | ProjectName, BuildId, BuildNumber | dimension_change | `cloud.aws.ecs_containerinsights.StorageWriteBytes.By.ClusterName` | ClusterName | same CW metric, different dimensioning (classic=['ProjectName', 'BuildId', 'BuildNumber'] vs new=['ClusterName']) |
| `SucceededBuilds` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `SucceededBuilds` | Count | ProjectName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (27)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `BuildDuration` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `CPUUtilized` | None | ProjectName | requires_custom_metric | _—_ | _—_ |
| `CPUUtilized` | None | ProjectName, BuildId, BuildNumber | requires_custom_metric | _—_ | _—_ |
| `CPUUtilizedPercent` | Percent | ProjectName | requires_custom_metric | _—_ | _—_ |
| `DownloadSourceDuration` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `DownloadSourceDuration` | Seconds | ProjectName | requires_custom_metric | _—_ | _—_ |
| `Duration` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `FinalizingDuration` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `FinalizingDuration` | Seconds | ProjectName | requires_custom_metric | _—_ | _—_ |
| `InstallDuration` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `InstallDuration` | Seconds | ProjectName | requires_custom_metric | _—_ | _—_ |
| `MemoryUtilized` | Megabytes | ProjectName | dimension_change | `cloud.aws.ecs_containerinsights.MemoryUtilized.By.ClusterName` | ClusterName |
| `MemoryUtilized` | Megabytes | ProjectName, BuildId, BuildNumber | dimension_change | `cloud.aws.ecs_containerinsights.MemoryUtilized.By.ClusterName` | ClusterName |
| `MemoryUtilizedPercent` | Percent | ProjectName | requires_custom_metric | _—_ | _—_ |
| `PostBuildDuration` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `PostBuildDuration` | Seconds | ProjectName | requires_custom_metric | _—_ | _—_ |
| `PreBuildDuration` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `PreBuildDuration` | Seconds | ProjectName | requires_custom_metric | _—_ | _—_ |
| `ProvisioningDuration` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `ProvisioningDuration` | Seconds | ProjectName | requires_custom_metric | _—_ | _—_ |
| `QueuedDuration` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `StorageReadBytes` | Bytes/Second | ProjectName | dimension_change | `cloud.aws.ecs_containerinsights.StorageReadBytes.By.ClusterName` | ClusterName |
| `StorageWriteBytes` | Bytes/Second | ProjectName | dimension_change | `cloud.aws.ecs_containerinsights.StorageWriteBytes.By.ClusterName` | ClusterName |
| `SubmittedDuration` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `SubmittedDuration` | Seconds | ProjectName | requires_custom_metric | _—_ | _—_ |
| `UploadArtifactsDuration` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `UploadArtifactsDuration` | Seconds | ProjectName | requires_custom_metric | _—_ | _—_ |

</details>

### Cognito (`cognito`)

- Classic entity: `None` (dimension `UserPoolId`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (5)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `AccountTakeOverRisk` | Count | Region, RiskLevel | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `CompromisedCredentialsRisk` | Count | Region, Operation, UserPoolId, RiskLevel | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `NoRisk` | Count | Region, Operation, UserPoolId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `OverrideBlock` | Count | Region, RiskLevel | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Risk` | Count | Region, Operation, UserPoolId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

### Connect (`connect`)

- Classic entity: `None` (dimension `InstanceId`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (10)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CallRecordingUploadError` | Count | InstanceId, MetricGroup | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `CallsPerInterval` | Count | InstanceId, MetricGroup | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ConcurrentCalls` | Count | InstanceId, MetricGroup | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ConcurrentCallsPercentage` | Percent | InstanceId, MetricGroup | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ContactFlowErrors` | Count | InstanceId, ContactFlowName, MetricGroup | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `LongestQueueWaitTime` | Seconds | InstanceId, MetricGroup, QueueName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `MissedCalls` | Count | InstanceId, MetricGroup | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `QueueCapacityExceededError` | Count | InstanceId, MetricGroup, QueueName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `QueueSize` | Count | InstanceId, MetricGroup, QueueName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ToInstancePacketLossRate` | None | Region, Instance ID, Participant, Stream Type, Type of Connection | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (6)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `CallBackNotDialableNumber` | Count | InstanceId, ContactFlowName, MetricGroup | no_new_coverage | _—_ | _—_ |
| `CallsBreachingConcurrencyQuota` | Count | _—_ | no_new_coverage | _—_ | _—_ |
| `ContactFlowFatalErrors` | Count | InstanceId, ContactFlowName, MetricGroup | no_new_coverage | _—_ | _—_ |
| `MisconfiguredPhoneNumbers` | Count | InstanceId, MetricGroup | no_new_coverage | _—_ | _—_ |
| `PublicSigningKeyUsage` | Count | InstanceId, SigningKeyId | no_new_coverage | _—_ | _—_ |
| `ThrottledCalls` | Count | InstanceId, MetricGroup | no_new_coverage | _—_ | _—_ |

</details>

### DMS (`dms`)

- Classic entity: `cloud:aws:dms` (dimension `ReplicationInstanceIdentifier`)
- New block: `AWS::DMS::ReplicationInstance` → Smartscape `AWS_DMS_REPLICATIONINSTANCE`
- Namespaces: `AWS/DMS`
- New recommended metrics: 10

**Raw CloudWatch metrics — Recommended (36)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CDCIncomingChanges` | Count | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CDCLatencySource` | Seconds | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CDCLatencyTarget` | Seconds | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CDCThroughputBandwidthSource` | Kilobytes/Second | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CDCThroughputBandwidthTarget` | Kilobytes/Second | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CDCThroughputRowsSource` | Count/Second | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CDCThroughputRowsTarget` | Count/Second | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CPUUtilization` | Percent | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | direct | `cloud.aws.dms.CPUUtilization.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |  |
| `CPUUtilization` | Percent | ReplicationInstanceIdentifier | direct | `cloud.aws.dms.CPUUtilization.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | dimension set differs slightly (classic=['ReplicationInstanceIdentifier'] vs new=['ReplicationInstanceIdentifier', 'ReplicationTaskIdentifier']) |
| `CPUUtilization` | Percent | Region, ReplicationInstanceExternalResourceId | dimension_change | `cloud.aws.dms.CPUUtilization.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | same CW metric, different dimensioning (classic=['Region', 'ReplicationInstanceExternalResourceId'] vs new=['ReplicationInstanceIdentifier', 'ReplicationTaskIdentifier']) |
| `CPUUtilization` | Percent | Region | dimension_change | `cloud.aws.dms.CPUUtilization.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | same CW metric, different dimensioning (classic=['Region'] vs new=['ReplicationInstanceIdentifier', 'ReplicationTaskIdentifier']) |
| `FreeStorageSpace` | Bytes | ReplicationInstanceIdentifier | direct | `cloud.aws.dms.FreeStorageSpace.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | dimension set differs slightly (classic=['ReplicationInstanceIdentifier'] vs new=['ReplicationInstanceIdentifier', 'ReplicationTaskIdentifier']) |
| `FreeableMemory` | Bytes | ReplicationInstanceIdentifier | direct | `cloud.aws.dms.FreeableMemory.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | dimension set differs slightly (classic=['ReplicationInstanceIdentifier'] vs new=['ReplicationInstanceIdentifier', 'ReplicationTaskIdentifier']) |
| `FullLoadThroughputBandwidthSource` | Kilobytes/Second | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `FullLoadThroughputBandwidthTarget` | Kilobytes/Second | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `FullLoadThroughputRowsSource` | Count/Second | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `FullLoadThroughputRowsTarget` | Count/Second | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MemoryUsage` | Megabytes | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | direct | `cloud.aws.dms.MemoryUsage.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |  |
| `NetworkReceiveThroughput` | Bytes/Second | ReplicationInstanceIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `NetworkTransmitThroughput` | Bytes/Second | ReplicationInstanceIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ReadIOPS` | Count/Second | ReplicationInstanceIdentifier | direct | `cloud.aws.dms.ReadIOPS.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | dimension set differs slightly (classic=['ReplicationInstanceIdentifier'] vs new=['ReplicationInstanceIdentifier', 'ReplicationTaskIdentifier']) |
| `ReadLatency` | Seconds | ReplicationInstanceIdentifier | direct | `cloud.aws.dms.ReadLatency.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | dimension set differs slightly (classic=['ReplicationInstanceIdentifier'] vs new=['ReplicationInstanceIdentifier', 'ReplicationTaskIdentifier']) |
| `ReadThroughput` | Bytes/Second | ReplicationInstanceIdentifier | direct | `cloud.aws.dms.ReadThroughput.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | dimension set differs slightly (classic=['ReplicationInstanceIdentifier'] vs new=['ReplicationInstanceIdentifier', 'ReplicationTaskIdentifier']) |
| `RecoveryCount` | Count | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `RunCounter` | Count | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `SwapUsage` | Bytes | ReplicationInstanceIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ValidationAttemptedRecordCount` | Count | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ValidationBulkQuerySourceLatency` | Milliseconds | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ValidationBulkQueryTargetLatency` | Milliseconds | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ValidationFailedOverallCount` | Count | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ValidationPendingOverallCount` | Count | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ValidationSucceededRecordCount` | Count | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ValidationSuspendedOverallCount` | Count | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `WriteIOPS` | Count/Second | ReplicationInstanceIdentifier | direct | `cloud.aws.dms.WriteIOPS.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | dimension set differs slightly (classic=['ReplicationInstanceIdentifier'] vs new=['ReplicationInstanceIdentifier', 'ReplicationTaskIdentifier']) |
| `WriteLatency` | Seconds | ReplicationInstanceIdentifier | direct | `cloud.aws.dms.WriteLatency.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | dimension set differs slightly (classic=['ReplicationInstanceIdentifier'] vs new=['ReplicationInstanceIdentifier', 'ReplicationTaskIdentifier']) |
| `WriteThroughput` | Bytes/Second | ReplicationInstanceIdentifier | direct | `cloud.aws.dms.WriteThroughput.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | dimension set differs slightly (classic=['ReplicationInstanceIdentifier'] vs new=['ReplicationInstanceIdentifier', 'ReplicationTaskIdentifier']) |

<details><summary>Raw CloudWatch metrics — Non-recommended (46)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `CDCChangesDiskSource` | Count | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ |
| `CDCChangesDiskTarget` | Count | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ |
| `CDCChangesMemorySource` | Count | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ |
| `CDCChangesMemoryTarget` | Count | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ |
| `CPUAllocated` | Percent | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ |
| `CPUUtilization` | Percent | Region, InstanceClass | dimension_change | `cloud.aws.dms.CPUUtilization.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `DiskQueueDepth` | Count | Region, ReplicationInstanceExternalResourceId | requires_custom_metric | _—_ | _—_ |
| `DiskQueueDepth` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `DiskQueueDepth` | Count | Region, InstanceClass | requires_custom_metric | _—_ | _—_ |
| `DiskQueueDepth` | Count | ReplicationInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `FreeStorageSpace` | Bytes | Region, ReplicationInstanceExternalResourceId | dimension_change | `cloud.aws.dms.FreeStorageSpace.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `FreeStorageSpace` | Bytes | Region | dimension_change | `cloud.aws.dms.FreeStorageSpace.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `FreeStorageSpace` | Bytes | Region, InstanceClass | dimension_change | `cloud.aws.dms.FreeStorageSpace.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `FreeableMemory` | Bytes | Region, ReplicationInstanceExternalResourceId | dimension_change | `cloud.aws.dms.FreeableMemory.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `FreeableMemory` | Bytes | Region | dimension_change | `cloud.aws.dms.FreeableMemory.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `FreeableMemory` | Bytes | Region, InstanceClass | dimension_change | `cloud.aws.dms.FreeableMemory.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `MemoryAllocated` | Megabytes | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkReceiveThroughput` | Bytes/Second | Region, ReplicationInstanceExternalResourceId | requires_custom_metric | _—_ | _—_ |
| `NetworkReceiveThroughput` | Bytes/Second | Region | requires_custom_metric | _—_ | _—_ |
| `NetworkReceiveThroughput` | Bytes/Second | Region, InstanceClass | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | Region, ReplicationInstanceExternalResourceId | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | Region | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | Region, InstanceClass | requires_custom_metric | _—_ | _—_ |
| `ReadIOPS` | Count/Second | Region, ReplicationInstanceExternalResourceId | dimension_change | `cloud.aws.dms.ReadIOPS.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `ReadIOPS` | Count/Second | Region | dimension_change | `cloud.aws.dms.ReadIOPS.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `ReadIOPS` | Count/Second | Region, InstanceClass | dimension_change | `cloud.aws.dms.ReadIOPS.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `ReadLatency` | Seconds | Region, ReplicationInstanceExternalResourceId | dimension_change | `cloud.aws.dms.ReadLatency.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `ReadLatency` | Seconds | Region | dimension_change | `cloud.aws.dms.ReadLatency.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `ReadLatency` | Seconds | Region, InstanceClass | dimension_change | `cloud.aws.dms.ReadLatency.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `ReadThroughput` | Bytes/Second | Region, ReplicationInstanceExternalResourceId | dimension_change | `cloud.aws.dms.ReadThroughput.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `ReadThroughput` | Bytes/Second | Region | dimension_change | `cloud.aws.dms.ReadThroughput.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `ReadThroughput` | Bytes/Second | Region, InstanceClass | dimension_change | `cloud.aws.dms.ReadThroughput.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `SwapUsage` | Bytes | Region, ReplicationInstanceExternalResourceId | requires_custom_metric | _—_ | _—_ |
| `SwapUsage` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `SwapUsage` | Bytes | Region, InstanceClass | requires_custom_metric | _—_ | _—_ |
| `ValidationItemQuerySourceLatency` | Milliseconds | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ |
| `ValidationItemQueryTargetLatency` | Milliseconds | ReplicationInstanceIdentifier, ReplicationTaskIdentifier | requires_custom_metric | _—_ | _—_ |
| `WriteIOPS` | Count/Second | Region, ReplicationInstanceExternalResourceId | dimension_change | `cloud.aws.dms.WriteIOPS.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `WriteIOPS` | Count/Second | Region | dimension_change | `cloud.aws.dms.WriteIOPS.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `WriteIOPS` | Count/Second | Region, InstanceClass | dimension_change | `cloud.aws.dms.WriteIOPS.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `WriteLatency` | Seconds | Region, ReplicationInstanceExternalResourceId | dimension_change | `cloud.aws.dms.WriteLatency.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `WriteLatency` | Seconds | Region | dimension_change | `cloud.aws.dms.WriteLatency.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `WriteLatency` | Seconds | Region, InstanceClass | dimension_change | `cloud.aws.dms.WriteLatency.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `WriteThroughput` | Bytes/Second | Region, ReplicationInstanceExternalResourceId | dimension_change | `cloud.aws.dms.WriteThroughput.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `WriteThroughput` | Bytes/Second | Region | dimension_change | `cloud.aws.dms.WriteThroughput.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |
| `WriteThroughput` | Bytes/Second | Region, InstanceClass | dimension_change | `cloud.aws.dms.WriteThroughput.By.ReplicationInstanceIdentifier.ReplicationTaskIdentifier` | ReplicationInstanceIdentifier, ReplicationTaskIdentifier |

</details>

### DataSync (`datasync`)

- Classic entity: `cloud:aws:datasync` (dimension `TaskId`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (4)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `BytesTransferred` | Bytes | TaskId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `BytesWritten` | Bytes | TaskId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `FilesTransferred` | Count | TaskId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `FilesVerifiedDestination` | Count | TaskId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (10)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `BytesPreparedDestination` | Bytes | TaskId | no_new_coverage | _—_ | _—_ |
| `BytesPreparedSource` | Bytes | TaskId | no_new_coverage | _—_ | _—_ |
| `BytesTransferred` | Bytes | Region, AgentId | no_new_coverage | _—_ | _—_ |
| `BytesVerifiedDestination` | Bytes | TaskId | no_new_coverage | _—_ | _—_ |
| `BytesVerifiedSource` | Bytes | TaskId | no_new_coverage | _—_ | _—_ |
| `BytesWritten` | Bytes | Region, AgentId | no_new_coverage | _—_ | _—_ |
| `FilesPreparedDestination` | Count | TaskId | no_new_coverage | _—_ | _—_ |
| `FilesPreparedSource` | Count | TaskId | no_new_coverage | _—_ | _—_ |
| `FilesTransferred` | Count | Region, AgentId | no_new_coverage | _—_ | _—_ |
| `FilesVerifiedSource` | Count | TaskId | no_new_coverage | _—_ | _—_ |

</details>

### DirectConnect (`direct_connect`)

- Classic entity: `cloud:aws:dxcon` (dimension `ConnectionId`)
- New block: `AWS::DirectConnect::DXCon` → Smartscape `AWS_DIRECTCONNECT_DXCON`
- Namespaces: `AWS/DX`
- New recommended metrics: 12

**Raw CloudWatch metrics — Recommended (8)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ConnectionBpsEgress` | Bits/Second | ConnectionId | direct | `cloud.aws.dx.ConnectionBpsEgress.By.ConnectionId` | ConnectionId |  |
| `ConnectionBpsIngress` | Bits/Second | ConnectionId | direct | `cloud.aws.dx.ConnectionBpsIngress.By.ConnectionId` | ConnectionId |  |
| `ConnectionErrorCount` | Count | ConnectionId | direct | `cloud.aws.dx.ConnectionErrorCount.By.ConnectionId` | ConnectionId |  |
| `ConnectionLightLevelRx` | DecibelMilliWatts | ConnectionId, OpticalLaneNumber | direct | `cloud.aws.dx.ConnectionLightLevelRx.By.ConnectionId.OpticalLaneNumber` | ConnectionId, OpticalLaneNumber |  |
| `ConnectionLightLevelTx` | DecibelMilliWatts | ConnectionId, OpticalLaneNumber | direct | `cloud.aws.dx.ConnectionLightLevelTx.By.ConnectionId.OpticalLaneNumber` | ConnectionId, OpticalLaneNumber |  |
| `ConnectionState` | None | ConnectionId | direct | `cloud.aws.dx.ConnectionState.By.ConnectionId` | ConnectionId |  |
| `VirtualInterfaceBpsEgress` | Bits/Second | ConnectionId, VirtualInterfaceId | direct | `cloud.aws.dx.VirtualInterfaceBpsEgress.By.ConnectionId.VirtualInterfaceId` | ConnectionId, VirtualInterfaceId |  |
| `VirtualInterfaceBpsIngress` | Bits/Second | ConnectionId, VirtualInterfaceId | direct | `cloud.aws.dx.VirtualInterfaceBpsIngress.By.ConnectionId.VirtualInterfaceId` | ConnectionId, VirtualInterfaceId |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (4)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ConnectionPpsEgress` | Count/Second | ConnectionId | direct | `cloud.aws.dx.ConnectionPpsEgress.By.ConnectionId` | ConnectionId |
| `ConnectionPpsIngress` | Count/Second | ConnectionId | direct | `cloud.aws.dx.ConnectionPpsIngress.By.ConnectionId` | ConnectionId |
| `VirtualInterfacePpsEgress` | Count/Second | ConnectionId, VirtualInterfaceId | direct | `cloud.aws.dx.VirtualInterfacePpsEgress.By.ConnectionId.VirtualInterfaceId` | ConnectionId, VirtualInterfaceId |
| `VirtualInterfacePpsIngress` | Count/Second | ConnectionId, VirtualInterfaceId | direct | `cloud.aws.dx.VirtualInterfacePpsIngress.By.ConnectionId.VirtualInterfaceId` | ConnectionId, VirtualInterfaceId |

</details>

### DocumentDB (`documentdb`)

- Classic entity: `cloud:aws:documentdb` (dimension `DBClusterIdentifier`)
- Matched 2 new blocks:
  - `AWS::DocDB::DBCluster` → `AWS_DOCDB_DBCLUSTER` (namespaces: `AWS/DocDB`, recommended: 10)
  - `AWS::DocDB::DBInstance` → `AWS_DOCDB_DBINSTANCE` (namespaces: `AWS/DocDB`, recommended: 9)

**Raw CloudWatch metrics — Recommended (19)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `BackupRetentionPeriodStorageUsed` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `BufferCacheHitRatio` | Percent | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CPUUtilization` | Percent | DBClusterIdentifier | direct | `cloud.aws.docdb.CPUUtilization.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `DatabaseConnections` | Count | DBClusterIdentifier | direct | `cloud.aws.docdb.DatabaseConnections.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `NetworkReceiveThroughput` | Bytes/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `NetworkThroughput` | Bytes/Second | DBClusterIdentifier | direct | `cloud.aws.docdb.NetworkThroughput.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `NetworkTransmitThroughput` | Bytes/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ReadIOPS` | Count/Second | DBClusterIdentifier | direct | `cloud.aws.docdb.ReadIOPS.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `ReadLatency` | Seconds | Region, DBInstanceIdentifier | direct | `cloud.aws.docdb.ReadLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier | dimension set differs slightly (classic=['Region', 'DBInstanceIdentifier'] vs new=['DBInstanceIdentifier']) |
| `ReadLatency` | Seconds | DBClusterIdentifier | direct | `cloud.aws.docdb.ReadLatency.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `ReadThroughput` | Bytes/Second | DBClusterIdentifier | direct | `cloud.aws.docdb.ReadThroughput.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `SnapshotStorageUsed` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TotalBackupStorageBilled` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `VolumeBytesUsed` | Bytes | DBClusterIdentifier | direct | `cloud.aws.docdb.VolumeBytesUsed.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `VolumeReadIOPs` | Count | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `VolumeWriteIOPs` | Count | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `WriteIOPS` | Count/Second | DBClusterIdentifier | direct | `cloud.aws.docdb.WriteIOPS.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `WriteLatency` | Seconds | DBClusterIdentifier | direct | `cloud.aws.docdb.WriteLatency.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `WriteThroughput` | Bytes/Second | DBClusterIdentifier | direct | `cloud.aws.docdb.WriteThroughput.By.DBClusterIdentifier` | DBClusterIdentifier |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (53)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `BackupRetentionPeriodStorageUsed` | Bytes | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `BufferCacheHitRatio` | Percent | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `BufferCacheHitRatio` | Percent | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `CPUUtilization` | Percent | Region, DBInstanceIdentifier | direct | `cloud.aws.docdb.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `CPUUtilization` | Percent | DBClusterIdentifier, Role | direct | `cloud.aws.docdb.CPUUtilization.By.DBClusterIdentifier` | DBClusterIdentifier |
| `ChangeStreamLogSize` | Megabytes | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ChangeStreamLogSize` | Megabytes | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ChangeStreamLogSize` | Megabytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DBClusterReplicaLagMaximum` | Milliseconds | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `DBClusterReplicaLagMaximum` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DBClusterReplicaLagMaximum` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DBClusterReplicaLagMinimum` | Milliseconds | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `DBClusterReplicaLagMinimum` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DBClusterReplicaLagMinimum` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DBInstanceReplicaLag` | Milliseconds | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `DBInstanceReplicaLag` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `DBInstanceReplicaLag` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DatabaseConnections` | Count | Region, DBInstanceIdentifier | direct | `cloud.aws.docdb.DatabaseConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `DatabaseConnections` | Count | DBClusterIdentifier, Role | direct | `cloud.aws.docdb.DatabaseConnections.By.DBClusterIdentifier` | DBClusterIdentifier |
| `DiskQueueDepth` | Count | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `DiskQueueDepth` | Count | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `DiskQueueDepth` | Count | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `EngineUptime` | Seconds | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `FreeLocalStorage` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `FreeableMemory` | Bytes | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `FreeableMemory` | Bytes | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `FreeableMemory` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkReceiveThroughput` | Bytes/Second | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkReceiveThroughput` | Bytes/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `NetworkThroughput` | Bytes/Second | Region, DBInstanceIdentifier | direct | `cloud.aws.docdb.NetworkThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NetworkThroughput` | Bytes/Second | DBClusterIdentifier, Role | direct | `cloud.aws.docdb.NetworkThroughput.By.DBClusterIdentifier` | DBClusterIdentifier |
| `NetworkTransmitThroughput` | Bytes/Second | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ReadIOPS` | Count/Second | Region, DBInstanceIdentifier | direct | `cloud.aws.docdb.ReadIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadIOPS` | Count/Second | DBClusterIdentifier, Role | direct | `cloud.aws.docdb.ReadIOPS.By.DBClusterIdentifier` | DBClusterIdentifier |
| `ReadLatency` | Seconds | DBClusterIdentifier, Role | direct | `cloud.aws.docdb.ReadLatency.By.DBClusterIdentifier` | DBClusterIdentifier |
| `ReadThroughput` | Bytes/Second | Region, DBInstanceIdentifier | direct | `cloud.aws.docdb.ReadThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `ReadThroughput` | Bytes/Second | DBClusterIdentifier, Role | direct | `cloud.aws.docdb.ReadThroughput.By.DBClusterIdentifier` | DBClusterIdentifier |
| `SnapshotStorageUsed` | Bytes | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `SwapUsage` | Bytes | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `SwapUsage` | Bytes | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `SwapUsage` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `TotalBackupStorageBilled` | Bytes | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `WriteIOPS` | Count/Second | Region, DBInstanceIdentifier | direct | `cloud.aws.docdb.WriteIOPS.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteIOPS` | Count/Second | DBClusterIdentifier, Role | direct | `cloud.aws.docdb.WriteIOPS.By.DBClusterIdentifier` | DBClusterIdentifier |
| `WriteLatency` | Seconds | Region, DBInstanceIdentifier | direct | `cloud.aws.docdb.WriteLatency.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteLatency` | Seconds | DBClusterIdentifier, Role | direct | `cloud.aws.docdb.WriteLatency.By.DBClusterIdentifier` | DBClusterIdentifier |
| `WriteThroughput` | Bytes/Second | Region, DBInstanceIdentifier | direct | `cloud.aws.docdb.WriteThroughput.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `WriteThroughput` | Bytes/Second | DBClusterIdentifier, Role | direct | `cloud.aws.docdb.WriteThroughput.By.DBClusterIdentifier` | DBClusterIdentifier |

</details>

### DAX (`dax`)

- Classic entity: `cloud:aws:dax` (dimension `ClusterId`)
- New block: `AWS::DAX::Cluster` → Smartscape `AWS_DAX_CLUSTER`
- Namespaces: `AWS/DAX`
- New recommended metrics: 20

**Raw CloudWatch metrics — Recommended (24)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CPUUtilization` | Percent | ClusterId | direct | `cloud.aws.dax.CPUUtilization.By.ClusterId` | ClusterId |  |
| `CPUUtilization` | Percent | ClusterId, NodeId | direct | `cloud.aws.dax.CPUUtilization.By.ClusterId.NodeId` | ClusterId, NodeId |  |
| `CPUUtilization` | Percent | Region | dimension_change | `cloud.aws.dax.CPUUtilization.By.ClusterId` | ClusterId | same CW metric, different dimensioning (classic=['Region'] vs new=['ClusterId']) |
| `ClientConnections` | Count | ClusterId | direct | `cloud.aws.dax.ClientConnections.By.ClusterId` | ClusterId |  |
| `ClientConnections` | Count | ClusterId, NodeId | direct | `cloud.aws.dax.ClientConnections.By.ClusterId.NodeId` | ClusterId, NodeId |  |
| `ClientConnections` | Count | Region | dimension_change | `cloud.aws.dax.ClientConnections.By.ClusterId` | ClusterId | same CW metric, different dimensioning (classic=['Region'] vs new=['ClusterId']) |
| `EstimatedDbSize` | Bytes | ClusterId | direct | `cloud.aws.dax.EstimatedDbSize.By.ClusterId` | ClusterId |  |
| `EstimatedDbSize` | Bytes | ClusterId, NodeId | direct | `cloud.aws.dax.EstimatedDbSize.By.ClusterId.NodeId` | ClusterId, NodeId |  |
| `EstimatedDbSize` | Bytes | Region | dimension_change | `cloud.aws.dax.EstimatedDbSize.By.ClusterId` | ClusterId | same CW metric, different dimensioning (classic=['Region'] vs new=['ClusterId']) |
| `EvictedSize` | Bytes | ClusterId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `EvictedSize` | Bytes | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `EvictedSize` | Bytes | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `NetworkBytesIn` | Bytes | ClusterId | direct | `cloud.aws.dax.NetworkBytesIn.By.ClusterId` | ClusterId |  |
| `NetworkBytesIn` | Bytes | ClusterId, NodeId | direct | `cloud.aws.dax.NetworkBytesIn.By.ClusterId.NodeId` | ClusterId, NodeId |  |
| `NetworkBytesIn` | Bytes | Region | dimension_change | `cloud.aws.dax.NetworkBytesIn.By.ClusterId` | ClusterId | same CW metric, different dimensioning (classic=['Region'] vs new=['ClusterId']) |
| `NetworkBytesOut` | Bytes | ClusterId | direct | `cloud.aws.dax.NetworkBytesOut.By.ClusterId` | ClusterId |  |
| `NetworkBytesOut` | Bytes | ClusterId, NodeId | direct | `cloud.aws.dax.NetworkBytesOut.By.ClusterId.NodeId` | ClusterId, NodeId |  |
| `NetworkBytesOut` | Bytes | Region | dimension_change | `cloud.aws.dax.NetworkBytesOut.By.ClusterId` | ClusterId | same CW metric, different dimensioning (classic=['Region'] vs new=['ClusterId']) |
| `NetworkPacketsIn` | Count | ClusterId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `NetworkPacketsIn` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `NetworkPacketsIn` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `NetworkPacketsOut` | Count | ClusterId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `NetworkPacketsOut` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `NetworkPacketsOut` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (63)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `BatchGetItemRequestCount` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `BatchGetItemRequestCount` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `BatchGetItemRequestCount` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `BatchWriteItemRequestCount` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `BatchWriteItemRequestCount` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `BatchWriteItemRequestCount` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `DeleteItemRequestCount` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `DeleteItemRequestCount` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `DeleteItemRequestCount` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ErrorRequestCount` | Count | ClusterId | direct | `cloud.aws.dax.ErrorRequestCount.By.ClusterId` | ClusterId |
| `ErrorRequestCount` | Count | ClusterId, NodeId | direct | `cloud.aws.dax.ErrorRequestCount.By.ClusterId.NodeId` | ClusterId, NodeId |
| `ErrorRequestCount` | Count | Region | dimension_change | `cloud.aws.dax.ErrorRequestCount.By.ClusterId` | ClusterId |
| `FailedRequestCount` | Count | ClusterId | direct | `cloud.aws.dax.FailedRequestCount.By.ClusterId` | ClusterId |
| `FailedRequestCount` | Count | ClusterId, NodeId | direct | `cloud.aws.dax.FailedRequestCount.By.ClusterId.NodeId` | ClusterId, NodeId |
| `FailedRequestCount` | Count | Region | dimension_change | `cloud.aws.dax.FailedRequestCount.By.ClusterId` | ClusterId |
| `FaultRequestCount` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `FaultRequestCount` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `FaultRequestCount` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `GetItemRequestCount` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `GetItemRequestCount` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `GetItemRequestCount` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ItemCacheHits` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `ItemCacheHits` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `ItemCacheHits` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ItemCacheMisses` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `ItemCacheMisses` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `ItemCacheMisses` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `PutItemRequestCount` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `PutItemRequestCount` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `PutItemRequestCount` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `QueryCacheHits` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `QueryCacheHits` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `QueryCacheHits` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `QueryCacheMisses` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `QueryCacheMisses` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `QueryCacheMisses` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `QueryRequestCount` | Count | ClusterId | direct | `cloud.aws.dax.QueryRequestCount.By.ClusterId` | ClusterId |
| `QueryRequestCount` | Count | ClusterId, NodeId | direct | `cloud.aws.dax.QueryRequestCount.By.ClusterId.NodeId` | ClusterId, NodeId |
| `QueryRequestCount` | Count | Region | dimension_change | `cloud.aws.dax.QueryRequestCount.By.ClusterId` | ClusterId |
| `ScanCacheHits` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `ScanCacheHits` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `ScanCacheHits` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ScanCacheMisses` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `ScanCacheMisses` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `ScanCacheMisses` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ScanRequestCount` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `ScanRequestCount` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `ScanRequestCount` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ThrottledRequestCount` | Count | ClusterId | direct | `cloud.aws.dax.ThrottledRequestCount.By.ClusterId` | ClusterId |
| `ThrottledRequestCount` | Count | ClusterId, NodeId | direct | `cloud.aws.dax.ThrottledRequestCount.By.ClusterId.NodeId` | ClusterId, NodeId |
| `ThrottledRequestCount` | Count | Region | dimension_change | `cloud.aws.dax.ThrottledRequestCount.By.ClusterId` | ClusterId |
| `TotalRequestCount` | Count | ClusterId | direct | `cloud.aws.dax.TotalRequestCount.By.ClusterId` | ClusterId |
| `TotalRequestCount` | Count | ClusterId, NodeId | direct | `cloud.aws.dax.TotalRequestCount.By.ClusterId.NodeId` | ClusterId, NodeId |
| `TotalRequestCount` | Count | Region | dimension_change | `cloud.aws.dax.TotalRequestCount.By.ClusterId` | ClusterId |
| `TransactGetItemsCount` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `TransactGetItemsCount` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `TransactGetItemsCount` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `TransactWriteItemsCount` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `TransactWriteItemsCount` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `TransactWriteItemsCount` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `UpdateItemRequestCount` | Count | ClusterId | requires_custom_metric | _—_ | _—_ |
| `UpdateItemRequestCount` | Count | ClusterId, NodeId | requires_custom_metric | _—_ | _—_ |
| `UpdateItemRequestCount` | Count | Region | requires_custom_metric | _—_ | _—_ |

</details>

### EC2API (`ec2_api`)

- Classic entity: `None` (dimension `None`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (8)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ClientErrors` | Count | Region, Action | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ClientErrors` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `RequestLimitExceeded` | Count | Region, Action | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `RequestLimitExceeded` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ServerErrors` | Count | Region, Action | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ServerErrors` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `SuccessfulCalls` | Count | Region, Action | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `SuccessfulCalls` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

### EC2AutoScalingOther (`ec2_autoscaling_other`)

- Classic entity: `cloud:aws:autoscaling` (dimension `AutoScalingGroupName`)
- New block: `AWS::AutoScaling::AutoScalingGroup` → Smartscape `AWS_AUTOSCALING_AUTOSCALINGGROUP`
- Namespaces: `AWS/AutoScaling`
- New recommended metrics: 7

**Raw CloudWatch metrics — Recommended (8)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `GroupDesiredCapacity` | Count | AutoScalingGroupName | direct | `cloud.aws.autoscaling.GroupDesiredCapacity.By.AutoScalingGroupName` | AutoScalingGroupName |  |
| `GroupInServiceInstances` | Count | AutoScalingGroupName | direct | `cloud.aws.autoscaling.GroupInServiceInstances.By.AutoScalingGroupName` | AutoScalingGroupName |  |
| `GroupMaxSize` | Count | AutoScalingGroupName | direct | `cloud.aws.autoscaling.GroupMaxSize.By.AutoScalingGroupName` | AutoScalingGroupName |  |
| `GroupMinSize` | Count | AutoScalingGroupName | direct | `cloud.aws.autoscaling.GroupMinSize.By.AutoScalingGroupName` | AutoScalingGroupName |  |
| `GroupPendingInstances` | Count | AutoScalingGroupName | direct | `cloud.aws.autoscaling.GroupPendingInstances.By.AutoScalingGroupName` | AutoScalingGroupName |  |
| `GroupStandbyInstances` | Count | AutoScalingGroupName | direct | `cloud.aws.autoscaling.GroupStandbyInstances.By.AutoScalingGroupName` | AutoScalingGroupName |  |
| `GroupTerminatingInstances` | Count | AutoScalingGroupName | direct | `cloud.aws.autoscaling.GroupTerminatingInstances.By.AutoScalingGroupName` | AutoScalingGroupName |  |
| `GroupTotalInstances` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (13)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `GroupAndWarmPoolDesiredCapacity` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ |
| `GroupAndWarmPoolTotalCapacity` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ |
| `GroupInServiceCapacity` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ |
| `GroupPendingCapacity` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ |
| `GroupStandbyCapacity` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ |
| `GroupTerminatingCapacity` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ |
| `GroupTotalCapacity` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ |
| `WarmPoolDesiredCapacity` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ |
| `WarmPoolMinSize` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ |
| `WarmPoolPendingCapacity` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ |
| `WarmPoolTerminatingCapacity` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ |
| `WarmPoolTotalCapacity` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ |
| `WarmPoolWarmedCapacity` | Count | AutoScalingGroupName | requires_custom_metric | _—_ | _—_ |

</details>

### EC2SpotFleet (`ec2_spot_fleet`)

- Classic entity: `cloud:aws:ec2_spot` (dimension `FleetRequestId`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (3)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `AvailableInstancePoolsCount` | Count | FleetRequestId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `EligibleInstancePoolCount` | Count | FleetRequestId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `PercentCapacityAllocation` | Percent | FleetRequestId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (33)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `AvailableInstancePoolsCount` | Count | AvailabilityZone, FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `AvailableInstancePoolsCount` | Count | AvailabilityZone, FleetRequestId | no_new_coverage | _—_ | _—_ |
| `AvailableInstancePoolsCount` | Count | FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `BidsSubmittedForCapacity` | Count | AvailabilityZone, FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `BidsSubmittedForCapacity` | Count | AvailabilityZone, FleetRequestId | no_new_coverage | _—_ | _—_ |
| `BidsSubmittedForCapacity` | Count | FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `BidsSubmittedForCapacity` | Count | FleetRequestId | no_new_coverage | _—_ | _—_ |
| `EligibleInstancePoolCount` | Count | AvailabilityZone, FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `EligibleInstancePoolCount` | Count | AvailabilityZone, FleetRequestId | no_new_coverage | _—_ | _—_ |
| `EligibleInstancePoolCount` | Count | FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `FulfilledCapacity` | Count | AvailabilityZone, FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `FulfilledCapacity` | Count | AvailabilityZone, FleetRequestId | no_new_coverage | _—_ | _—_ |
| `FulfilledCapacity` | Count | FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `FulfilledCapacity` | Count | FleetRequestId | no_new_coverage | _—_ | _—_ |
| `MaxPercentCapacityAllocation` | Percent | AvailabilityZone, FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `MaxPercentCapacityAllocation` | Percent | AvailabilityZone, FleetRequestId | no_new_coverage | _—_ | _—_ |
| `MaxPercentCapacityAllocation` | Percent | FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `MaxPercentCapacityAllocation` | Percent | FleetRequestId | no_new_coverage | _—_ | _—_ |
| `PendingCapacity` | Count | AvailabilityZone, FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `PendingCapacity` | Count | AvailabilityZone, FleetRequestId | no_new_coverage | _—_ | _—_ |
| `PendingCapacity` | Count | FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `PendingCapacity` | Count | FleetRequestId | no_new_coverage | _—_ | _—_ |
| `PercentCapacityAllocation` | Percent | AvailabilityZone, FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `PercentCapacityAllocation` | Percent | AvailabilityZone, FleetRequestId | no_new_coverage | _—_ | _—_ |
| `PercentCapacityAllocation` | Percent | FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `TargetCapacity` | Count | AvailabilityZone, FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `TargetCapacity` | Count | AvailabilityZone, FleetRequestId | no_new_coverage | _—_ | _—_ |
| `TargetCapacity` | Count | FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `TargetCapacity` | Count | FleetRequestId | no_new_coverage | _—_ | _—_ |
| `TerminatingCapacity` | Count | AvailabilityZone, FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `TerminatingCapacity` | Count | AvailabilityZone, FleetRequestId | no_new_coverage | _—_ | _—_ |
| `TerminatingCapacity` | Count | FleetRequestId, InstanceType | no_new_coverage | _—_ | _—_ |
| `TerminatingCapacity` | Count | FleetRequestId | no_new_coverage | _—_ | _—_ |

</details>

### ECSContainerInsights (`ecs_ci`)

- Classic entity: `cloud:aws:ecs:cluster` (dimension `ClusterName`)
- New block: `AWS::ECS::Cluster` → Smartscape `AWS_ECS_CLUSTER`
- Namespaces: _none_
- New recommended metrics: 23

**Raw CloudWatch metrics — Recommended (19)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CpuUtilized` | None | ClusterName | direct | `cloud.aws.ecs_containerinsights.CpuUtilized.By.ClusterName` | ClusterName |  |
| `CpuUtilized` | None | ClusterName, ServiceName | direct | `cloud.aws.ecs_containerinsights.CpuUtilized.By.ClusterName.ServiceName` | ClusterName, ServiceName |  |
| `MemoryUtilized` | Megabytes | ClusterName | direct | `cloud.aws.ecs_containerinsights.MemoryUtilized.By.ClusterName` | ClusterName |  |
| `MemoryUtilized` | Megabytes | ClusterName, ServiceName | direct | `cloud.aws.ecs_containerinsights.MemoryUtilized.By.ClusterName.ServiceName` | ClusterName, ServiceName |  |
| `NetworkRxBytes` | Bytes/Second | ClusterName | direct | `cloud.aws.ecs_containerinsights.NetworkRxBytes.By.ClusterName` | ClusterName |  |
| `NetworkRxBytes` | Bytes/Second | ClusterName, ServiceName | direct | `cloud.aws.ecs_containerinsights.NetworkRxBytes.By.ClusterName.ServiceName` | ClusterName, ServiceName |  |
| `NetworkTxBytes` | Bytes/Second | ClusterName, ServiceName | direct | `cloud.aws.ecs_containerinsights.NetworkTxBytes.By.ClusterName.ServiceName` | ClusterName, ServiceName |  |
| `NetworkTxBytes` | Bytes/Second | ClusterName | direct | `cloud.aws.ecs_containerinsights.NetworkTxBytes.By.ClusterName` | ClusterName |  |
| `RunningTaskCount` | Count | ClusterName, ServiceName | direct | `cloud.aws.ecs_containerinsights.RunningTaskCount.By.ClusterName.ServiceName` | ClusterName, ServiceName |  |
| `StorageReadBytes` | Bytes/Second | ClusterName | direct | `cloud.aws.ecs_containerinsights.StorageReadBytes.By.ClusterName` | ClusterName |  |
| `StorageReadBytes` | Bytes/Second | ClusterName, ServiceName | direct | `cloud.aws.ecs_containerinsights.StorageReadBytes.By.ClusterName.ServiceName` | ClusterName, ServiceName |  |
| `StorageWriteBytes` | Bytes/Second | ClusterName | direct | `cloud.aws.ecs_containerinsights.StorageWriteBytes.By.ClusterName` | ClusterName |  |
| `StorageWriteBytes` | Bytes/Second | ClusterName, ServiceName | direct | `cloud.aws.ecs_containerinsights.StorageWriteBytes.By.ClusterName.ServiceName` | ClusterName, ServiceName |  |
| `TaskCount` | Count | ClusterName | direct | `cloud.aws.ecs_containerinsights.TaskCount.By.ClusterName` | ClusterName |  |
| `instance_cpu_utilization` | Percent | ClusterName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `instance_filesystem_utilization` | Percent | ClusterName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `instance_memory_utilization` | Percent | ClusterName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `instance_network_total_bytes` | Bytes/Second | ClusterName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `instance_number_of_running_tasks` | Count | ClusterName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (31)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ContainerInstanceCount` | Count | ClusterName | direct | `cloud.aws.ecs_containerinsights.ContainerInstanceCount.By.ClusterName` | ClusterName |
| `CpuReserved` | None | ClusterName | direct | `cloud.aws.ecs_containerinsights.CpuReserved.By.ClusterName` | ClusterName |
| `CpuReserved` | None | ClusterName, TaskDefinitionFamily | direct | `cloud.aws.ecs_containerinsights.CpuReserved.By.ClusterName` | ClusterName |
| `CpuReserved` | None | ClusterName, ServiceName | direct | `cloud.aws.ecs_containerinsights.CpuReserved.By.ClusterName.ServiceName` | ClusterName, ServiceName |
| `CpuUtilized` | None | ClusterName, TaskDefinitionFamily | direct | `cloud.aws.ecs_containerinsights.CpuUtilized.By.ClusterName` | ClusterName |
| `DeploymentCount` | Count | ClusterName, ServiceName | direct | `cloud.aws.ecs_containerinsights.DeploymentCount.By.ClusterName.ServiceName` | ClusterName, ServiceName |
| `DesiredTaskCount` | Count | ClusterName, ServiceName | requires_custom_metric | _—_ | _—_ |
| `MemoryReserved` | Megabytes | ClusterName | direct | `cloud.aws.ecs_containerinsights.MemoryReserved.By.ClusterName` | ClusterName |
| `MemoryReserved` | Megabytes | ClusterName, TaskDefinitionFamily | direct | `cloud.aws.ecs_containerinsights.MemoryReserved.By.ClusterName` | ClusterName |
| `MemoryReserved` | Megabytes | ClusterName, ServiceName | direct | `cloud.aws.ecs_containerinsights.MemoryReserved.By.ClusterName.ServiceName` | ClusterName, ServiceName |
| `MemoryUtilized` | Megabytes | ClusterName, TaskDefinitionFamily | direct | `cloud.aws.ecs_containerinsights.MemoryUtilized.By.ClusterName` | ClusterName |
| `NetworkRxBytes` | Bytes/Second | ClusterName, TaskDefinitionFamily | direct | `cloud.aws.ecs_containerinsights.NetworkRxBytes.By.ClusterName` | ClusterName |
| `NetworkTxBytes` | Bytes/Second | ClusterName, TaskDefinitionFamily | direct | `cloud.aws.ecs_containerinsights.NetworkTxBytes.By.ClusterName` | ClusterName |
| `PendingTaskCount` | Count | ClusterName, ServiceName | requires_custom_metric | _—_ | _—_ |
| `ServiceCount` | Count | ClusterName | direct | `cloud.aws.ecs_containerinsights.ServiceCount.By.ClusterName` | ClusterName |
| `StorageReadBytes` | Bytes/Second | ClusterName, TaskDefinitionFamily | direct | `cloud.aws.ecs_containerinsights.StorageReadBytes.By.ClusterName` | ClusterName |
| `StorageWriteBytes` | Bytes/Second | ClusterName, TaskDefinitionFamily | direct | `cloud.aws.ecs_containerinsights.StorageWriteBytes.By.ClusterName` | ClusterName |
| `TaskSetCount` | Count | ClusterName, ServiceName | requires_custom_metric | _—_ | _—_ |
| `instance_cpu_limit` | None | ClusterName | requires_custom_metric | _—_ | _—_ |
| `instance_cpu_reserved_capacity` | Percent | ClusterName, ContainerInstanceId, InstanceId | requires_custom_metric | _—_ | _—_ |
| `instance_cpu_reserved_capacity` | Percent | ClusterName | requires_custom_metric | _—_ | _—_ |
| `instance_cpu_usage_total` | None | ClusterName | requires_custom_metric | _—_ | _—_ |
| `instance_cpu_utilization` | Percent | ClusterName, ContainerInstanceId, InstanceId | requires_custom_metric | _—_ | _—_ |
| `instance_filesystem_utilization` | Percent | ClusterName, ContainerInstanceId, InstanceId | requires_custom_metric | _—_ | _—_ |
| `instance_memory_limit` | Bytes | ClusterName | requires_custom_metric | _—_ | _—_ |
| `instance_memory_reserved_capacity` | Percent | ClusterName, ContainerInstanceId, InstanceId | requires_custom_metric | _—_ | _—_ |
| `instance_memory_reserved_capacity` | Percent | ClusterName | requires_custom_metric | _—_ | _—_ |
| `instance_memory_utilization` | Percent | ClusterName, ContainerInstanceId, InstanceId | requires_custom_metric | _—_ | _—_ |
| `instance_memory_working_set` | Bytes | ClusterName | requires_custom_metric | _—_ | _—_ |
| `instance_network_total_bytes` | Bytes/Second | ClusterName, ContainerInstanceId, InstanceId | requires_custom_metric | _—_ | _—_ |
| `instance_number_of_running_tasks` | Count | ClusterName, ContainerInstanceId, InstanceId | requires_custom_metric | _—_ | _—_ |

</details>

### ElastiCache (`elasticache`)

- Classic entity: `cloud:aws:elasticache` (dimension `CacheClusterId`)
- New block: `AWS::ElastiCache::CacheCluster` → Smartscape `AWS_ELASTICACHE_CACHECLUSTER`
- Namespaces: `AWS/ElastiCache`
- New recommended metrics: 38

**Raw CloudWatch metrics — Recommended (4)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CPUUtilization` | Percent | CacheClusterId | direct | `cloud.aws.elasticache.CPUUtilization.By.CacheClusterId` | CacheClusterId |  |
| `CurrConnections` | Count | CacheClusterId | direct | `cloud.aws.elasticache.CurrConnections.By.CacheClusterId` | CacheClusterId |  |
| `Evictions` | Count | CacheClusterId | direct | `cloud.aws.elasticache.Evictions.By.CacheClusterId` | CacheClusterId |  |
| `SwapUsage` | Bytes | CacheClusterId | direct | `cloud.aws.elasticache.SwapUsage.By.CacheClusterId` | CacheClusterId |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (124)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ActiveDefragHits` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `ActiveDefragHits` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `BytesReadIntoMemcached` | Bytes | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.BytesReadIntoMemcached.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `BytesReadIntoMemcached` | Bytes | CacheClusterId | direct | `cloud.aws.elasticache.BytesReadIntoMemcached.By.CacheClusterId` | CacheClusterId |
| `BytesUsedFworCacheItems` | Bytes | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `BytesUsedForCacheItems` | Bytes | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `BytesUsedForCache` | Bytes | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `BytesUsedForCache` | Bytes | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `BytesUsedForHash` | Bytes | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `BytesUsedForHash` | Bytes | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `BytesWrittenOutFromMemcached` | Bytes | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.BytesWrittenOutFromMemcached.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `BytesWrittenOutFromMemcached` | Bytes | CacheClusterId | direct | `cloud.aws.elasticache.BytesWrittenOutFromMemcached.By.CacheClusterId` | CacheClusterId |
| `CPUUtilization` | Percent | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.CPUUtilization.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `CacheHits` | Count | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.CacheHits.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `CacheHits` | Count | CacheClusterId | direct | `cloud.aws.elasticache.CacheHits.By.CacheClusterId` | CacheClusterId |
| `CacheMisses` | Count | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.CacheMisses.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `CacheMisses` | Count | CacheClusterId | direct | `cloud.aws.elasticache.CacheMisses.By.CacheClusterId` | CacheClusterId |
| `CasBadval` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `CasBadval` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `CasHits` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `CasHits` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `CasMisses` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `CasMisses` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `CmdConfigGet` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `CmdConfigGet` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `CmdConfigSet` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `CmdConfigSet` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `CmdFlush` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `CmdFlush` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `CmdGet` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `CmdGet` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `CmdSet` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `CmdSet` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `CmdTouch` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `CmdTouch` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `CurrConfig` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `CurrConfig` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `CurrConnections` | Count | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.CurrConnections.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `CurrItems` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `CurrItems` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `DatabaseMemoryUsagePercentage` | Percent | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.DatabaseMemoryUsagePercentage.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `DatabaseMemoryUsagePercentage` | Percent | CacheClusterId | direct | `cloud.aws.elasticache.DatabaseMemoryUsagePercentage.By.CacheClusterId` | CacheClusterId |
| `DatabaseMemoryUsagePercentage` | Percent | Region | dimension_change | `cloud.aws.elasticache.DatabaseMemoryUsagePercentage.By.CacheClusterId` | CacheClusterId |
| `DecrHits` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `DecrHits` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `DecrMisses` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `DecrMisses` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `DeleteHits` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `DeleteHits` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `DeleteMisses` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `DeleteMisses` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `EngineCPUUtilization` | Percent | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.EngineCPUUtilization.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `EngineCPUUtilization` | Percent | CacheClusterId | direct | `cloud.aws.elasticache.EngineCPUUtilization.By.CacheClusterId` | CacheClusterId |
| `EvictedUnfetched` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `EvictedUnfetched` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `Evictions` | Count | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.Evictions.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `ExpiredUnfetched` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `ExpiredUnfetched` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `FreeableMemory` | Bytes | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.FreeableMemory.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `FreeableMemory` | Bytes | CacheClusterId | direct | `cloud.aws.elasticache.FreeableMemory.By.CacheClusterId` | CacheClusterId |
| `GetHits` | Count | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.GetHits.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `GetHits` | Count | CacheClusterId | direct | `cloud.aws.elasticache.GetHits.By.CacheClusterId` | CacheClusterId |
| `GetMisses` | Count | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.GetMisses.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `GetMisses` | Count | CacheClusterId | direct | `cloud.aws.elasticache.GetMisses.By.CacheClusterId` | CacheClusterId |
| `GetTypeCmds` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `GetTypeCmds` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `HashBasedCmds` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `HashBasedCmds` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `HyperLogLogBasedCmds` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `HyperLogLogBasedCmds` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `IncrHits` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `IncrHits` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `IncrMisses` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `IncrMisses` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `KeyBasedCmds` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `KeyBasedCmds` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `KeysTracked` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `KeysTracked` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `KeysTracked` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ListBasedCmds` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `ListBasedCmds` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `Network Packets Per Second Allowance Exceeded` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `Network Packets Per Second Allowance Exceeded` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `NetworkBandwidthInAllowanceExceeded` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `NetworkBandwidthInAllowanceExceeded` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `NetworkBandwidthOutAllowanceExceeded` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `NetworkBandwidthOutAllowanceExceeded` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `NetworkBytesIn` | Bytes | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.NetworkBytesIn.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `NetworkBytesIn` | Bytes | CacheClusterId | direct | `cloud.aws.elasticache.NetworkBytesIn.By.CacheClusterId` | CacheClusterId |
| `NetworkBytesOut` | Bytes | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.NetworkBytesOut.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `NetworkBytesOut` | Bytes | CacheClusterId | direct | `cloud.aws.elasticache.NetworkBytesOut.By.CacheClusterId` | CacheClusterId |
| `NetworkConntrackAllowanceExceeded` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `NetworkConntrackAllowanceExceeded` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `NetworkLinkLocalAllowanceExceeded` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `NetworkLinkLocalAllowanceExceeded` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `NewConnections` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `NewConnections` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `NewItems` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `NewItems` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `Reclaimed` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `Reclaimed` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `ReplicationBytes` | Bytes | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `ReplicationBytes` | Bytes | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `ReplicationLag` | Seconds | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `ReplicationLag` | Seconds | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `SaveInProgress` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `SaveInProgress` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `SetBasedCmds` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `SetBasedCmds` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `SetTypeCmds` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `SetTypeCmds` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `SlabsMoved` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `SlabsMoved` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `SortedSetBasedCmds` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `SortedSetBasedCmds` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `StringBasedCmds` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `StringBasedCmds` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `SwapUsage` | Bytes | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.SwapUsage.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `TouchHits` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `TouchHits` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `TouchMisses` | Count | CacheClusterId, CacheNodeId | requires_custom_metric | _—_ | _—_ |
| `TouchMisses` | Count | CacheClusterId | requires_custom_metric | _—_ | _—_ |
| `UnusedMemory` | Bytes | CacheClusterId, CacheNodeId | direct | `cloud.aws.elasticache.UnusedMemory.By.CacheClusterId.CacheNodeId` | CacheClusterId, CacheNodeId |
| `UnusedMemory` | Bytes | CacheClusterId | direct | `cloud.aws.elasticache.UnusedMemory.By.CacheClusterId` | CacheClusterId |

</details>

### ElasticBeanstalk (`elastic_beanstalk`)

- Classic entity: `cloud:aws:elasticbeanstalk` (dimension `EnvironmentName`)
- New block: `AWS::ElasticBeanstalk::Environment` → Smartscape `AWS_ELASTICBEANSTALK_ENVIRONMENT`
- Namespaces: `AWS/ElasticBeanstalk`
- New recommended metrics: 10

**Raw CloudWatch metrics — Recommended (6)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ApplicationLatencyP90` | Seconds | EnvironmentName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ApplicationRequestsTotal` | Count | EnvironmentName | direct | `cloud.aws.elasticbeanstalk.ApplicationRequestsTotal.By.EnvironmentName` | EnvironmentName |  |
| `ApplicationRequests4xx` | Count | EnvironmentName | direct | `cloud.aws.elasticbeanstalk.ApplicationRequests4xx.By.EnvironmentName` | EnvironmentName |  |
| `ApplicationRequests5xx` | Count | EnvironmentName | direct | `cloud.aws.elasticbeanstalk.ApplicationRequests5xx.By.EnvironmentName` | EnvironmentName |  |
| `EnvironmentHealth` | None | EnvironmentName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `InstanceHealth` | None | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (42)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ApplicationLatencyP10` | Seconds | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `ApplicationLatencyP10` | Seconds | EnvironmentName | requires_custom_metric | _—_ | _—_ |
| `ApplicationLatencyP50` | Seconds | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `ApplicationLatencyP50` | Seconds | EnvironmentName | requires_custom_metric | _—_ | _—_ |
| `ApplicationLatencyP75` | Seconds | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `ApplicationLatencyP75` | Seconds | EnvironmentName | requires_custom_metric | _—_ | _—_ |
| `ApplicationLatencyP85` | Seconds | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `ApplicationLatencyP85` | Seconds | EnvironmentName | requires_custom_metric | _—_ | _—_ |
| `ApplicationLatencyP90` | Seconds | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `ApplicationLatencyP95` | Seconds | EnvironmentName, InstanceId | direct | `cloud.aws.elasticbeanstalk.ApplicationLatencyP95.By.EnvironmentName` | EnvironmentName |
| `ApplicationLatencyP95` | Seconds | EnvironmentName | direct | `cloud.aws.elasticbeanstalk.ApplicationLatencyP95.By.EnvironmentName` | EnvironmentName |
| `ApplicationLatencyP99` | Seconds | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `ApplicationLatencyP99` | Seconds | EnvironmentName | requires_custom_metric | _—_ | _—_ |
| `ApplicationLatencyP99.9` | Seconds | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `ApplicationLatencyP99.9` | Seconds | EnvironmentName | requires_custom_metric | _—_ | _—_ |
| `ApplicationRequestsTotal` | Count | EnvironmentName, InstanceId | direct | `cloud.aws.elasticbeanstalk.ApplicationRequestsTotal.By.EnvironmentName` | EnvironmentName |
| `ApplicationRequests2xx` | Count | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `ApplicationRequests2xx` | Count | EnvironmentName | requires_custom_metric | _—_ | _—_ |
| `ApplicationRequests3xx` | Count | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `ApplicationRequests3xx` | Count | EnvironmentName | requires_custom_metric | _—_ | _—_ |
| `ApplicationRequests4xx` | Count | EnvironmentName, InstanceId | direct | `cloud.aws.elasticbeanstalk.ApplicationRequests4xx.By.EnvironmentName` | EnvironmentName |
| `ApplicationRequests5xx` | Count | EnvironmentName, InstanceId | direct | `cloud.aws.elasticbeanstalk.ApplicationRequests5xx.By.EnvironmentName` | EnvironmentName |
| `CPUIdle` | Percent | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `CPUIowait` | Percent | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `CPUIrq` | Percent | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `CPUNice` | Percent | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `CPUPrivileged` | Percent | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `CPUSoftirq` | Percent | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `CPUSystem` | Percent | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `CPUUser` | Percent | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `InstancesDegraded` | Count | EnvironmentName | direct | `cloud.aws.elasticbeanstalk.InstancesDegraded.By.EnvironmentName` | EnvironmentName |
| `InstancesInfo` | Count | EnvironmentName | requires_custom_metric | _—_ | _—_ |
| `InstancesNoData` | Count | EnvironmentName | requires_custom_metric | _—_ | _—_ |
| `InstancesOk` | Count | EnvironmentName | direct | `cloud.aws.elasticbeanstalk.InstancesOk.By.EnvironmentName` | EnvironmentName |
| `InstancesPending` | Count | EnvironmentName | requires_custom_metric | _—_ | _—_ |
| `InstancesSevere` | Count | EnvironmentName | direct | `cloud.aws.elasticbeanstalk.InstancesSevere.By.EnvironmentName` | EnvironmentName |
| `InstancesUnknown` | Count | EnvironmentName | requires_custom_metric | _—_ | _—_ |
| `InstancesWarning` | Count | EnvironmentName | direct | `cloud.aws.elasticbeanstalk.InstancesWarning.By.EnvironmentName` | EnvironmentName |
| `LoadAverage1min` | Percent | EnvironmentName, InstanceId | requires_custom_metric | _—_ | _—_ |
| `LoadAverage5min` | Percent | EnvironmentName, InstanceId | direct | `cloud.aws.elasticbeanstalk.LoadAverage5min.By.EnvironmentName` | EnvironmentName |
| `RootFilesystemUtil` | Percent | EnvironmentName, InstanceId | direct | `cloud.aws.elasticbeanstalk.RootFilesystemUtil.By.EnvironmentName` | EnvironmentName |
| `RootFilesystemUtil` | Percent | EnvironmentName | direct | `cloud.aws.elasticbeanstalk.RootFilesystemUtil.By.EnvironmentName` | EnvironmentName |

</details>

### ECS (`ecs`)

- Classic entity: `cloud:aws:ecs` (dimension `ClusterName`)
- New block: `AWS::AppRunner::Service` → Smartscape `AWS_APPRUNNER_SERVICE`
- Namespaces: `AWS/AppRunner`
- New recommended metrics: 11

**Raw CloudWatch metrics — Recommended (4)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CPUReservation` | Percent | ClusterName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CPUUtilization` | Percent | ClusterName, ServiceName | dimension_change | `cloud.aws.apprunner.CPUUtilization.By.ServiceID.ServiceName` | ServiceID, ServiceName | same CW metric, different dimensioning (classic=['ClusterName', 'ServiceName'] vs new=['ServiceID', 'ServiceName']) |
| `MemoryReservation` | Percent | ClusterName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MemoryUtilization` | Percent | ClusterName, ServiceName | dimension_change | `cloud.aws.apprunner.MemoryUtilization.By.ServiceID.ServiceName` | ServiceID, ServiceName | same CW metric, different dimensioning (classic=['ClusterName', 'ServiceName'] vs new=['ServiceID', 'ServiceName']) |

<details><summary>Raw CloudWatch metrics — Non-recommended (2)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `CPUUtilization` | Percent | ClusterName | dimension_change | `cloud.aws.apprunner.CPUUtilization.By.ServiceID.ServiceName` | ServiceID, ServiceName |
| `MemoryUtilization` | Percent | ClusterName | dimension_change | `cloud.aws.apprunner.MemoryUtilization.By.ServiceID.ServiceName` | ServiceID, ServiceName |

</details>

### EFS (`efs`)

- Classic entity: `cloud:aws:efs` (dimension `FileSystemId`)
- New block: `AWS::EFS::FileSystem` → Smartscape `AWS_EFS_FILESYSTEM`
- Namespaces: `AWS/EFS`
- New recommended metrics: 7

**Raw CloudWatch metrics — Recommended (2)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `BurstCreditBalance` | Bytes | FileSystemId | direct | `cloud.aws.efs.BurstCreditBalance.By.FileSystemId` | FileSystemId |  |
| `ClientConnections` | Count | FileSystemId | direct | `cloud.aws.efs.ClientConnections.By.FileSystemId` | FileSystemId |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (6)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `DataReadIOBytes` | Bytes | FileSystemId | requires_custom_metric | _—_ | _—_ |
| `DataWriteIOBytes` | Bytes | FileSystemId | requires_custom_metric | _—_ | _—_ |
| `MetadataIOBytes` | Bytes | FileSystemId | requires_custom_metric | _—_ | _—_ |
| `PercentIOLimit` | Percent | FileSystemId | direct | `cloud.aws.efs.PercentIOLimit.By.FileSystemId` | FileSystemId |
| `PermittedThroughput` | Bytes/Second | FileSystemId | direct | `cloud.aws.efs.PermittedThroughput.By.FileSystemId` | FileSystemId |
| `TotalIOBytes` | Bytes | FileSystemId | direct | `cloud.aws.efs.TotalIOBytes.By.FileSystemId` | FileSystemId |

</details>

### ElasticInference (`elastic_inference`)

- Classic entity: `None` (dimension `ElasticInferenceAcceleratorId`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (8)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `AcceleratorHealthCheckFailed` | Count | InstanceId, ElasticInferenceAcceleratorId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `AcceleratorInferenceWithClientErrorCount` | Count | InstanceId, ElasticInferenceAcceleratorId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `AcceleratorInferenceWithServerErrorCount` | Count | InstanceId, ElasticInferenceAcceleratorId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `AcceleratorMemoryUsage` | Bytes | InstanceId, ElasticInferenceAcceleratorId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `AcceleratorSuccessfulInferenceCount` | Count | InstanceId, ElasticInferenceAcceleratorId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `AcceleratorTotalInferenceCount` | Count | InstanceId, ElasticInferenceAcceleratorId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `AcceleratorUtilization` | Percent | InstanceId, ElasticInferenceAcceleratorId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ConnectivityCheckFailed` | Count | InstanceId, ElasticInferenceAcceleratorId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

### EKS (`eks`)

- Classic entity: `cloud:aws:eks:cluster` (dimension `ClusterName`)
- New block: `AWS::EKS::Cluster` → Smartscape `AWS_EKS_CLUSTER`
- Namespaces: _none_
- New recommended metrics: 31

**Raw CloudWatch metrics — Recommended (23)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `cluster_failed_node_count` | Count | ClusterName | direct | `cloud.aws.containerinsights.cluster_failed_node_count.By.ClusterName` | ClusterName |  |
| `cluster_node_count` | Count | ClusterName | direct | `cloud.aws.containerinsights.cluster_node_count.By.ClusterName` | ClusterName |  |
| `namespace_number_of_running_pods` | Count | ClusterName, Namespace | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `node_cpu_limit` | None | ClusterName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `node_cpu_reserved_capacity` | Percent | ClusterName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `node_cpu_usage_total` | None | ClusterName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `node_cpu_utilization` | Percent | ClusterName, InstanceId, NodeName | direct | `cloud.aws.containerinsights.node_cpu_utilization.By.ClusterName.InstanceId.NodeName` | ClusterName, InstanceId, NodeName |  |
| `node_filesystem_utilization` | Percent | ClusterName, InstanceId, NodeName | direct | `cloud.aws.containerinsights.node_filesystem_utilization.By.ClusterName.InstanceId.NodeName` | ClusterName, InstanceId, NodeName |  |
| `node_memory_limit` | Bytes | ClusterName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `node_memory_reserved_capacity` | Percent | ClusterName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `node_memory_utilization` | Percent | ClusterName, InstanceId, NodeName | direct | `cloud.aws.containerinsights.node_memory_utilization.By.ClusterName.InstanceId.NodeName` | ClusterName, InstanceId, NodeName |  |
| `node_memory_working_set` | Bytes | ClusterName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `node_network_total_bytes` | Bytes/Second | ClusterName, InstanceId, NodeName | direct | `cloud.aws.containerinsights.node_network_total_bytes.By.ClusterName.InstanceId.NodeName` | ClusterName, InstanceId, NodeName |  |
| `node_network_total_bytes` | Bytes/Second | ClusterName | direct | `cloud.aws.containerinsights.node_network_total_bytes.By.ClusterName` | ClusterName |  |
| `node_number_of_running_containers` | Count | ClusterName, InstanceId, NodeName | direct | `cloud.aws.containerinsights.node_number_of_running_containers.By.ClusterName.InstanceId.NodeName` | ClusterName, InstanceId, NodeName |  |
| `node_number_of_running_pods` | Count | ClusterName, InstanceId, NodeName | direct | `cloud.aws.containerinsights.node_number_of_running_pods.By.ClusterName.InstanceId.NodeName` | ClusterName, InstanceId, NodeName |  |
| `pod_cpu_utilization` | Percent | ClusterName, Namespace | direct | `cloud.aws.containerinsights.pod_cpu_utilization.By.ClusterName` | ClusterName | dimension set differs slightly (classic=['ClusterName', 'Namespace'] vs new=['ClusterName']) |
| `pod_cpu_utilization_over_pod_limit` | Percent | ClusterName, Namespace, PodName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `pod_memory_utilization` | Percent | ClusterName, Namespace | direct | `cloud.aws.containerinsights.pod_memory_utilization.By.ClusterName` | ClusterName | dimension set differs slightly (classic=['ClusterName', 'Namespace'] vs new=['ClusterName']) |
| `pod_memory_utilization_over_pod_limit` | Percent | ClusterName, Namespace, PodName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `pod_network_rx_bytes` | Bytes/Second | ClusterName, Namespace, PodName | direct | `cloud.aws.containerinsights.pod_network_rx_bytes.By.ClusterName.Namespace.PodName` | ClusterName, Namespace, PodName |  |
| `pod_network_tx_bytes` | Bytes/Second | ClusterName, Namespace, PodName | direct | `cloud.aws.containerinsights.pod_network_tx_bytes.By.ClusterName.Namespace.PodName` | ClusterName, Namespace, PodName |  |
| `pod_number_of_container_restarts` | Count | ClusterName, Namespace, PodName | direct | `cloud.aws.containerinsights.pod_number_of_container_restarts.By.ClusterName.Namespace.PodName` | ClusterName, Namespace, PodName |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (25)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `node_cpu_reserved_capacity` | Percent | ClusterName, InstanceId, NodeName | requires_custom_metric | _—_ | _—_ |
| `node_cpu_utilization` | Percent | ClusterName | direct | `cloud.aws.containerinsights.node_cpu_utilization.By.ClusterName` | ClusterName |
| `node_filesystem_utilization` | Percent | ClusterName | direct | `cloud.aws.containerinsights.node_filesystem_utilization.By.ClusterName` | ClusterName |
| `node_memory_reserved_capacity` | Percent | ClusterName, InstanceId, NodeName | requires_custom_metric | _—_ | _—_ |
| `node_memory_utilization` | Percent | ClusterName | direct | `cloud.aws.containerinsights.node_memory_utilization.By.ClusterName` | ClusterName |
| `node_number_of_running_containers` | Count | ClusterName | direct | `cloud.aws.containerinsights.node_number_of_running_containers.By.ClusterName` | ClusterName |
| `node_number_of_running_pods` | Count | ClusterName | direct | `cloud.aws.containerinsights.node_number_of_running_pods.By.ClusterName` | ClusterName |
| `pod_cpu_reserved_capacity` | Percent | ClusterName, Namespace, PodName | requires_custom_metric | _—_ | _—_ |
| `pod_cpu_reserved_capacity` | Percent | ClusterName | requires_custom_metric | _—_ | _—_ |
| `pod_cpu_utilization` | Percent | ClusterName, Namespace, PodName | direct | `cloud.aws.containerinsights.pod_cpu_utilization.By.ClusterName.Namespace.PodName` | ClusterName, Namespace, PodName |
| `pod_cpu_utilization` | Percent | ClusterName | direct | `cloud.aws.containerinsights.pod_cpu_utilization.By.ClusterName` | ClusterName |
| `pod_cpu_utilization_over_pod_limit` | Percent | ClusterName, Namespace | requires_custom_metric | _—_ | _—_ |
| `pod_cpu_utilization_over_pod_limit` | Percent | ClusterName | requires_custom_metric | _—_ | _—_ |
| `pod_memory_reserved_capacity` | Percent | ClusterName, Namespace, PodName | requires_custom_metric | _—_ | _—_ |
| `pod_memory_reserved_capacity` | Percent | ClusterName | requires_custom_metric | _—_ | _—_ |
| `pod_memory_utilization` | Percent | ClusterName, Namespace, PodName | direct | `cloud.aws.containerinsights.pod_memory_utilization.By.ClusterName.Namespace.PodName` | ClusterName, Namespace, PodName |
| `pod_memory_utilization` | Percent | ClusterName | direct | `cloud.aws.containerinsights.pod_memory_utilization.By.ClusterName` | ClusterName |
| `pod_memory_utilization_over_pod_limit` | Percent | ClusterName, Namespace | requires_custom_metric | _—_ | _—_ |
| `pod_memory_utilization_over_pod_limit` | Percent | ClusterName | requires_custom_metric | _—_ | _—_ |
| `pod_network_rx_bytes` | Bytes/Second | ClusterName, Namespace | direct | `cloud.aws.containerinsights.pod_network_rx_bytes.By.ClusterName` | ClusterName |
| `pod_network_rx_bytes` | Bytes/Second | ClusterName | direct | `cloud.aws.containerinsights.pod_network_rx_bytes.By.ClusterName` | ClusterName |
| `pod_network_tx_bytes` | Bytes/Second | ClusterName, Namespace | direct | `cloud.aws.containerinsights.pod_network_tx_bytes.By.ClusterName` | ClusterName |
| `pod_network_tx_bytes` | Bytes/Second | ClusterName | direct | `cloud.aws.containerinsights.pod_network_tx_bytes.By.ClusterName` | ClusterName |
| `service_number_of_running_pods` | Count | ClusterName, Namespace, Service | requires_custom_metric | _—_ | _—_ |
| `service_number_of_running_pods` | Count | ClusterName | requires_custom_metric | _—_ | _—_ |

</details>

### EMR (`emr`)

- Classic entity: `None` (dimension `JobFlowId`)
- New block: `AWS::EMR::Cluster` → Smartscape `AWS_EMR_CLUSTER`
- Namespaces: `AWS/ElasticMapReduce`
- New recommended metrics: 20

**Raw CloudWatch metrics — Recommended (8)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `AppsRunning` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.AppsRunning.By.JobFlowId` | JobFlowId | dimension set differs slightly (classic=['JobFlowId', 'JobId'] vs new=['JobFlowId']) |
| `AppsRunning` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.AppsRunning.By.JobFlowId` | JobFlowId |  |
| `HDFSUtilization` | Percent | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.HDFSUtilization.By.JobFlowId` | JobFlowId | dimension set differs slightly (classic=['JobFlowId', 'JobId'] vs new=['JobFlowId']) |
| `HDFSUtilization` | Percent | JobFlowId | direct | `cloud.aws.emr_ec2.HDFSUtilization.By.JobFlowId` | JobFlowId |  |
| `IsIdle` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.IsIdle.By.JobFlowId` | JobFlowId | dimension set differs slightly (classic=['JobFlowId', 'JobId'] vs new=['JobFlowId']) |
| `IsIdle` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.IsIdle.By.JobFlowId` | JobFlowId |  |
| `MapTasksRunning` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MapTasksRunning` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (128)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `AppsCompleted` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.AppsCompleted.By.JobFlowId` | JobFlowId |
| `AppsCompleted` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.AppsCompleted.By.JobFlowId` | JobFlowId |
| `AppsFailed` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.AppsFailed.By.JobFlowId` | JobFlowId |
| `AppsFailed` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.AppsFailed.By.JobFlowId` | JobFlowId |
| `AppsKilled` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.AppsKilled.By.JobFlowId` | JobFlowId |
| `AppsKilled` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.AppsKilled.By.JobFlowId` | JobFlowId |
| `AppsPending` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.AppsPending.By.JobFlowId` | JobFlowId |
| `AppsPending` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.AppsPending.By.JobFlowId` | JobFlowId |
| `AppsSubmitted` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `AppsSubmitted` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `BackupFailed` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `BackupFailed` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `CapacityRemainingGB` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `CapacityRemainingGB` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `ContainerAllocated` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `ContainerAllocated` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `ContainerPendingRatio` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.ContainerPendingRatio.By.JobFlowId` | JobFlowId |
| `ContainerPendingRatio` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.ContainerPendingRatio.By.JobFlowId` | JobFlowId |
| `ContainerPending` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `ContainerPending` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `ContainerReserved` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `ContainerReserved` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `CoreNodesPending` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.CoreNodesPending.By.JobFlowId` | JobFlowId |
| `CoreNodesPending` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.CoreNodesPending.By.JobFlowId` | JobFlowId |
| `CoreNodesRequested` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `CoreNodesRequested` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `CoreNodesRunning` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.CoreNodesRunning.By.JobFlowId` | JobFlowId |
| `CoreNodesRunning` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.CoreNodesRunning.By.JobFlowId` | JobFlowId |
| `CoreUnitsRequested` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `CoreUnitsRequested` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `CoreUnitsRunning` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `CoreUnitsRunning` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `CoreVCPURequested` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `CoreVCPURequested` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `CoreVCPURunning` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `CoreVCPURunning` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `CorruptBlocks` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `CorruptBlocks` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `DfsPendingReplicationBlocks` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `DfsPendingReplicationBlocks` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `HDFSBytesRead` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.HDFSBytesRead.By.JobFlowId` | JobFlowId |
| `HDFSBytesRead` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.HDFSBytesRead.By.JobFlowId` | JobFlowId |
| `HDFSBytesWritten` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.HDFSBytesWritten.By.JobFlowId` | JobFlowId |
| `HDFSBytesWritten` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.HDFSBytesWritten.By.JobFlowId` | JobFlowId |
| `HbaseBackupFailed` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `HbaseBackupFailed` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `JobsFailed` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `JobsFailed` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `JobsRunning` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `JobsRunning` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `LiveDataNodes` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `LiveDataNodes` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `LiveTaskTrackers` | Percent | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `LiveTaskTrackers` | Percent | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `MRActiveNodes` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `MRActiveNodes` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `MRDecommissionedNodes` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `MRDecommissionedNodes` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `MRLostNodes` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.MRLostNodes.By.JobFlowId` | JobFlowId |
| `MRLostNodes` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.MRLostNodes.By.JobFlowId` | JobFlowId |
| `MRRebootedNodes` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `MRRebootedNodes` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `MRTotalNodes` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.MRTotalNodes.By.JobFlowId` | JobFlowId |
| `MRTotalNodes` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.MRTotalNodes.By.JobFlowId` | JobFlowId |
| `MRUnhealthyNodes` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.MRUnhealthyNodes.By.JobFlowId` | JobFlowId |
| `MRUnhealthyNodes` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.MRUnhealthyNodes.By.JobFlowId` | JobFlowId |
| `MapSlotsOpen` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `MapSlotsOpen` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `MapTasksRemaining` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `MapTasksRemaining` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `MemoryAllocatedMB` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `MemoryAllocatedMB` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `MemoryAvailableMB` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `MemoryAvailableMB` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `MemoryReservedMB` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `MemoryReservedMB` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `MemoryTotalMB` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `MemoryTotalMB` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `MissingBlocks` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.MissingBlocks.By.JobFlowId` | JobFlowId |
| `MissingBlocks` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.MissingBlocks.By.JobFlowId` | JobFlowId |
| `MostRecentBackupDuration` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `MostRecentBackupDuration` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `PendingDeletionBlocks` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `PendingDeletionBlocks` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `ReduceSlotsOpen` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `ReduceSlotsOpen` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `ReduceTasksRemaining` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `ReduceTasksRunning` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `ReduceTasksRunning` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `RemainingMapTasksPerSlot` | Percent | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `RemainingMapTasksPerSlot` | Percent | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `S3BytesRead` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.S3BytesRead.By.JobFlowId` | JobFlowId |
| `S3BytesRead` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.S3BytesRead.By.JobFlowId` | JobFlowId |
| `S3BytesWritten` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.S3BytesWritten.By.JobFlowId` | JobFlowId |
| `S3BytesWritten` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.S3BytesWritten.By.JobFlowId` | JobFlowId |
| `TaskNodesPending` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `TaskNodesPending` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `TaskNodesRequested` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `TaskNodesRequested` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `TaskNodesRunning` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `TaskNodesRunning` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `TaskUnitsRequested` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `TaskUnitsRequested` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `TaskUnitsRunning` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `TaskUnitsRunning` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `TaskVCPURequested` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `TaskVCPURequested` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `TaskVCPURunning` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `TaskVCPURunning` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `TimeSinceLastSuccessfulBackup` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `TimeSinceLastSuccessfulBackup` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `TotalLoad` | Count | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.TotalLoad.By.JobFlowId` | JobFlowId |
| `TotalLoad` | Count | JobFlowId | direct | `cloud.aws.emr_ec2.TotalLoad.By.JobFlowId` | JobFlowId |
| `TotalNodesRequested` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `TotalNodesRequested` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `TotalNodesRunning` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `TotalNodesRunning` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `TotalUnitsRequested` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `TotalUnitsRequested` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `TotalUnitsRunning` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `TotalUnitsRunning` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `TotalVCPURequested` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `TotalVCPURunning` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `TotalVCPURunning` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `UnderReplicatedBlocks` | Count | JobFlowId, JobId | requires_custom_metric | _—_ | _—_ |
| `UnderReplicatedBlocks` | Count | JobFlowId | requires_custom_metric | _—_ | _—_ |
| `YARNMemoryAvailablePercentage` | Percent | JobFlowId, JobId | direct | `cloud.aws.emr_ec2.YARNMemoryAvailablePercentage.By.JobFlowId` | JobFlowId |
| `YARNMemoryAvailablePercentage` | Percent | JobFlowId | direct | `cloud.aws.emr_ec2.YARNMemoryAvailablePercentage.By.JobFlowId` | JobFlowId |

</details>

### ElasticsearchService (`es`)

- Classic entity: `cloud:aws:es` (dimension `DomainName`)
- Matched 4 new blocks:
  - `AWS::OpenSearch::Domain` → `AWS_OPENSEARCH_DOMAIN` (namespaces: `AWS/ES`, recommended: 54)
  - `AWS::ElastiCache::CacheCluster` → `AWS_ELASTICACHE_CACHECLUSTER` (namespaces: `AWS/ElastiCache`, recommended: 38)
  - `AWS::ElasticLoadBalancing::LoadBalancer` → `AWS_ELASTICLOADBALANCING_LOADBALANCER` (namespaces: `AWS/ELB`, recommended: 12)
  - `AWS::ElasticLoadBalancingV2::LoadBalancer` → `AWS_ELASTICLOADBALANCINGV2_LOADBALANCER` (namespaces: `AWS/ApplicationELB`, `AWS/NetworkELB`, recommended: 24)

**Raw CloudWatch metrics — Recommended (6)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CPUUtilization` | Percent | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.CPUUtilization.By.ClientId.DomainName.NodeId` | ClientId, DomainName, NodeId | dimension set differs slightly (classic=['DomainName', 'ClientId'] vs new=['ClientId', 'DomainName', 'NodeId']) |
| `ClusterStatus.green` | Count | DomainName, ClientId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ElasticsearchRequests` | Count | DomainName, ClientId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `FreeStorageSpace` | Megabytes | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.FreeStorageSpace.By.ClientId.DomainName.NodeId` | ClientId, DomainName, NodeId | dimension set differs slightly (classic=['DomainName', 'ClientId'] vs new=['ClientId', 'DomainName', 'NodeId']) |
| `MasterCPUUtilization` | Percent | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.MasterCPUUtilization.By.ClientId.DomainName` | ClientId, DomainName |  |
| `Nodes` | Count | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.Nodes.By.ClientId.DomainName` | ClientId, DomainName |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (31)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `2xx` | Count | ClientId, DomainName | direct | `cloud.aws.opensearch_domain.2xx.By.ClientId.DomainName` | ClientId, DomainName |
| `3xx` | Count | ClientId, DomainName | requires_custom_metric | _—_ | _—_ |
| `4xx` | Count | ClientId, DomainName | direct | `cloud.aws.opensearch_domain.4xx.By.ClientId.DomainName` | ClientId, DomainName |
| `5xx` | Count | ClientId, DomainName | direct | `cloud.aws.opensearch_domain.5xx.By.ClientId.DomainName` | ClientId, DomainName |
| `AutomatedSnapshotFailure` | Count | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.AutomatedSnapshotFailure.By.ClientId.DomainName` | ClientId, DomainName |
| `CPUCreditBalance` | Count | DomainName, ClientId | requires_custom_metric | _—_ | _—_ |
| `CPUUtilization` | Percent | ClientId, DomainName, NodeId | direct | `cloud.aws.opensearch_domain.CPUUtilization.By.ClientId.DomainName.NodeId` | ClientId, DomainName, NodeId |
| `ClusterIndexWritesBlocked` | Count | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.ClusterIndexWritesBlocked.By.ClientId.DomainName` | ClientId, DomainName |
| `ClusterStatus.red` | Count | DomainName, ClientId | requires_custom_metric | _—_ | _—_ |
| `ClusterStatus.yellow` | Count | DomainName, ClientId | requires_custom_metric | _—_ | _—_ |
| `ClusterUsedSpace` | Megabytes | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.ClusterUsedSpace.By.ClientId.DomainName` | ClientId, DomainName |
| `DeletedDocuments` | Count | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.DeletedDocuments.By.ClientId.DomainName` | ClientId, DomainName |
| `DiskQueueDepth` | Count | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.DiskQueueDepth.By.ClientId.DomainName.NodeId` | ClientId, DomainName, NodeId |
| `FreeStorageSpace` | Megabytes | ClientId, DomainName, NodeId | direct | `cloud.aws.opensearch_domain.FreeStorageSpace.By.ClientId.DomainName.NodeId` | ClientId, DomainName, NodeId |
| `InvalidHostHeaderRequests` | Count | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.InvalidHostHeaderRequests.By.ClientId.DomainName` | ClientId, DomainName |
| `JVMMemoryPressure` | Percent | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.JVMMemoryPressure.By.ClientId.DomainName.NodeId` | ClientId, DomainName, NodeId |
| `KMSKeyError` | Count | DomainName, ClientId | requires_custom_metric | _—_ | _—_ |
| `KMSKeyInaccessible` | Count | DomainName, ClientId | requires_custom_metric | _—_ | _—_ |
| `KibanaHealthyNodes` | Count | DomainName, ClientId | requires_custom_metric | _—_ | _—_ |
| `MasterCPUCreditBalance` | Count | DomainName, ClientId | requires_custom_metric | _—_ | _—_ |
| `MasterJVMMemoryPressure` | Percent | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.MasterJVMMemoryPressure.By.ClientId.DomainName` | ClientId, DomainName |
| `MasterReachableFromNode` | Count | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.MasterReachableFromNode.By.ClientId.DomainName` | ClientId, DomainName |
| `ReadIOPS` | Count/Second | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.ReadIOPS.By.ClientId.DomainName.NodeId` | ClientId, DomainName, NodeId |
| `ReadLatency` | Seconds | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.ReadLatency.By.ClientId.DomainName.NodeId` | ClientId, DomainName, NodeId |
| `ReadThroughput` | Bytes/Second | DomainName, ClientId | requires_custom_metric | _—_ | _—_ |
| `RequestCount` | Count | DomainName, ClientId | dimension_change | `cloud.aws.elb.RequestCount.By.LoadBalancerName` | LoadBalancerName |
| `SearchLatency` | Milliseconds | ClientId, DomainName | direct | `cloud.aws.opensearch_domain.SearchLatency.By.ClientId.DomainName.NodeId` | ClientId, DomainName, NodeId |
| `SearchableDocuments` | Count | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.SearchableDocuments.By.ClientId.DomainName` | ClientId, DomainName |
| `WriteIOPS` | Count/Second | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.WriteIOPS.By.ClientId.DomainName.NodeId` | ClientId, DomainName, NodeId |
| `WriteLatency` | Seconds | DomainName, ClientId | direct | `cloud.aws.opensearch_domain.WriteLatency.By.ClientId.DomainName.NodeId` | ClientId, DomainName, NodeId |
| `WriteThroughput` | Bytes/Second | DomainName, ClientId | requires_custom_metric | _—_ | _—_ |

</details>

### ElasticTranscoder (`elastic_transcoder`)

- Classic entity: `cloud:aws:elastictranscoder` (dimension `PipelineId`)
- New block: `AWS::Lambda::Function` → Smartscape `AWS_LAMBDA_FUNCTION`
- Namespaces: `AWS/Lambda`
- New recommended metrics: 9

**Raw CloudWatch metrics — Recommended (6)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `Errors` | Count | Region, Operation | dimension_change | `cloud.aws.lambda.Errors.By.FunctionName` | FunctionName | same CW metric, different dimensioning (classic=['Region', 'Operation'] vs new=['FunctionName']) |
| `JobsCompleted` | Count | PipelineId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `JobsErrored` | Count | PipelineId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `OutputsPerJob` | Count | PipelineId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `StandbyTime` | Seconds | PipelineId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `Throttles` | Count | Region, Operation | dimension_change | `cloud.aws.lambda.Throttles.By.FunctionName` | FunctionName | same CW metric, different dimensioning (classic=['Region', 'Operation'] vs new=['FunctionName']) |

<details><summary>Raw CloudWatch metrics — Non-recommended (3)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `BilledAudioOutput` | Seconds | PipelineId | requires_custom_metric | _—_ | _—_ |
| `BilledHDOutput` | Seconds | PipelineId | requires_custom_metric | _—_ | _—_ |
| `BilledSDOutput` | Seconds | PipelineId | requires_custom_metric | _—_ | _—_ |

</details>

### MediaConnect (`mediaconnect`)

- Classic entity: `cloud:aws:mediaconnect` (dimension `FlowARN`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (12)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ARQRecovered` | Count | FlowARN | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ARQRequests` | Count | FlowARN | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `BitRate` | Bits/Second | FlowARN | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `DroppedPackets` | Count | FlowARN | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `FECPackets` | Count | FlowARN | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `FECRecovered` | Count | FlowARN | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `NotRecoveredPackets` | Count | FlowARN | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `OverflowPackets` | Count | FlowARN | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `PacketLossPercent` | Percent | FlowARN | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `RecoveredPackets` | Count | FlowARN | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `RoundTripTime` | Milliseconds | FlowARN | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `TotalPackets` | Count | FlowARN | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (181)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ARQRecovered` | Count | Region | no_new_coverage | _—_ | _—_ |
| `ARQRecovered` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `ARQRequests` | Count | Region | no_new_coverage | _—_ | _—_ |
| `ARQRequests` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `BitRate` | Bits/Second | Region | no_new_coverage | _—_ | _—_ |
| `BitRate` | Bits/Second | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `CATError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `CATError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `CATError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `CRCError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `CRCError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `CRCError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `Connected` | None | FlowARN | no_new_coverage | _—_ | _—_ |
| `Connected` | None | Region | no_new_coverage | _—_ | _—_ |
| `Connected` | None | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `ConnectedOutputs` | Count | Region | no_new_coverage | _—_ | _—_ |
| `ConnectedOutputs` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `ConnectedOutputs` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `ContinuityCounter` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `ContinuityCounter` | Count | Region | no_new_coverage | _—_ | _—_ |
| `ContinuityCounter` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `Disconnections` | Count | Region | no_new_coverage | _—_ | _—_ |
| `Disconnections` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `Disconnections` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `DroppedPackets` | Count | Region | no_new_coverage | _—_ | _—_ |
| `DroppedPackets` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `FECPackets` | Count | Region | no_new_coverage | _—_ | _—_ |
| `FECPackets` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `FECRecovered` | Count | Region | no_new_coverage | _—_ | _—_ |
| `FECRecovered` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `NotRecoveredPackets` | Count | Region | no_new_coverage | _—_ | _—_ |
| `NotRecoveredPackets` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `OutputConnected` | None | Region, OutputARN | no_new_coverage | _—_ | _—_ |
| `OutputConnected` | None | FlowARN | no_new_coverage | _—_ | _—_ |
| `OutputConnected` | None | Region | no_new_coverage | _—_ | _—_ |
| `OutputConnected` | None | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `OutputDisconnections` | Count | Region, OutputARN | no_new_coverage | _—_ | _—_ |
| `OutputDisconnections` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `OutputDisconnections` | Count | Region | no_new_coverage | _—_ | _—_ |
| `OutputDisconnections` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `OverflowPackets` | Count | Region | no_new_coverage | _—_ | _—_ |
| `OverflowPackets` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `PATError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `PATError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `PATError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `PCRAccuracyError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `PCRAccuracyError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `PCRAccuracyError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `PCRError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `PCRError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `PCRError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `PIDError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `PIDError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `PIDError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `PMTError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `PMTError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `PMTError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `PTSError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `PTSError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `PTSError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `PacketLossPercent` | Percent | Region | no_new_coverage | _—_ | _—_ |
| `PacketLossPercent` | Percent | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `RecoveredPackets` | Count | Region | no_new_coverage | _—_ | _—_ |
| `RecoveredPackets` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `RoundTripTime` | Milliseconds | Region | no_new_coverage | _—_ | _—_ |
| `RoundTripTime` | Milliseconds | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceARQRecovered` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceARQRecovered` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceARQRecovered` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceARQRecovered` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceARQRequests` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceARQRequests` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceARQRequests` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceARQRequests` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceBitRate` | Bits/Second | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceBitRate` | Bits/Second | Region | no_new_coverage | _—_ | _—_ |
| `SourceBitRate` | Bits/Second | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceBitRate` | Bits/Second | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceCATError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceCATError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceCATError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceCATError` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceCRCError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceCRCError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceCRCError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceCRCError` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceConnected` | None | Region | no_new_coverage | _—_ | _—_ |
| `SourceConnected` | None | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceConnected` | None | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceConnected` | None | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceContinuityCounter` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceContinuityCounter` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceContinuityCounter` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceContinuityCounter` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceDisconnections` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceDisconnections` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceDisconnections` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceDisconnections` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceDroppedPackets` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceDroppedPackets` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceDroppedPackets` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceDroppedPackets` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceFECPackets` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceFECPackets` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceFECPackets` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceFECPackets` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceFECRecovered` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceFECRecovered` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceFECRecovered` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceFECRecovered` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceNotRecoveredPackets` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceNotRecoveredPackets` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceNotRecoveredPackets` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceNotRecoveredPackets` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceOverflowPackets` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceOverflowPackets` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceOverflowPackets` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceOverflowPackets` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourcePATError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourcePATError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourcePATError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourcePATError` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourcePCRAccuracyError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourcePCRAccuracyError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourcePCRAccuracyError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourcePCRAccuracyError` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourcePCRError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourcePCRError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourcePCRError` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourcePCRError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourcePIDError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourcePIDError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourcePIDError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourcePIDError` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourcePMTError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourcePMTError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourcePMTError` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourcePMTError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourcePTSError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourcePTSError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourcePTSError` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourcePTSError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourcePacketLossPercent` | Percent | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourcePacketLossPercent` | Percent | Region | no_new_coverage | _—_ | _—_ |
| `SourcePacketLossPercent` | Percent | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourcePacketLossPercent` | Percent | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceRecoveredPackets` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceRecoveredPackets` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceRecoveredPackets` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceRecoveredPackets` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceRoundTripTime` | Milliseconds | Region | no_new_coverage | _—_ | _—_ |
| `SourceRoundTripTime` | Milliseconds | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceRoundTripTime` | Milliseconds | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceRoundTripTime` | Milliseconds | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceTSByteError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceTSByteError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceTSByteError` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceTSByteError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceTSSyncLoss` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceTSSyncLoss` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceTSSyncLoss` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceTSSyncLoss` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceTotalPackets` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceTotalPackets` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceTotalPackets` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `SourceTotalPackets` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceTransportError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `SourceTransportError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `SourceTransportError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `SourceTransportError` | Count | Region, SourceARN | no_new_coverage | _—_ | _—_ |
| `TSByteError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `TSByteError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `TSByteError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `TSSyncLoss` | Count | FlowARN | no_new_coverage | _—_ | _—_ |
| `TSSyncLoss` | Count | Region | no_new_coverage | _—_ | _—_ |
| `TSSyncLoss` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `TotalPackets` | Count | Region | no_new_coverage | _—_ | _—_ |
| `TotalPackets` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `TransportError` | Count | Region | no_new_coverage | _—_ | _—_ |
| `TransportError` | Count | Region, AvailabilityZone | no_new_coverage | _—_ | _—_ |
| `TransportError` | Count | FlowARN | no_new_coverage | _—_ | _—_ |

</details>

### MediaConvert (`mediaconvert`)

- Classic entity: `None` (dimension `Queue`)
- New block: `AWS::Lambda::Function` → Smartscape `AWS_LAMBDA_FUNCTION`
- Namespaces: `AWS/Lambda`
- New recommended metrics: 9

**Raw CloudWatch metrics — Recommended (7)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `Errors` | Count | Region, Operation | dimension_change | `cloud.aws.lambda.Errors.By.FunctionName` | FunctionName | same CW metric, different dimensioning (classic=['Region', 'Operation'] vs new=['FunctionName']) |
| `JobsCanceledCount` | Count | Queue | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `JobsCompletedCount` | Count | Queue | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `JobsErroredCount` | Count | Queue | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `StandbyTime` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `StandbyTime` | Milliseconds | Queue | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TranscodingTime` | Milliseconds | Queue | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (5)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `AudioOutputDuration` | Milliseconds | Queue | requires_custom_metric | _—_ | _—_ |
| `HDOutputDuration` | Milliseconds | Queue | requires_custom_metric | _—_ | _—_ |
| `8KOutputDuration` | Milliseconds | Queue | requires_custom_metric | _—_ | _—_ |
| `SDOutputDuration` | Milliseconds | Queue | requires_custom_metric | _—_ | _—_ |
| `UHDOutputDuration` | Milliseconds | Queue | requires_custom_metric | _—_ | _—_ |

</details>

### MediaPackage (`mediapackage`)

- Classic entity: `cloud:aws:mediapackagelive` (dimension `Channel`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (14)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `EgressBytes` | Bytes | Channel | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `EgressBytes` | Bytes | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `EgressRequestCount` | Count | Channel | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `EgressRequestCount` | Count | Channel, StatusCodeRange | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `EgressRequestCount` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `EgressResponseTime` | Milliseconds | Channel | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `EgressResponseTime` | Milliseconds | Channel, OriginEndpoint | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `IngressBytes` | Bytes | Channel | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `IngressBytes` | Bytes | Channel, IngestEndpoint | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `IngressResponseTime` | Milliseconds | Channel | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `IngressResponseTime` | Milliseconds | Channel, IngestEndpoint | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `EgressBytes` | Bytes | PackagingConfiguration | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `EgressRequestCount` | Count | PackagingConfiguration | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `EgressResponseTime` | Milliseconds | PackagingConfiguration | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (8)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ActiveInput` | Count | Region, IngestEndpoint, OriginEndpoint | no_new_coverage | _—_ | _—_ |
| `EgressBytes` | Bytes | Channel, OriginEndpoint | no_new_coverage | _—_ | _—_ |
| `EgressRequestCount` | Count | Channel, OriginEndpoint | no_new_coverage | _—_ | _—_ |
| `EgressRequestCount` | Count | Channel, OriginEndpoint, StatusCodeRange | no_new_coverage | _—_ | _—_ |
| `EgressRequestCount` | Count | Region, StatusCodeRange | no_new_coverage | _—_ | _—_ |
| `IngressBytes` | Bytes | Region | no_new_coverage | _—_ | _—_ |
| `IngressResponseTime` | Milliseconds | Region | no_new_coverage | _—_ | _—_ |
| `EgressRequestCount` | Count | PackagingConfiguration, StatusCodeRange | no_new_coverage | _—_ | _—_ |

</details>

### MediaTailor (`mediatailor`)

- Classic entity: `cloud:aws:media_tailor` (dimension `ConfigurationName`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (2)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `Avail.FillRate` | Count | ConfigurationName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Avail.FilledDuration` | Milliseconds | ConfigurationName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (10)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `AdDecisionServer.Ads` | Count | ConfigurationName | no_new_coverage | _—_ | _—_ |
| `AdDecisionServer.Duration` | Milliseconds | ConfigurationName | no_new_coverage | _—_ | _—_ |
| `AdDecisionServer.Errors` | Count | ConfigurationName | no_new_coverage | _—_ | _—_ |
| `AdDecisionServer.FillRate` | Count | ConfigurationName | no_new_coverage | _—_ | _—_ |
| `AdDecisionServer.Timeouts` | Count | ConfigurationName | no_new_coverage | _—_ | _—_ |
| `AdNotReady` | Count | ConfigurationName | no_new_coverage | _—_ | _—_ |
| `Avail.Duration` | Milliseconds | ConfigurationName | no_new_coverage | _—_ | _—_ |
| `GetManifest.Errors` | Count | ConfigurationName | no_new_coverage | _—_ | _—_ |
| `Origin.Errors` | Count | ConfigurationName | no_new_coverage | _—_ | _—_ |
| `Origin.Timeouts` | Count | ConfigurationName | no_new_coverage | _—_ | _—_ |

</details>

### EventBridge (`eventbridge`)

- Classic entity: `cloud:aws:events` (dimension `EventBusName`)
- New block: `AWS::Events::EventBus` → Smartscape `AWS_EVENTS_EVENTBUS`
- Namespaces: `AWS/Events`
- New recommended metrics: 9

**Raw CloudWatch metrics — Recommended (16)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `DeadLetterInvocations` | Count | EventBusName, RuleName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DeadLetterInvocations` | Count | Region, RuleName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DeadLetterInvocations` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `FailedInvocations` | Count | EventBusName, RuleName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `FailedInvocations` | Count | Region, RuleName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `FailedInvocations` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `Invocations` | Count | EventBusName, RuleName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `Invocations` | Count | Region, RuleName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `Invocations` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MatchedEvents` | Count | Region | dimension_change | `cloud.aws.events.MatchedEvents.By.EventBusName.RuleName` | EventBusName, RuleName | same CW metric, different dimensioning (classic=['Region'] vs new=['EventBusName', 'RuleName']) |
| `ThrottledRules` | Count | EventBusName, RuleName | direct | `cloud.aws.events.ThrottledRules.By.EventBusName.RuleName` | EventBusName, RuleName |  |
| `ThrottledRules` | Count | Region, RuleName | dimension_change | `cloud.aws.events.ThrottledRules.By.EventBusName.RuleName` | EventBusName, RuleName | same CW metric, different dimensioning (classic=['Region', 'RuleName'] vs new=['EventBusName', 'RuleName']) |
| `ThrottledRules` | Count | Region | dimension_change | `cloud.aws.events.ThrottledRules.By.EventBusName.RuleName` | EventBusName, RuleName | same CW metric, different dimensioning (classic=['Region'] vs new=['EventBusName', 'RuleName']) |
| `TriggeredRules` | Count | EventBusName, RuleName | direct | `cloud.aws.events.TriggeredRules.By.EventBusName.RuleName` | EventBusName, RuleName |  |
| `TriggeredRules` | Count | Region, RuleName | dimension_change | `cloud.aws.events.TriggeredRules.By.EventBusName.RuleName` | EventBusName, RuleName | same CW metric, different dimensioning (classic=['Region', 'RuleName'] vs new=['EventBusName', 'RuleName']) |
| `TriggeredRules` | Count | Region | dimension_change | `cloud.aws.events.TriggeredRules.By.EventBusName.RuleName` | EventBusName, RuleName | same CW metric, different dimensioning (classic=['Region'] vs new=['EventBusName', 'RuleName']) |

### FSx (`fsx`)

- Classic entity: `cloud:aws:fsx` (dimension `FileSystemId`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (6)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `DataReadBytes` | Bytes | FileSystemId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `DataReadOperations` | Count | FileSystemId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `DataWriteBytes` | Bytes | FileSystemId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `DataWriteOperations` | Count | FileSystemId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `FreeStorageCapacity` | Bytes | FileSystemId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `MetadataOperations` | Count | FileSystemId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

### GameLift (`gamelift`)

- Classic entity: `cloud:aws:gamelift` (dimension `FleetId`)
- New block: `AWS::AppRunner::Service` → Smartscape `AWS_APPRUNNER_SERVICE`
- Namespaces: `AWS/AppRunner`
- New recommended metrics: 11

**Raw CloudWatch metrics — Recommended (54)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ActivatingGameSessions` | Count | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ActivatingGameSessions` | Count | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ActiveGameSessions` | Count | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ActiveGameSessions` | Count | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ActiveInstances` | Count | FleetId | dimension_change | `cloud.aws.apprunner.ActiveInstances.By.ServiceID.ServiceName` | ServiceID, ServiceName | same CW metric, different dimensioning (classic=['FleetId'] vs new=['ServiceID', 'ServiceName']) |
| `ActiveInstances` | Count | Region, MetricGroups | dimension_change | `cloud.aws.apprunner.ActiveInstances.By.ServiceID.ServiceName` | ServiceID, ServiceName | same CW metric, different dimensioning (classic=['Region', 'MetricGroups'] vs new=['ServiceID', 'ServiceName']) |
| `ActiveServerProcesses` | Count | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ActiveServerProcesses` | Count | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `AvailableGameSessions` | Count | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `AvailableGameSessions` | Count | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `AverageWaitTime` | Seconds | Region, QueueName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CurrentPlayerSessions` | Count | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CurrentPlayerSessions` | Count | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CurrentTickets` | Count | Region, ConfigurationName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `FirstChoiceOutOfCapacity` | Count/Minute | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `FirstChoiceOutOfCapacity` | Count/Minute | Region, QueueName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `HealthyServerProcesses` | Count | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `HealthyServerProcesses` | Count | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `IdleInstances` | Count | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `IdleInstances` | Count | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `LowestLatencyPlacement` | Count/Minute | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `LowestLatencyPlacement` | Count/Minute | Region, QueueName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MatchAcceptancesTimedOut` | Count/Minute | Region, ConfigurationName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MatchesAccepted` | Count/Minute | Region, ConfigurationName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MatchesCreated` | Count/Minute | Region, ConfigurationName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MatchesPlaced` | Count/Minute | Region, ConfigurationName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MatchesRejected` | Count/Minute | Region, ConfigurationName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PercentAvailableGameSessions` | Percent | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PercentAvailableGameSessions` | Percent | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PercentHealthyServerProcesses` | Percent | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PercentHealthyServerProcesses` | Percent | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PercentIdleInstances` | Percent | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PercentIdleInstances` | Percent | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PlacementsCanceled` | Count/Minute | Region, QueueName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PlacementsFailed` | Count/Minute | Region, QueueName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PlacementsStarted` | Count/Minute | Region, QueueName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PlacementsSucceeded` | Count/Minute | Region, QueueName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PlacementsTimedOut` | Count/Minute | Region, QueueName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PlayerSessionActivations` | Count/Minute | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PlayerSessionActivations` | Count/Minute | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PlayersStarted` | Count/Minute | Region, ConfigurationName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `QueueDepth` | Count | Region, QueueName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServerProcessAbnormalTerminations` | Count/Minute | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServerProcessAbnormalTerminations` | Count/Minute | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServerProcessActivations` | Count/Minute | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServerProcessActivations` | Count/Minute | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServerProcessTerminations` | Count/Minute | FleetId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServerProcessTerminations` | Count/Minute | Region, MetricGroups | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TicketsFailed` | Count/Minute | Region, ConfigurationName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TicketsStarted` | Count/Minute | Region, ConfigurationName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TicketsTimedOut` | Count/Minute | Region, ConfigurationName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TimeToMatch` | Seconds | Region, ConfigurationName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TimeToTicketCancel` | Seconds | Region, ConfigurationName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TimeToTicketSuccess` | Seconds | Region, ConfigurationName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (11)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `DesiredInstances` | Count | FleetId | requires_custom_metric | _—_ | _—_ |
| `FirstChoiceNotViable` | Count/Minute | Region | requires_custom_metric | _—_ | _—_ |
| `FirstChoiceNotViable` | Count/Minute | Region, QueueName | requires_custom_metric | _—_ | _—_ |
| `GameSessionInterruptions` | Count/Minute | FleetId | requires_custom_metric | _—_ | _—_ |
| `GameSessionInterruptions` | Count/Minute | Region, MetricGroups | requires_custom_metric | _—_ | _—_ |
| `InstanceInterruptions` | Count/Minute | FleetId | requires_custom_metric | _—_ | _—_ |
| `InstanceInterruptions` | Count/Minute | Region, MetricGroups | requires_custom_metric | _—_ | _—_ |
| `LowestPricePlacement` | Count/Minute | Region | requires_custom_metric | _—_ | _—_ |
| `LowestPricePlacement` | Count/Minute | Region, QueueName | requires_custom_metric | _—_ | _—_ |
| `MaxInstances` | Count | FleetId | requires_custom_metric | _—_ | _—_ |
| `MinInstances` | Count | FleetId | requires_custom_metric | _—_ | _—_ |

</details>

### Glue (`glue`)

- Classic entity: `cloud:aws:glue` (dimension `JobName`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (4)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `glue.driver.jvm.heap.usage` | Percent | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `glue.ALL.jvm.heap.usage` | Percent | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `glue.ALL.s3.filesystem.read_bytes` | Bytes | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `glue.ALL.s3.filesystem.write_bytes` | Bytes | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (18)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `glue.driver.aggregate.bytesRead` | Bytes | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.aggregate.elapsedTime` | Milliseconds | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.aggregate.numCompletedStages` | Count | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.aggregate.numCompletedTasks` | Count | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.aggregate.numFailedTasks` | Count | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.aggregate.numKilledTasks` | Count | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.aggregate.recordsRead` | Count | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.aggregate.shuffleBytesWritten` | Bytes | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.aggregate.shuffleLocalBytesRead` | Bytes | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.BlockManager.disk.diskSpaceUsed_MB` | Megabytes | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.ExecutorAllocationManager. executors.numberAllExecutors` | Count | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.ExecutorAllocationManager. executors.numberMaxNeededExecutors` | Count | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.jvm.heap.used` | Bytes | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.ALL.jvm.heap.used` | Bytes | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.s3.filesystem.read_bytes` | Bytes | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.s3.filesystem.write_bytes` | Bytes | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.driver.system.cpuSystemLoad` | Percent | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |
| `glue.ALL.system.cpuSystemLoad` | Percent | JobName, JobRunId, Type | no_new_coverage | _—_ | _—_ |

</details>

### Inspector (`inspector`)

- Classic entity: `cloud:aws:inspector` (dimension `AssessmentTemplateArn`)
- New block: `AWS::Bedrock::Guardrail` → Smartscape `AWS_BEDROCK_GUARDRAIL`
- Namespaces: `AWS/Bedrock/Guardrails`
- New recommended metrics: 9

**Raw CloudWatch metrics — Recommended (4)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `TotalAssessmentRuns` | Count | AssessmentTemplateArn, AssessmentTemplateName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TotalFindings` | Count | AssessmentTemplateArn, AssessmentTemplateName | dimension_change | `cloud.aws.bedrock_guardrails.TotalFindings.By.FindingType.GuardrailArn.GuardrailVersion` | FindingType, GuardrailArn, GuardrailVersion | same CW metric, different dimensioning (classic=['AssessmentTemplateArn', 'AssessmentTemplateName'] vs new=['FindingType', 'GuardrailArn', 'GuardrailVersion']) |
| `TotalHealthyAgents` | Count | AssessmentTemplateArn, AssessmentTemplateName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TotalMatchingAgents` | Count | AssessmentTemplateArn, AssessmentTemplateName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (4)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `TotalAssessmentRuns` | Count | Region, AssessmentTargetArn, AssessmentTargetName | requires_custom_metric | _—_ | _—_ |
| `TotalFindings` | Count | Region, AssessmentTargetArn, AssessmentTargetName | dimension_change | `cloud.aws.bedrock_guardrails.TotalFindings.By.FindingType.GuardrailArn.GuardrailVersion` | FindingType, GuardrailArn, GuardrailVersion |
| `TotalHealthyAgents` | Count | Region, AssessmentTargetArn, AssessmentTargetName | requires_custom_metric | _—_ | _—_ |
| `TotalMatchingAgents` | Count | Region, AssessmentTargetArn, AssessmentTargetName | requires_custom_metric | _—_ | _—_ |

</details>

### IoT (`iot`)

- Classic entity: `None` (dimension `None`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (4)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `Connect.Success` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `PublishIn.Success` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `RulesExecuted` | Sum | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Subscribe.Success` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (47)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `CanceledJobExecutionCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `CanceledJobExecutionTotalCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `ClientError` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `Connect.AuthError` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `Connect.ClientError` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `Connect.ServerError` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `Connect.Throttle` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `DeleteThingShadow.Accepted` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `FailedJobExecutionCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `FailedJobExecutionTotalCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `Failure` | Sum | Region, RuleName, ActionType | no_new_coverage | _—_ | _—_ |
| `GetThingShadow.Accepted` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `InProgressJobExecutionCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `InProgressJobExecutionTotalCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `NumLogBatchesFailedToPublishThrottled` | Sum | Region | no_new_coverage | _—_ | _—_ |
| `NumLogEventsFailedToPublishThrottled` | Sum | Region | no_new_coverage | _—_ | _—_ |
| `ParseError` | Sum | Region, RuleName | no_new_coverage | _—_ | _—_ |
| `Ping.Success` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `PublishIn.AuthError` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `PublishIn.ClientError` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `PublishIn.ServerError` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `PublishIn.Throttle` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `PublishOut.AuthError` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `PublishOut.ClientError` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `PublishOut.Success` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `QueuedJobExecutionCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `QueuedJobExecutionTotalCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `RejectedJobExecutionCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `RejectedJobExecutionTotalCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `RemovedJobExecutionCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `RemovedJobExecutionTotalCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `RuleMessageThrottled` | Sum | Region, RuleName | no_new_coverage | _—_ | _—_ |
| `RuleNotFound` | Sum | Region, RuleName | no_new_coverage | _—_ | _—_ |
| `ServerError` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `Subscribe.AuthError` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `Subscribe.ClientError` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `Subscribe.ServerError` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `Subscribe.Throttle` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `SuccededJobExecutionCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `SuccededJobExecutionTotalCount` | Sum | Region, JobId | no_new_coverage | _—_ | _—_ |
| `Success` | Sum | Region, RuleName, ActionType | no_new_coverage | _—_ | _—_ |
| `TopicMatch` | Sum | Region, RuleName | no_new_coverage | _—_ | _—_ |
| `Unsubscribe.ClientError` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `Unsubscribe.ServerError` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `Unsubscribe.Success` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `Unsubscribe.Throttle` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |
| `UpdateThingShadow.Accepted` | Sum | Region, Protocol | no_new_coverage | _—_ | _—_ |

</details>

### IoTAnalytics (`iot_analytics`)

- Classic entity: `None` (dimension `None`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (5)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ActionExecution` | Count | Region, ActionType, DatasetName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ActionExecutionThrottled` | Count | Region, ActionType, DatasetName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ActivityExecutionError` | Count | Region, PipelineActivityName, PipelineActivityType, PipelineName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `IncomingMessages` | Count | Region, ChannelName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `PipelineConcurrentExecutionCount` | Count | Region, PipelineName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

### IoTThingsGraph (`iot_things_graph`)

- Classic entity: `None` (dimension `None`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (5)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `FlowExecutionTime` | Milliseconds | Region, FlowTemplateId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `FlowExecutionsAborted` | Count | Region, FlowTemplateId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `FlowExecutionsFailed` | Count | Region, FlowTemplateId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `FlowExecutionsStarted` | Count | Region, FlowTemplateId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `FlowExecutionsSucceeded` | Count | Region, FlowTemplateId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (16)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `FlowExecutionTime` | Milliseconds | Region, SystemTemplateId | no_new_coverage | _—_ | _—_ |
| `FlowExecutionsAborted` | Count | Region, SystemTemplateId | no_new_coverage | _—_ | _—_ |
| `FlowExecutionsFailed` | Count | Region, SystemTemplateId | no_new_coverage | _—_ | _—_ |
| `FlowExecutionsStarted` | Count | Region, SystemTemplateId | no_new_coverage | _—_ | _—_ |
| `FlowExecutionsSucceeded` | Count | Region, SystemTemplateId | no_new_coverage | _—_ | _—_ |
| `FlowStepExecutionTime` | Milliseconds | Region, FlowTemplateId, StepName | no_new_coverage | _—_ | _—_ |
| `FlowStepExecutionTime` | Milliseconds | Region, SystemTemplateId, StepName | no_new_coverage | _—_ | _—_ |
| `FlowStepExecutionsFailed` | Count | Region, FlowTemplateId, StepName | no_new_coverage | _—_ | _—_ |
| `FlowStepExecutionsFailed` | Count | Region, SystemTemplateId, StepName | no_new_coverage | _—_ | _—_ |
| `FlowStepExecutionsStarted` | Count | Region, FlowTemplateId, StepName | no_new_coverage | _—_ | _—_ |
| `FlowStepExecutionsStarted` | Count | Region, SystemTemplateId, StepName | no_new_coverage | _—_ | _—_ |
| `FlowStepExecutionsSucceeded` | Count | Region, FlowTemplateId, StepName | no_new_coverage | _—_ | _—_ |
| `FlowStepExecutionsSucceeded` | Count | Region, SystemTemplateId, StepName | no_new_coverage | _—_ | _—_ |
| `FlowStepLambdaExecutionsFailed` | Count | Region, LambdaArn | no_new_coverage | _—_ | _—_ |
| `FlowStepLambdaExecutionsStarted` | Count | Region, LambdaArn | no_new_coverage | _—_ | _—_ |
| `FlowStepLambdaExecutionsSucceeded` | Count | Region, LambdaArn | no_new_coverage | _—_ | _—_ |

</details>

### Keyspaces (`keyspaces`)

- Classic entity: `None` (dimension `Keyspace`)
- New block: `AWS::Cassandra::Keyspace` → Smartscape `AWS_CASSANDRA_KEYSPACE`
- Namespaces: `AWS/Cassandra`
- New recommended metrics: 2

**Raw CloudWatch metrics — Recommended (18)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `AccountMaxReads` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `AccountMaxTableLevelReads` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `AccountMaxTableLevelWrites` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `AccountMaxWrites` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `AccountProvisionedReadCapacityUtilization` | Percent | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `AccountProvisionedWriteCapacityUtilization` | Percent | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ConditionalCheckFailed` | Count | Keyspace, Operation, TableName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ConsumedReadCapacityUnits` | Count | Keyspace, TableName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ConsumedWriteCapacityUnits` | Count | Keyspace, TableName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MaxProvisionedTableReadCapacityUtilization` | Percent | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MaxProvisionedTableWriteCapacityUtilization` | Percent | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ProvisionedReadCapacityUnits` | Count | Keyspace, TableName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ProvisionedWriteCapacityUnits` | Count | Keyspace, TableName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ReturnedItemCountBySelect` | Count | Keyspace, Operation, TableName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `SuccessfulRequestCount` | Count | Keyspace, Operation, TableName | direct | `cloud.aws.cassandra.SuccessfulRequestCount.By.Keyspace.Operation` | Keyspace, Operation | dimension set differs slightly (classic=['Keyspace', 'Operation', 'TableName'] vs new=['Keyspace', 'Operation']) |
| `SuccessfulRequestLatency` | Milliseconds | Keyspace, Operation, TableName | direct | `cloud.aws.cassandra.SuccessfulRequestLatency.By.Keyspace.Operation` | Keyspace, Operation | dimension set differs slightly (classic=['Keyspace', 'Operation', 'TableName'] vs new=['Keyspace', 'Operation']) |
| `SystemErrors` | Count | Keyspace, Operation, TableName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `UserErrors` | Count | Keyspace, Operation, TableName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

### Kinesis (`kinesis`)

- Classic entity: `None` (dimension `StreamName`)
- New block: `AWS::KinesisFirehose::DeliveryStream` → Smartscape `AWS_KINESISFIREHOSE_DELIVERYSTREAM`
- Namespaces: `AWS/Firehose`
- New recommended metrics: 6

**Raw CloudWatch metrics — Recommended (11)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `Bytes` | Bytes | Application, Flow, Id | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `Records` | Count | Application, Flow, Id | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `Success` | Count | Application, Flow, Id | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `IncomingBytes` | Bytes | DeliveryStreamName | direct | `cloud.aws.firehose.IncomingBytes.By.DeliveryStreamName` | DeliveryStreamName |  |
| `IncomingRecords` | Count | DeliveryStreamName | direct | `cloud.aws.firehose.IncomingRecords.By.DeliveryStreamName` | DeliveryStreamName |  |
| `GetRecords.IteratorAgeMilliseconds` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `GetMedia.ConnectionErrors` | Count | StreamName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `GetMedia.Success` | Count | StreamName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ListFragments.Latency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PutMedia.ConnectionErrors` | Count | StreamName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PutMedia.Success` | Count | StreamName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (202)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `InputProcessing.DroppedRecords` | Count | Application, Flow, Id | requires_custom_metric | _—_ | _—_ |
| `InputProcessing.Duration` | Milliseconds | Application, Flow, Id | requires_custom_metric | _—_ | _—_ |
| `InputProcessing.OkBytes` | Bytes | Application, Flow, Id | requires_custom_metric | _—_ | _—_ |
| `InputProcessing.OkRecords` | Count | Application, Flow, Id | requires_custom_metric | _—_ | _—_ |
| `InputProcessing.ProcessingFailedRecords` | Count | Application, Flow, Id | requires_custom_metric | _—_ | _—_ |
| `InputProcessing.Success` | Count | Application, Flow, Id | requires_custom_metric | _—_ | _—_ |
| `KPUs` | Count | Application | requires_custom_metric | _—_ | _—_ |
| `LambdaDelivery.DeliveryFailedRecords` | Count | Application, Flow, Id | requires_custom_metric | _—_ | _—_ |
| `LambdaDelivery.Duration` | Milliseconds | Application, Flow, Id | requires_custom_metric | _—_ | _—_ |
| `LambdaDelivery.OkRecords` | Count | Application, Flow, Id | requires_custom_metric | _—_ | _—_ |
| `MillisBehindLatest` | Milliseconds | Application; Application, Flow, Id | requires_custom_metric | _—_ | _—_ |
| `backPressuredTimeMsPerSecond` | Milliseconds | Application | requires_custom_metric | _—_ | _—_ |
| `busyTimeMsPerSecond` | Milliseconds | Application | requires_custom_metric | _—_ | _—_ |
| `bytes_consumed_rate` | Bytes | Application | requires_custom_metric | _—_ | _—_ |
| `commitsFailed` | Count | Application | requires_custom_metric | _—_ | _—_ |
| `commitsSucceeded` | Count | Application | requires_custom_metric | _—_ | _—_ |
| `committedOffsets` | Count | Application | requires_custom_metric | _—_ | _—_ |
| `containerCPUUtilization` | Percent | Application | requires_custom_metric | _—_ | _—_ |
| `containerDiskUtilization` | Percent | Application | requires_custom_metric | _—_ | _—_ |
| `containerMemoryUtilization` | Percent | Application | requires_custom_metric | _—_ | _—_ |
| `cpuUtilization` | Percent | Application | requires_custom_metric | _—_ | _—_ |
| `currentInputWatermark` | Milliseconds | Application | requires_custom_metric | _—_ | _—_ |
| `currentOffsets` | Count | Application | requires_custom_metric | _—_ | _—_ |
| `currentOutputWatermark` | Milliseconds | Application | requires_custom_metric | _—_ | _—_ |
| `downtime` | Milliseconds | Application | requires_custom_metric | _—_ | _—_ |
| `fullRestarts` | Count | Application | requires_custom_metric | _—_ | _—_ |
| `heapMemoryUtilization` | Percent | Application | requires_custom_metric | _—_ | _—_ |
| `idleTimeMsPerSecond` | Milliseconds | Application | requires_custom_metric | _—_ | _—_ |
| `lastCheckpointDuration` | Milliseconds | Application | requires_custom_metric | _—_ | _—_ |
| `lastCheckpointSize` | Bytes | Application | requires_custom_metric | _—_ | _—_ |
| `numRecordsInPerSecond` | Count/Second | Application | requires_custom_metric | _—_ | _—_ |
| `numRecordsIn` | Count | Application | requires_custom_metric | _—_ | _—_ |
| `numRecordsOutPerSecond` | Count/Second | Application | requires_custom_metric | _—_ | _—_ |
| `numRecordsOut` | Count | Application | requires_custom_metric | _—_ | _—_ |
| `numRestarts` | Count | Application | requires_custom_metric | _—_ | _—_ |
| `numberOfFailedCheckpoints` | Count | Application | requires_custom_metric | _—_ | _—_ |
| `oldGenerationGCCount` | Count | Application | requires_custom_metric | _—_ | _—_ |
| `oldGenerationGCTime` | Milliseconds | Application | requires_custom_metric | _—_ | _—_ |
| `processElementavg` | Count | Application, Service | requires_custom_metric | _—_ | _—_ |
| `readDocsavg` | Count | Application, Service | requires_custom_metric | _—_ | _—_ |
| `records_lag_max` | Count | Application | requires_custom_metric | _—_ | _—_ |
| `threadsCount` | Count | Application | requires_custom_metric | _—_ | _—_ |
| `updatesavg` | Count | Application, Service | requires_custom_metric | _—_ | _—_ |
| `uptime` | Milliseconds | Application | requires_custom_metric | _—_ | _—_ |
| `BackupToS3.Bytes` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `BackupToS3.Bytes` | Bytes | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `BackupToS3.DataFreshness` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `BackupToS3.DataFreshness` | Seconds | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `BackupToS3.Records` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `BackupToS3.Records` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `BackupToS3.Success` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `BackupToS3.Success` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DataReadFromKinesisStream.Bytes` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `DataReadFromKinesisStream.Bytes` | Bytes | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DataReadFromKinesisStream.Records` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `DataReadFromKinesisStream.Records` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToElasticsearch.Bytes` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToElasticsearch.Bytes` | Bytes | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToElasticsearch.Records` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToElasticsearch.Records` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToElasticsearch.Success` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToElasticsearch.Success` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToRedshift.Bytes` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToRedshift.Bytes` | Bytes | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToRedshift.Records` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToRedshift.Records` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToRedshift.Success` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToRedshift.Success` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToS3.Bytes` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToS3.Bytes` | Bytes | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToS3.DataFreshness` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToS3.DataFreshness` | Seconds | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToS3.Records` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToS3.Records` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToS3.Success` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToS3.Success` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToSplunk.Bytes` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToSplunk.Bytes` | Bytes | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToSplunk.DataAckLatency` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToSplunk.DataAckLatency` | Seconds | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToSplunk.DataFreshness` | Seconds | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToSplunk.DataFreshness` | Seconds | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToSplunk.Records` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToSplunk.Records` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DeliveryToSplunk.Success` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `DeliveryToSplunk.Success` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DescribeDeliveryStream.Latency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `DescribeDeliveryStream.Latency` | Milliseconds | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `DescribeDeliveryStream.Requests` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `DescribeDeliveryStream.Requests` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `ExecuteProcessing.Duration` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `ExecuteProcessing.Duration` | Milliseconds | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `ExecuteProcessing.Success` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ExecuteProcessing.Success` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `FailedConversion.Bytes` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `FailedConversion.Bytes` | Bytes | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `FailedConversion.Records` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `FailedConversion.Records` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `IncomingBytes` | Bytes | Region | dimension_change | `cloud.aws.firehose.IncomingBytes.By.DeliveryStreamName` | DeliveryStreamName |
| `IncomingRecords` | Count | Region | dimension_change | `cloud.aws.firehose.IncomingRecords.By.DeliveryStreamName` | DeliveryStreamName |
| `KinesisMillisBehindLatest` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `KinesisMillisBehindLatest` | Milliseconds | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `ListDeliveryStreams.Latency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `ListDeliveryStreams.Latency` | Milliseconds | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `ListDeliveryStreams.Requests` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ListDeliveryStreams.Requests` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `PutRecordBatch.Bytes` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `PutRecordBatch.Bytes` | Bytes | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `PutRecordBatch.Latency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `PutRecordBatch.Latency` | Milliseconds | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `PutRecordBatch.Records` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `PutRecordBatch.Records` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `PutRecordBatch.Requests` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `PutRecordBatch.Requests` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `PutRecord.Bytes` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `PutRecord.Bytes` | Bytes | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `PutRecord.Latency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `PutRecord.Latency` | Milliseconds | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `PutRecord.Requests` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `PutRecord.Requests` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `SucceedConversion.Bytes` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `SucceedConversion.Bytes` | Bytes | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `SucceedConversion.Records` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `SucceedConversion.Records` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `SucceedProcessing.Bytes` | Bytes | Region | requires_custom_metric | _—_ | _—_ |
| `SucceedProcessing.Bytes` | Bytes | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `SucceedProcessing.Records` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `SucceedProcessing.Records` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `ThrottledDescribeStream` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ThrottledDescribeStream` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `ThrottledGetRecords` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ThrottledGetRecords` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `ThrottledGetShardIterator` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `ThrottledGetShardIterator` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `UpdateDeliveryStream.Latency` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `UpdateDeliveryStream.Latency` | Milliseconds | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `UpdateDeliveryStream.Requests` | Count | Region | requires_custom_metric | _—_ | _—_ |
| `UpdateDeliveryStream.Requests` | Count | DeliveryStreamName | requires_custom_metric | _—_ | _—_ |
| `GetRecords.Bytes` | Bytes | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetRecords.Latency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetRecords.Records` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetRecords.Success` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `IncomingBytes` | Bytes | ShardId, StreamName | dimension_change | `cloud.aws.firehose.IncomingBytes.By.DeliveryStreamName` | DeliveryStreamName |
| `IncomingBytes` | Bytes | StreamName | dimension_change | `cloud.aws.firehose.IncomingBytes.By.DeliveryStreamName` | DeliveryStreamName |
| `IncomingRecords` | Count | ShardId, StreamName | dimension_change | `cloud.aws.firehose.IncomingRecords.By.DeliveryStreamName` | DeliveryStreamName |
| `IncomingRecords` | Count | StreamName | dimension_change | `cloud.aws.firehose.IncomingRecords.By.DeliveryStreamName` | DeliveryStreamName |
| `IteratorAgeMilliseconds` | Milliseconds | StreamName, ShardId | requires_custom_metric | _—_ | _—_ |
| `OutgoingBytes` | Bytes | StreamName, ShardId | requires_custom_metric | _—_ | _—_ |
| `OutgoingRecords` | Count | StreamName, ShardId | requires_custom_metric | _—_ | _—_ |
| `PutRecord.Bytes` | Bytes | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutRecord.Latency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutRecord.Success` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutRecords.Bytes` | Bytes | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutRecords.Latency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutRecords.Records` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutRecords.Success` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `ReadProvisionedThroughputExceeded` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `SubscribeToShardEvent.Bytes` | Bytes | StreamName, ConsumerName | requires_custom_metric | _—_ | _—_ |
| `SubscribeToShardEvent.MillisBehindLatest` | Milliseconds | StreamName, ConsumerName | requires_custom_metric | _—_ | _—_ |
| `SubscribeToShardEvent.Records` | Count | StreamName, ConsumerName | requires_custom_metric | _—_ | _—_ |
| `SubscribeToShardEvent.Success` | Count | StreamName, ConsumerName | requires_custom_metric | _—_ | _—_ |
| `SubscribeToShard.RateExceeded` | Count | StreamName, ConsumerName | requires_custom_metric | _—_ | _—_ |
| `SubscribeToShard.Success` | Count | StreamName, ConsumerName | requires_custom_metric | _—_ | _—_ |
| `WriteProvisionedThroughputExceeded` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetHLSMasterPlaylist.Latency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetHLSMasterPlaylist.Requests` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetHLSMasterPlaylist.Success` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetHLSMediaPlaylist.Latency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetHLSMediaPlaylist.Requests` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetHLSMediaPlaylist.Success` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetHLSStreamingSessionURL.Latency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetHLSStreamingSessionURL.Requests` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetHLSStreamingSessionURL.Success` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMP4InitFragment.Latency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMP4InitFragment.Requests` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMP4InitFragment.Success` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMP4MediaFragment.Latency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMP4MediaFragment.OutgoingBytes` | Bytes | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMP4MediaFragment.Requests` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMP4MediaFragment.Success` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMediaForFragmentList.OutgoingBytes` | Bytes | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMediaForFragmentList.OutgoingFragments` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMediaForFragmentList.OutgoingFrames` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMediaForFragmentList.Requests` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMediaForFragmentList.Success` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMedia.MillisBehindNow` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMedia.OutgoingBytes` | Bytes | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMedia.OutgoingFragments` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMedia.OutgoingFrames` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `GetMedia.Requests` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutMedia.ActiveConnections` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutMedia.BufferingAckLatency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutMedia.ErrorAckCount` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutMedia.FragmentIngestionLatency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutMedia.FragmentPersistLatency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutMedia.IncomingBytes` | Bytes | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutMedia.IncomingFragments` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutMedia.IncomingFrames` | Count | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutMedia.Latency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutMedia.PersistedAckLatency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutMedia.ReceivedAckLatency` | Milliseconds | StreamName | requires_custom_metric | _—_ | _—_ |
| `PutMedia.Requests` | Count | StreamName | requires_custom_metric | _—_ | _—_ |

</details>

### Lex (`lex`)

- Classic entity: `cloud:aws:lex` (dimension `BotName`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (6)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `MissedUtteranceCount` | Count | BotName, BotAlias, InputMode, Operation | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `MissedUtteranceCount` | Count | BotName, BotAlias, Operation | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `RuntimeRequestCount` | Count | BotName, BotAlias, Operation | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `RuntimeRequestCount` | Count | BotName, BotAlias, InputMode, Operation | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `RuntimeSuccessfulRequestLatency` | Milliseconds | BotName, BotAlias, Operation | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `RuntimeSuccessfulRequestLatency` | Milliseconds | BotName, BotAlias, InputMode, Operation | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (6)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `MissedUtteranceCount` | Count | BotName, BotVersion, InputMode, Operation | no_new_coverage | _—_ | _—_ |
| `MissedUtteranceCount` | Count | BotName, BotVersion, Operation | no_new_coverage | _—_ | _—_ |
| `RuntimeRequestCount` | Count | BotName, BotVersion, InputMode, Operation | no_new_coverage | _—_ | _—_ |
| `RuntimeRequestCount` | Count | BotName, BotVersion, Operation | no_new_coverage | _—_ | _—_ |
| `RuntimeSuccessfulRequestLatency` | Milliseconds | BotName, BotVersion, InputMode, Operation | no_new_coverage | _—_ | _—_ |
| `RuntimeSuccessfulRequestLatency` | Milliseconds | BotName, BotVersion, Operation | no_new_coverage | _—_ | _—_ |

</details>

### MSK (`msk`)

- Classic entity: `cloud:aws:kafka` (dimension `Cluster Name`)
- New block: `AWS::MSK::Cluster` → Smartscape `AWS_MSK_CLUSTER`
- Namespaces: `AWS/Kafka`
- New recommended metrics: 54

**Raw CloudWatch metrics — Recommended (26)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ActiveControllerCount` | Count | Cluster Name | dimension_change | `cloud.aws.kafka.ActiveControllerCount.By.Cluster_Name` | Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name'] vs new=['Cluster_Name']) |
| `CpuIdle` | Percent | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.CpuIdle.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name', 'Broker ID'] vs new=['Broker_ID', 'Cluster_Name']) |
| `CpuSystem` | Percent | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.CpuSystem.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name', 'Broker ID'] vs new=['Broker_ID', 'Cluster_Name']) |
| `CpuUser` | Percent | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.CpuUser.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name', 'Broker ID'] vs new=['Broker_ID', 'Cluster_Name']) |
| `GlobalPartitionCount` | Count | Cluster Name | dimension_change | `cloud.aws.kafka.GlobalPartitionCount.By.Cluster_Name` | Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name'] vs new=['Cluster_Name']) |
| `GlobalTopicCount` | Count | Cluster Name | dimension_change | `cloud.aws.kafka.GlobalTopicCount.By.Cluster_Name` | Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name'] vs new=['Cluster_Name']) |
| `KafkaAppLogsDiskUsed` | Percent | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `KafkaDataLogsDiskUsed` | Percent | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.KafkaDataLogsDiskUsed.By.Cluster_Name` | Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name', 'Broker ID'] vs new=['Cluster_Name']) |
| `MemoryBuffered` | Bytes | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MemoryCached` | Bytes | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MemoryFree` | Bytes | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.MemoryFree.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name', 'Broker ID'] vs new=['Broker_ID', 'Cluster_Name']) |
| `MemoryUsed` | Bytes | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.MemoryUsed.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name', 'Broker ID'] vs new=['Broker_ID', 'Cluster_Name']) |
| `NetworkRxDropped` | Count | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.NetworkRxDropped.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name', 'Broker ID'] vs new=['Broker_ID', 'Cluster_Name']) |
| `NetworkRxErrors` | Count | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.NetworkRxErrors.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name', 'Broker ID'] vs new=['Broker_ID', 'Cluster_Name']) |
| `NetworkRxPackets` | Count | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `NetworkTxDropped` | Count | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.NetworkTxDropped.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name', 'Broker ID'] vs new=['Broker_ID', 'Cluster_Name']) |
| `NetworkTxErrors` | Count | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.NetworkTxErrors.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name', 'Broker ID'] vs new=['Broker_ID', 'Cluster_Name']) |
| `NetworkTxPackets` | Count | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `OfflinePartitionsCount` | Count | Cluster Name | dimension_change | `cloud.aws.kafka.OfflinePartitionsCount.By.Cluster_Name` | Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name'] vs new=['Cluster_Name']) |
| `RootDiskUsed` | Percent | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `SwapFree` | Bytes | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `SwapUsed` | Bytes | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.SwapUsed.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name', 'Broker ID'] vs new=['Broker_ID', 'Cluster_Name']) |
| `ZooKeeperRequestLatencyMsMean` | Milliseconds | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.ZooKeeperRequestLatencyMsMean.By.Cluster_Name` | Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name', 'Broker ID'] vs new=['Cluster_Name']) |
| `ZooKeeperRequestLatencyMsMean` | Milliseconds | Cluster Name | dimension_change | `cloud.aws.kafka.ZooKeeperRequestLatencyMsMean.By.Cluster_Name` | Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name'] vs new=['Cluster_Name']) |
| `ZooKeeperSessionState` | Count | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.ZooKeeperSessionState.By.Cluster_Name` | Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name', 'Broker ID'] vs new=['Cluster_Name']) |
| `ZooKeeperSessionState` | Count | Cluster Name | dimension_change | `cloud.aws.kafka.ZooKeeperSessionState.By.Cluster_Name` | Cluster_Name | same CW metric, different dimensioning (classic=['Cluster Name'] vs new=['Cluster_Name']) |

<details><summary>Raw CloudWatch metrics — Non-recommended (48)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `BytesInPerSec` | Bytes/Second | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.BytesInPerSec.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name |
| `BytesInPerSec` | Bytes/Second | Cluster Name, Broker ID, Topic | dimension_change | `cloud.aws.kafka.BytesInPerSec.By.Broker_ID.Cluster_Name.Topic` | Broker_ID, Cluster_Name, Topic |
| `BytesOutPerSec` | Bytes/Second | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.BytesOutPerSec.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name |
| `BytesOutPerSec` | Bytes/Second | Cluster Name, Broker ID, Topic | dimension_change | `cloud.aws.kafka.BytesOutPerSec.By.Broker_ID.Cluster_Name.Topic` | Broker_ID, Cluster_Name, Topic |
| `CPUCreditBalance` | Count | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `CPUCreditUsage` | Count | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `FetchConsumerLocalTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `FetchConsumerRequestQueueTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `FetchConsumerResponseQueueTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `FetchConsumerResponseSendTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `FetchConsumerTotalTimeMsMean` | Milliseconds | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.FetchConsumerTotalTimeMsMean.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name |
| `FetchFollowerLocalTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `FetchFollowerRequestQueueTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `FetchFollowerResponseQueueTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `FetchFollowerResponseSendTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `FetchFollowerTotalTimeMsMean` | Milliseconds | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.FetchFollowerTotalTimeMsMean.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name |
| `FetchMessageConversionsPerSec` | Count/Second | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `FetchMessageConversionsPerSec` | Count/Second | Cluster Name, Broker ID, Topic | requires_custom_metric | _—_ | _—_ |
| `FetchMessageConversionsTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `FetchThrottleByteRate` | Bytes/Second | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `FetchThrottleQueueSize` | Count | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `FetchThrottleTime` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `LeaderCount` | Count | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.LeaderCount.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name |
| `MessagesInPerSec` | Count/Second | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.MessagesInPerSec.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name |
| `MaxOffsetLag` | Count | Cluster Name, Consumer Group, Topic | dimension_change | `cloud.aws.kafka.MaxOffsetLag.By.Cluster_Name.Consumer_Group.Topic` | Cluster_Name, Consumer_Group, Topic |
| `MessagesInPerSec` | Count/Second | Cluster Name, Broker ID, Topic | dimension_change | `cloud.aws.kafka.MessagesInPerSec.By.Broker_ID.Cluster_Name.Topic` | Broker_ID, Cluster_Name, Topic |
| `NetworkProcessorAvgIdlePercent` | Percent | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `PartitionCount` | Count | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.PartitionCount.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name |
| `ProduceLocalTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `ProduceMessageConversionsPerSec` | Count/Second | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `ProduceMessageConversionsPerSec` | Count/Second | Cluster Name, Broker ID, Topic | requires_custom_metric | _—_ | _—_ |
| `ProduceMessageConversionsTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `ProduceRequestQueueTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `ProduceResponseQueueTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `ProduceResponseSendTimeMsMean` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `ProduceThrottleByteRate` | Bytes/Second | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `ProduceThrottleQueueSize` | Count | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `ProduceThrottleTime` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `ProduceTotalTimeMsMean` | Milliseconds | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.ProduceTotalTimeMsMean.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name |
| `RequestBytesMean` | Bytes | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.RequestBytesMean.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name |
| `RequestExemptFromThrottleTime` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `RequestHandlerAvgIdlePercent` | Percent | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `RequestThrottleQueueSize` | Count | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.RequestThrottleQueueSize.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name |
| `RequestThrottleTime` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `RequestTime` | Milliseconds | Cluster Name, Broker ID | requires_custom_metric | _—_ | _—_ |
| `SumOffsetLag` | Count | Cluster Name, Consumer Group, Topic | dimension_change | `cloud.aws.kafka.SumOffsetLag.By.Cluster_Name.Consumer_Group.Topic` | Cluster_Name, Consumer_Group, Topic |
| `UnderMinIsrPartitionCount` | Count | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.UnderMinIsrPartitionCount.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name |
| `UnderReplicatedPartitions` | Count | Cluster Name, Broker ID | dimension_change | `cloud.aws.kafka.UnderReplicatedPartitions.By.Broker_ID.Cluster_Name` | Broker_ID, Cluster_Name |

</details>

### MQ (`mq`)

- Classic entity: `None` (dimension `Broker`)
- New block: `AWS::AmazonMQ::Broker` → Smartscape `AWS_AMAZONMQ_BROKER`
- Namespaces: `AWS/AmazonMQ`
- New recommended metrics: 22

**Raw CloudWatch metrics — Recommended (19)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CpuCreditBalance` | Count | Broker | direct | `cloud.aws.amazonmq.CpuCreditBalance.By.Broker` | Broker |  |
| `CpuUtilization` | Percent | Broker | direct | `cloud.aws.amazonmq.CpuUtilization.By.Broker` | Broker |  |
| `CurrentConnectionsCount` | Count | Broker | direct | `cloud.aws.amazonmq.CurrentConnectionsCount.By.Broker` | Broker |  |
| `HeapUsage` | Percent | Broker | direct | `cloud.aws.amazonmq.HeapUsage.By.Broker` | Broker |  |
| `TotalConsumerCount` | Count | Broker | direct | `cloud.aws.amazonmq.TotalConsumerCount.By.Broker` | Broker |  |
| `TotalMessageCount` | Count | Broker | direct | `cloud.aws.amazonmq.TotalMessageCount.By.Broker` | Broker |  |
| `TotalProducerCount` | Count | Broker | direct | `cloud.aws.amazonmq.TotalProducerCount.By.Broker` | Broker |  |
| `AckRate` | Count/Second | Broker | direct | `cloud.aws.amazonmq.AckRate.By.Broker` | Broker |  |
| `ConfirmRate` | Count/Second | Broker | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ConsumerCount` | Count | Broker | direct | `cloud.aws.amazonmq.ConsumerCount.By.Broker` | Broker |  |
| `MessageCount` | Count | Broker | direct | `cloud.aws.amazonmq.MessageCount.By.Broker` | Broker |  |
| `MessageReadyCount` | Count | Broker | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MessageUnacknowledgedCount` | Count | Broker | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `PublishRate` | Count/Second | Broker | direct | `cloud.aws.amazonmq.PublishRate.By.Broker` | Broker |  |
| `RabbitMQDiskFreeLimit` | Bytes | Broker, Node | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `RabbitMQDiskFree` | Bytes | Broker, Node | direct | `cloud.aws.amazonmq.RabbitMQDiskFree.By.Broker.Node` | Broker, Node |  |
| `RabbitMQMemLimit` | Bytes | Broker, Node | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `RabbitMQMemUsed` | Bytes | Broker, Node | direct | `cloud.aws.amazonmq.RabbitMQMemUsed.By.Broker.Node` | Broker, Node |  |
| `SystemCpuUtilization` | Percent | Broker, Node | direct | `cloud.aws.amazonmq.SystemCpuUtilization.By.Broker.Node` | Broker, Node |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (43)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ConsumerCount` | Count | Broker, Topic | direct | `cloud.aws.amazonmq.ConsumerCount.By.Broker` | Broker |
| `ConsumerCount` | Count | Broker, Queue | direct | `cloud.aws.amazonmq.ConsumerCount.By.Broker` | Broker |
| `DequeueCount` | Count | Broker, NetworkConnector, RemoteBroker | requires_custom_metric | _—_ | _—_ |
| `DequeueCount` | Count | Broker, Topic | requires_custom_metric | _—_ | _—_ |
| `DequeueCount` | Count | Broker, Queue | requires_custom_metric | _—_ | _—_ |
| `DispatchCount` | Count | Broker, Topic | requires_custom_metric | _—_ | _—_ |
| `DispatchCount` | Count | Broker, Queue | requires_custom_metric | _—_ | _—_ |
| `EnqueueCount` | Count | Broker, NetworkConnector, RemoteBroker | requires_custom_metric | _—_ | _—_ |
| `EnqueueCount` | Count | Broker, Topic | requires_custom_metric | _—_ | _—_ |
| `EnqueueCount` | Count | Broker, Queue | requires_custom_metric | _—_ | _—_ |
| `EnqueueTime` | Milliseconds | Broker, Topic | requires_custom_metric | _—_ | _—_ |
| `EnqueueTime` | Milliseconds | Broker, Queue | requires_custom_metric | _—_ | _—_ |
| `EstablishedConnectionsCount` | Count | Broker | requires_custom_metric | _—_ | _—_ |
| `ExpiredCount` | Count | Broker, Topic | requires_custom_metric | _—_ | _—_ |
| `ExpiredCount` | Count | Broker, Queue | requires_custom_metric | _—_ | _—_ |
| `InFlightCount` | Count | Broker, Topic | requires_custom_metric | _—_ | _—_ |
| `InFlightCount` | Count | Broker, Queue | requires_custom_metric | _—_ | _—_ |
| `InactiveDurableTopicSubscribersCount` | Count | Broker | requires_custom_metric | _—_ | _—_ |
| `JobSchedulerStorePercentUsage` | Percent | Broker | requires_custom_metric | _—_ | _—_ |
| `JournalFilesForFastRecovery` | Count | Broker | requires_custom_metric | _—_ | _—_ |
| `JournalFilesForFullRecovery` | Count | Broker | requires_custom_metric | _—_ | _—_ |
| `MemoryUsage` | Percent | Broker, Topic | requires_custom_metric | _—_ | _—_ |
| `MemoryUsage` | Percent | Broker, Queue | requires_custom_metric | _—_ | _—_ |
| `NetworkIn` | Bytes | Broker | direct | `cloud.aws.amazonmq.NetworkIn.By.Broker` | Broker |
| `NetworkOut` | Bytes | Broker | direct | `cloud.aws.amazonmq.NetworkOut.By.Broker` | Broker |
| `OpenTransactionCount` | Count | Broker | requires_custom_metric | _—_ | _—_ |
| `ProducerCount` | Count | Broker, Topic | requires_custom_metric | _—_ | _—_ |
| `ProducerCount` | Count | Broker, Queue | requires_custom_metric | _—_ | _—_ |
| `QueueSize` | Count | Broker, Queue | requires_custom_metric | _—_ | _—_ |
| `ReceiveCount` | Count | Broker, NetworkConnector, RemoteBroker | requires_custom_metric | _—_ | _—_ |
| `StorePercentUsage` | Percent | Broker | requires_custom_metric | _—_ | _—_ |
| `TempPercentUsage` | Percent | Broker | requires_custom_metric | _—_ | _—_ |
| `TotalDequeueCount` | Count | Broker | requires_custom_metric | _—_ | _—_ |
| `TotalEnqueueCount` | Count | Broker | requires_custom_metric | _—_ | _—_ |
| `ChannelCount` | Count | Broker | requires_custom_metric | _—_ | _—_ |
| `ConnectionCount` | Count | Broker | direct | `cloud.aws.amazonmq.ConnectionCount.By.Broker` | Broker |
| `ConsumerCount` | Count | Broker, Queue, VirtualHost | direct | `cloud.aws.amazonmq.ConsumerCount.By.Broker.Queue.VirtualHost` | Broker, Queue, VirtualHost |
| `ExchangeCount` | Count | Broker | requires_custom_metric | _—_ | _—_ |
| `MessageCount` | Count | Broker, Queue, VirtualHost | direct | `cloud.aws.amazonmq.MessageCount.By.Broker.Queue.VirtualHost` | Broker, Queue, VirtualHost |
| `MessageReadyCount` | Count | Broker, Queue, VirtualHost | requires_custom_metric | _—_ | _—_ |
| `MessageUnacknowledgedCount` | Count | Broker, Queue, VirtualHost | requires_custom_metric | _—_ | _—_ |
| `QueueCount` | Count | Broker | requires_custom_metric | _—_ | _—_ |
| `RabbitMQFdUsed` | Count | Broker, Node | requires_custom_metric | _—_ | _—_ |

</details>

### Neptune (`neptune`)

- Classic entity: `cloud:aws:neptune` (dimension `DBClusterIdentifier`)
- Matched 2 new blocks:
  - `AWS::Neptune::DBInstance` → `AWS_NEPTUNE_DBINSTANCE` (namespaces: `AWS/Neptune`, recommended: 13)
  - `AWS::Neptune::DBCluster` → `AWS_NEPTUNE_DBCLUSTER` (namespaces: `AWS/Neptune`, recommended: 17)

**Raw CloudWatch metrics — Recommended (74)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CPUUtilization` | Percent | DBClusterIdentifier | direct | `cloud.aws.neptune.CPUUtilization.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `CPUUtilization` | Percent | Region | dimension_change | `cloud.aws.neptune.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region'] vs new=['DBInstanceIdentifier']) |
| `CPUUtilization` | Percent | Region, DBInstanceIdentifier | direct | `cloud.aws.neptune.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier | dimension set differs slightly (classic=['Region', 'DBInstanceIdentifier'] vs new=['DBInstanceIdentifier']) |
| `CPUUtilization` | Percent | Region, DatabaseClass | dimension_change | `cloud.aws.neptune.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'DatabaseClass'] vs new=['DBInstanceIdentifier']) |
| `CPUUtilization` | Percent | Region, EngineName | dimension_change | `cloud.aws.neptune.CPUUtilization.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBInstanceIdentifier']) |
| `ClusterReplicaLag` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ClusterReplicaLag` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ClusterReplicaLag` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ClusterReplicaLag` | Milliseconds | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ClusterReplicaLag` | Milliseconds | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ClusterReplicaLag` | Milliseconds | Region, EngineName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `EngineUptime` | Seconds | DBClusterIdentifier | dimension_change | `cloud.aws.neptune.EngineUptime.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['DBClusterIdentifier'] vs new=['DBInstanceIdentifier']) |
| `EngineUptime` | Seconds | DBClusterIdentifier, Role | dimension_change | `cloud.aws.neptune.EngineUptime.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['DBClusterIdentifier', 'Role'] vs new=['DBInstanceIdentifier']) |
| `EngineUptime` | Seconds | Region | dimension_change | `cloud.aws.neptune.EngineUptime.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region'] vs new=['DBInstanceIdentifier']) |
| `EngineUptime` | Seconds | Region, DBInstanceIdentifier | direct | `cloud.aws.neptune.EngineUptime.By.DBInstanceIdentifier` | DBInstanceIdentifier | dimension set differs slightly (classic=['Region', 'DBInstanceIdentifier'] vs new=['DBInstanceIdentifier']) |
| `EngineUptime` | Seconds | Region, DatabaseClass | dimension_change | `cloud.aws.neptune.EngineUptime.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'DatabaseClass'] vs new=['DBInstanceIdentifier']) |
| `EngineUptime` | Seconds | Region, EngineName | dimension_change | `cloud.aws.neptune.EngineUptime.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBInstanceIdentifier']) |
| `FreeableMemory` | Bytes | DBClusterIdentifier | direct | `cloud.aws.neptune.FreeableMemory.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `FreeableMemory` | Bytes | DBClusterIdentifier, Role | direct | `cloud.aws.neptune.FreeableMemory.By.DBClusterIdentifier.Role` | DBClusterIdentifier, Role |  |
| `FreeableMemory` | Bytes | Region | dimension_change | `cloud.aws.neptune.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region'] vs new=['DBInstanceIdentifier']) |
| `FreeableMemory` | Bytes | Region, DBInstanceIdentifier | direct | `cloud.aws.neptune.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier | dimension set differs slightly (classic=['Region', 'DBInstanceIdentifier'] vs new=['DBInstanceIdentifier']) |
| `FreeableMemory` | Bytes | Region, DatabaseClass | dimension_change | `cloud.aws.neptune.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'DatabaseClass'] vs new=['DBInstanceIdentifier']) |
| `FreeableMemory` | Bytes | Region, EngineName | dimension_change | `cloud.aws.neptune.FreeableMemory.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBInstanceIdentifier']) |
| `GremlinRequestsPerSec` | Count/Second | DBClusterIdentifier | dimension_change | `cloud.aws.neptune.GremlinRequestsPerSec.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['DBClusterIdentifier'] vs new=['DBInstanceIdentifier']) |
| `GremlinRequestsPerSec` | Count/Second | DBClusterIdentifier, Role | dimension_change | `cloud.aws.neptune.GremlinRequestsPerSec.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['DBClusterIdentifier', 'Role'] vs new=['DBInstanceIdentifier']) |
| `GremlinRequestsPerSec` | Count/Second | Region | dimension_change | `cloud.aws.neptune.GremlinRequestsPerSec.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region'] vs new=['DBInstanceIdentifier']) |
| `GremlinRequestsPerSec` | Count/Second | Region, DBInstanceIdentifier | direct | `cloud.aws.neptune.GremlinRequestsPerSec.By.DBInstanceIdentifier` | DBInstanceIdentifier | dimension set differs slightly (classic=['Region', 'DBInstanceIdentifier'] vs new=['DBInstanceIdentifier']) |
| `GremlinRequestsPerSec` | Count/Second | Region, DatabaseClass | dimension_change | `cloud.aws.neptune.GremlinRequestsPerSec.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'DatabaseClass'] vs new=['DBInstanceIdentifier']) |
| `GremlinRequestsPerSec` | Count/Second | Region, EngineName | dimension_change | `cloud.aws.neptune.GremlinRequestsPerSec.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBInstanceIdentifier']) |
| `MainRequestQueuePendingRequests` | Count/Second | DBClusterIdentifier | direct | `cloud.aws.neptune.MainRequestQueuePendingRequests.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `MainRequestQueuePendingRequests` | Count/Second | DBClusterIdentifier, Role | direct | `cloud.aws.neptune.MainRequestQueuePendingRequests.By.DBClusterIdentifier.Role` | DBClusterIdentifier, Role |  |
| `MainRequestQueuePendingRequests` | Count/Second | Region | dimension_change | `cloud.aws.neptune.MainRequestQueuePendingRequests.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region'] vs new=['DBClusterIdentifier']) |
| `MainRequestQueuePendingRequests` | Count/Second | Region, DBInstanceIdentifier | dimension_change | `cloud.aws.neptune.MainRequestQueuePendingRequests.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region', 'DBInstanceIdentifier'] vs new=['DBClusterIdentifier']) |
| `MainRequestQueuePendingRequests` | Count/Second | Region, DatabaseClass | dimension_change | `cloud.aws.neptune.MainRequestQueuePendingRequests.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region', 'DatabaseClass'] vs new=['DBClusterIdentifier']) |
| `MainRequestQueuePendingRequests` | Count/Second | Region, EngineName | dimension_change | `cloud.aws.neptune.MainRequestQueuePendingRequests.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBClusterIdentifier']) |
| `NetworkThroughput` | Bytes/Second | DBClusterIdentifier | direct | `cloud.aws.neptune.NetworkThroughput.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `NetworkThroughput` | Bytes/Second | DBClusterIdentifier, Role | direct | `cloud.aws.neptune.NetworkThroughput.By.DBClusterIdentifier.Role` | DBClusterIdentifier, Role |  |
| `NetworkThroughput` | Bytes/Second | Region | dimension_change | `cloud.aws.neptune.NetworkThroughput.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region'] vs new=['DBClusterIdentifier']) |
| `NetworkThroughput` | Bytes/Second | Region, DBInstanceIdentifier | dimension_change | `cloud.aws.neptune.NetworkThroughput.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region', 'DBInstanceIdentifier'] vs new=['DBClusterIdentifier']) |
| `NetworkThroughput` | Bytes/Second | Region, DatabaseClass | dimension_change | `cloud.aws.neptune.NetworkThroughput.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region', 'DatabaseClass'] vs new=['DBClusterIdentifier']) |
| `NetworkThroughput` | Bytes/Second | Region, EngineName | dimension_change | `cloud.aws.neptune.NetworkThroughput.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBClusterIdentifier']) |
| `SparqlRequestsPerSec` | Count/Second | DBClusterIdentifier | dimension_change | `cloud.aws.neptune.SparqlRequestsPerSec.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['DBClusterIdentifier'] vs new=['DBInstanceIdentifier']) |
| `SparqlRequestsPerSec` | Count/Second | DBClusterIdentifier, Role | dimension_change | `cloud.aws.neptune.SparqlRequestsPerSec.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['DBClusterIdentifier', 'Role'] vs new=['DBInstanceIdentifier']) |
| `SparqlRequestsPerSec` | Count/Second | Region | dimension_change | `cloud.aws.neptune.SparqlRequestsPerSec.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region'] vs new=['DBInstanceIdentifier']) |
| `SparqlRequestsPerSec` | Count/Second | Region, DBInstanceIdentifier | direct | `cloud.aws.neptune.SparqlRequestsPerSec.By.DBInstanceIdentifier` | DBInstanceIdentifier | dimension set differs slightly (classic=['Region', 'DBInstanceIdentifier'] vs new=['DBInstanceIdentifier']) |
| `SparqlRequestsPerSec` | Count/Second | Region, DatabaseClass | dimension_change | `cloud.aws.neptune.SparqlRequestsPerSec.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'DatabaseClass'] vs new=['DBInstanceIdentifier']) |
| `SparqlRequestsPerSec` | Count/Second | Region, EngineName | dimension_change | `cloud.aws.neptune.SparqlRequestsPerSec.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBInstanceIdentifier']) |
| `TotalClientErrorsPerSec` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TotalClientErrorsPerSec` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TotalClientErrorsPerSec` | Count/Second | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TotalClientErrorsPerSec` | Count/Second | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TotalClientErrorsPerSec` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TotalClientErrorsPerSec` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TotalRequestsPerSec` | Count/Second | DBClusterIdentifier | direct | `cloud.aws.neptune.TotalRequestsPerSec.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `TotalRequestsPerSec` | Count/Second | DBClusterIdentifier, Role | direct | `cloud.aws.neptune.TotalRequestsPerSec.By.DBClusterIdentifier.Role` | DBClusterIdentifier, Role |  |
| `TotalRequestsPerSec` | Count/Second | Region | dimension_change | `cloud.aws.neptune.TotalRequestsPerSec.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region'] vs new=['DBClusterIdentifier']) |
| `TotalRequestsPerSec` | Count/Second | Region, DBInstanceIdentifier | dimension_change | `cloud.aws.neptune.TotalRequestsPerSec.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region', 'DBInstanceIdentifier'] vs new=['DBClusterIdentifier']) |
| `TotalRequestsPerSec` | Count/Second | Region, DatabaseClass | dimension_change | `cloud.aws.neptune.TotalRequestsPerSec.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region', 'DatabaseClass'] vs new=['DBClusterIdentifier']) |
| `TotalRequestsPerSec` | Count/Second | Region, EngineName | dimension_change | `cloud.aws.neptune.TotalRequestsPerSec.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBClusterIdentifier']) |
| `TotalServerErrorsPerSec` | Count/Second | DBClusterIdentifier | direct | `cloud.aws.neptune.TotalServerErrorsPerSec.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `TotalServerErrorsPerSec` | Count/Second | DBClusterIdentifier, Role | direct | `cloud.aws.neptune.TotalServerErrorsPerSec.By.DBClusterIdentifier.Role` | DBClusterIdentifier, Role |  |
| `TotalServerErrorsPerSec` | Count/Second | Region | dimension_change | `cloud.aws.neptune.TotalServerErrorsPerSec.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region'] vs new=['DBClusterIdentifier']) |
| `TotalServerErrorsPerSec` | Count/Second | Region, DBInstanceIdentifier | dimension_change | `cloud.aws.neptune.TotalServerErrorsPerSec.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region', 'DBInstanceIdentifier'] vs new=['DBClusterIdentifier']) |
| `TotalServerErrorsPerSec` | Count/Second | Region, DatabaseClass | dimension_change | `cloud.aws.neptune.TotalServerErrorsPerSec.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region', 'DatabaseClass'] vs new=['DBClusterIdentifier']) |
| `TotalServerErrorsPerSec` | Count/Second | Region, EngineName | dimension_change | `cloud.aws.neptune.TotalServerErrorsPerSec.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBClusterIdentifier']) |
| `VolumeBytesUsed` | Bytes | DBClusterIdentifier | direct | `cloud.aws.neptune.VolumeBytesUsed.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `VolumeBytesUsed` | Bytes | Region, EngineName | dimension_change | `cloud.aws.neptune.VolumeBytesUsed.By.DBClusterIdentifier` | DBClusterIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBClusterIdentifier']) |
| `VolumeBytesLeftTotal` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `VolumeBytesLeftTotal` | Bytes | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `VolumeBytesLeftTotal` | Bytes | Region, EngineName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `VolumeReadIOPs` | Bytes | DBClusterIdentifier | direct | `cloud.aws.neptune.VolumeReadIOPs.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `VolumeReadIOPs` | Bytes | Region, EngineName | dimension_change | `cloud.aws.neptune.VolumeReadIOPs.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBInstanceIdentifier']) |
| `VolumeWriteIOPs` | Bytes | DBClusterIdentifier | direct | `cloud.aws.neptune.VolumeWriteIOPs.By.DBClusterIdentifier` | DBClusterIdentifier |  |
| `VolumeWriteIOPs` | Bytes | Region, EngineName | dimension_change | `cloud.aws.neptune.VolumeWriteIOPs.By.DBInstanceIdentifier` | DBInstanceIdentifier | same CW metric, different dimensioning (classic=['Region', 'EngineName'] vs new=['DBInstanceIdentifier']) |

<details><summary>Raw CloudWatch metrics — Non-recommended (60)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `BackupRetentionPeriodStorageUsed` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `BackupRetentionPeriodStorageUsed` | Bytes | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ClusterReplicaLagMaximum` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ClusterReplicaLagMaximum` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ClusterReplicaLagMaximum` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `ClusterReplicaLagMaximum` | Milliseconds | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ClusterReplicaLagMaximum` | Milliseconds | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ClusterReplicaLagMaximum` | Milliseconds | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `ClusterReplicaLagMinimum` | Milliseconds | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `ClusterReplicaLagMinimum` | Milliseconds | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `ClusterReplicaLagMinimum` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ |
| `ClusterReplicaLagMinimum` | Milliseconds | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `ClusterReplicaLagMinimum` | Milliseconds | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `ClusterReplicaLagMinimum` | Milliseconds | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `GremlinWebSocketOpenConnections` | Count/Second | DBClusterIdentifier | dimension_change | `cloud.aws.neptune.GremlinWebSocketOpenConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `GremlinWebSocketOpenConnections` | Count/Second | DBClusterIdentifier, Role | dimension_change | `cloud.aws.neptune.GremlinWebSocketOpenConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `GremlinWebSocketOpenConnections` | Count/Second | Region | dimension_change | `cloud.aws.neptune.GremlinWebSocketOpenConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `GremlinWebSocketOpenConnections` | Count/Second | Region, DBInstanceIdentifier | direct | `cloud.aws.neptune.GremlinWebSocketOpenConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `GremlinWebSocketOpenConnections` | Count/Second | Region, DatabaseClass | dimension_change | `cloud.aws.neptune.GremlinWebSocketOpenConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `GremlinWebSocketOpenConnections` | Count/Second | Region, EngineName | dimension_change | `cloud.aws.neptune.GremlinWebSocketOpenConnections.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `LoaderRequestsPerSec` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `LoaderRequestsPerSec` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `LoaderRequestsPerSec` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `LoaderRequestsPerSec` | Count/Second | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `LoaderRequestsPerSec` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `LoaderRequestsPerSec` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `NetworkReceiveThroughput` | Bytes/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkReceiveThroughput` | Bytes/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `NetworkReceiveThroughput` | Bytes/Second | Region | requires_custom_metric | _—_ | _—_ |
| `NetworkReceiveThroughput` | Bytes/Second | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkReceiveThroughput` | Bytes/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `NetworkReceiveThroughput` | Bytes/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | Region | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `NumTxCommitted` | Count/Second | DBClusterIdentifier | dimension_change | `cloud.aws.neptune.NumTxCommitted.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NumTxCommitted` | Count/Second | DBClusterIdentifier, Role | dimension_change | `cloud.aws.neptune.NumTxCommitted.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NumTxCommitted` | Count/Second | Region | dimension_change | `cloud.aws.neptune.NumTxCommitted.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NumTxCommitted` | Count/Second | Region, DBInstanceIdentifier | direct | `cloud.aws.neptune.NumTxCommitted.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NumTxCommitted` | Count/Second | Region, DatabaseClass | dimension_change | `cloud.aws.neptune.NumTxCommitted.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NumTxCommitted` | Count/Second | Region, EngineName | dimension_change | `cloud.aws.neptune.NumTxCommitted.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NumTxOpened` | Count/Second | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `NumTxOpened` | Count/Second | DBClusterIdentifier, Role | requires_custom_metric | _—_ | _—_ |
| `NumTxOpened` | Count/Second | Region | requires_custom_metric | _—_ | _—_ |
| `NumTxOpened` | Count/Second | Region, DBInstanceIdentifier | requires_custom_metric | _—_ | _—_ |
| `NumTxOpened` | Count/Second | Region, DatabaseClass | requires_custom_metric | _—_ | _—_ |
| `NumTxOpened` | Count/Second | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `NumTxRolledBack` | Count/Second | DBClusterIdentifier | dimension_change | `cloud.aws.neptune.NumTxRolledBack.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NumTxRolledBack` | Count/Second | DBClusterIdentifier, Role | dimension_change | `cloud.aws.neptune.NumTxRolledBack.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NumTxRolledBack` | Count/Second | Region | dimension_change | `cloud.aws.neptune.NumTxRolledBack.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NumTxRolledBack` | Count/Second | Region, DBInstanceIdentifier | direct | `cloud.aws.neptune.NumTxRolledBack.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NumTxRolledBack` | Count/Second | Region, DatabaseClass | dimension_change | `cloud.aws.neptune.NumTxRolledBack.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `NumTxRolledBack` | Count/Second | Region, EngineName | dimension_change | `cloud.aws.neptune.NumTxRolledBack.By.DBInstanceIdentifier` | DBInstanceIdentifier |
| `SnapshotStorageUsed` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `SnapshotStorageUsed` | Bytes | Region, EngineName | requires_custom_metric | _—_ | _—_ |
| `TotalBackupStorageBilled` | Bytes | DBClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `TotalBackupStorageBilled` | Bytes | Region, EngineName | requires_custom_metric | _—_ | _—_ |

</details>

### OpsWorks (`opsworks`)

- Classic entity: `cloud:aws:opsworks` (dimension `StackId`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (30)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `cpu_idle` | Percent | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `cpu_idle` | Percent | Region, InstanceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `cpu_idle` | Percent | Region, LayerId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `cpu_nice` | Percent | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `cpu_steal` | Percent | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `cpu_steal` | Percent | Region, InstanceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `cpu_steal` | Percent | Region, LayerId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `cpu_system` | Percent | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `cpu_user` | Percent | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `cpu_user` | Percent | Region, InstanceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `cpu_user` | Percent | Region, LayerId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `cpu_waitio` | Percent | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `load_5` | None | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `load_5` | None | Region, InstanceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `load_5` | None | Region, LayerId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `memory_buffers` | None | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `memory_cached` | None | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `memory_free` | None | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `memory_free` | None | Region, InstanceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `memory_free` | None | Region, LayerId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `memory_swap` | None | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `memory_total` | None | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `memory_total` | None | Region, InstanceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `memory_total` | None | Region, LayerId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `memory_used` | None | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `memory_used` | None | Region, InstanceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `memory_used` | None | Region, LayerId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `procs` | None | StackId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `procs` | None | Region, InstanceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `procs` | None | Region, LayerId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (18)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `cpu_nice` | Percent | Region, InstanceId | no_new_coverage | _—_ | _—_ |
| `cpu_nice` | Percent | Region, LayerId | no_new_coverage | _—_ | _—_ |
| `cpu_system` | Percent | Region, InstanceId | no_new_coverage | _—_ | _—_ |
| `cpu_system` | Percent | Region, LayerId | no_new_coverage | _—_ | _—_ |
| `cpu_waitio` | Percent | Region, InstanceId | no_new_coverage | _—_ | _—_ |
| `cpu_waitio` | Percent | Region, LayerId | no_new_coverage | _—_ | _—_ |
| `load_1` | None | StackId | no_new_coverage | _—_ | _—_ |
| `load_1` | None | Region, InstanceId | no_new_coverage | _—_ | _—_ |
| `load_1` | None | Region, LayerId | no_new_coverage | _—_ | _—_ |
| `load_15` | None | StackId | no_new_coverage | _—_ | _—_ |
| `load_15` | None | Region, InstanceId | no_new_coverage | _—_ | _—_ |
| `load_15` | None | Region, LayerId | no_new_coverage | _—_ | _—_ |
| `memory_buffers` | None | Region, InstanceId | no_new_coverage | _—_ | _—_ |
| `memory_buffers` | None | Region, LayerId | no_new_coverage | _—_ | _—_ |
| `memory_cached` | None | Region, InstanceId | no_new_coverage | _—_ | _—_ |
| `memory_cached` | None | Region, LayerId | no_new_coverage | _—_ | _—_ |
| `memory_swap` | None | Region, InstanceId | no_new_coverage | _—_ | _—_ |
| `memory_swap` | None | Region, LayerId | no_new_coverage | _—_ | _—_ |

</details>

### Polly (`polly`)

- Classic entity: `None` (dimension `None`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (5)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `4XXCount` | Count | Region, Operation | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `2XXCount` | Count | Region, Operation | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `5XXCount` | Count | Region, Operation | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `RequestCharacters` | Count | Region, Operation | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ResponseLatency` | Milliseconds | Region, Operation | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

### QLDB (`qldb`)

- Classic entity: `cloud:aws:qldb` (dimension `LedgerName`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (10)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CommandLatency` | Milliseconds | LedgerName, CommandType | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `IndexedStorage` | Bytes | LedgerName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `IsImpaired` | Count | LedgerName, StreamId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `JournalStorage` | Bytes | LedgerName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `OccConflictExceptions` | Count | LedgerName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ReadIOs` | Count | LedgerName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `SessionRateExceededExceptions` | Count | LedgerName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Session4xxExceptions` | Count | LedgerName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Session5xxExceptions` | Count | LedgerName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `WriteIOs` | Count | LedgerName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

### Redshift (`redshift`)

- Classic entity: `cloud:aws:redshift` (dimension `ClusterIdentifier`)
- New block: `AWS::Redshift::Cluster` → Smartscape `AWS_REDSHIFT_CLUSTER`
- Namespaces: `AWS/Redshift`
- New recommended metrics: 20

**Raw CloudWatch metrics — Recommended (6)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CPUUtilization` | Percent | ClusterIdentifier | direct | `cloud.aws.redshift.CPUUtilization.By.ClusterIdentifier` | ClusterIdentifier |  |
| `CPUUtilization` | Percent | ClusterIdentifier, NodeID | direct | `cloud.aws.redshift.CPUUtilization.By.ClusterIdentifier.NodeID` | ClusterIdentifier, NodeID |  |
| `HealthStatus` | Count | ClusterIdentifier | direct | `cloud.aws.redshift.HealthStatus.By.ClusterIdentifier` | ClusterIdentifier |  |
| `NetworkReceiveThroughput` | Bytes/Second | ClusterIdentifier | direct | `cloud.aws.redshift.NetworkReceiveThroughput.By.ClusterIdentifier` | ClusterIdentifier |  |
| `NetworkReceiveThroughput` | Bytes/Second | ClusterIdentifier, NodeID | direct | `cloud.aws.redshift.NetworkReceiveThroughput.By.ClusterIdentifier.NodeID` | ClusterIdentifier, NodeID |  |
| `PercentageDiskSpaceUsed` | Percent | ClusterIdentifier | direct | `cloud.aws.redshift.PercentageDiskSpaceUsed.By.ClusterIdentifier` | ClusterIdentifier |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (8)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `DatabaseConnections` | Count | ClusterIdentifier, NodeID | direct | `cloud.aws.redshift.DatabaseConnections.By.ClusterIdentifier.NodeID` | ClusterIdentifier, NodeID |
| `DatabaseConnections` | Count | ClusterIdentifier | direct | `cloud.aws.redshift.DatabaseConnections.By.ClusterIdentifier` | ClusterIdentifier |
| `Healthstatus` | Count | ClusterIdentifier, NodeID | requires_custom_metric | _—_ | _—_ |
| `MaintenanceMode` | Count | ClusterIdentifier, NodeID | requires_custom_metric | _—_ | _—_ |
| `MaintenanceMode` | Count | ClusterIdentifier | requires_custom_metric | _—_ | _—_ |
| `NetworkTransmitThroughput` | Bytes/Second | ClusterIdentifier, NodeID | direct | `cloud.aws.redshift.NetworkTransmitThroughput.By.ClusterIdentifier.NodeID` | ClusterIdentifier, NodeID |
| `NetworkTransmitThroughput` | Bytes/Second | ClusterIdentifier | direct | `cloud.aws.redshift.NetworkTransmitThroughput.By.ClusterIdentifier` | ClusterIdentifier |
| `PercentageDiskSpaceUsed` | Percent | ClusterIdentifier, NodeID | direct | `cloud.aws.redshift.PercentageDiskSpaceUsed.By.ClusterIdentifier.NodeID` | ClusterIdentifier, NodeID |

</details>

### Rekognition (`rekognition`)

- Classic entity: `None` (dimension `None`)
- New block: `AWS::Cassandra::Keyspace` → Smartscape `AWS_CASSANDRA_KEYSPACE`
- Namespaces: `AWS/Cassandra`
- New recommended metrics: 2

**Raw CloudWatch metrics — Recommended (13)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `DetectedFaceCount` | Count | Region, Operation | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DetectedFaceCount` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DetectedLabelCount` | Count | Region, Operation | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ResponseTime` | Milliseconds | Region, Operation | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ResponseTime` | Milliseconds | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServerErrorCount` | Count | Region, Operation | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServerErrorCount` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `SuccessfulRequestCount` | Count | Region, Operation | dimension_change | `cloud.aws.cassandra.SuccessfulRequestCount.By.Keyspace.Operation` | Keyspace, Operation | same CW metric, different dimensioning (classic=['Region', 'Operation'] vs new=['Keyspace', 'Operation']) |
| `SuccessfulRequestCount` | Count | Region | dimension_change | `cloud.aws.cassandra.SuccessfulRequestCount.By.Keyspace.Operation` | Keyspace, Operation | same CW metric, different dimensioning (classic=['Region'] vs new=['Keyspace', 'Operation']) |
| `ThrottledCount` | Count | Region, Operation | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ThrottledCount` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `UserErrorCount` | Count | Region, Operation | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `UserErrorCount` | Count | Region | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (1)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `DetectedLabelCount` | Count | Region | requires_custom_metric | _—_ | _—_ |

</details>

### RoboMaker (`robomaker`)

- Classic entity: `cloud:aws:robomaker` (dimension `SimulationJobId`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (4)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `Memory` | Gigabytes | SimulationJobId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `RealTimeFactor` | Count | SimulationJobId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `SimulationUnit` | Count | SimulationJobId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `vCPU` | Count | SimulationJobId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

### Route53 (`route53`)

- Classic entity: `cloud:aws:route53` (dimension `HostedZoneId`)
- New block: `AWS::Route53::HealthCheck` → Smartscape `AWS_ROUTE53_HEALTHCHECK`
- Namespaces: `AWS/Route53`
- New recommended metrics: 6

**Raw CloudWatch metrics — Recommended (1)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `DNSQueries` | Count | HostedZoneId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (9)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ChildHealthCheckHealthyCount` | Count | Region, HealthCheckId | requires_custom_metric | _—_ | _—_ |
| `ConnectionTime` | Milliseconds | Region, HealthCheckId, Region | direct | `cloud.aws.route53.ConnectionTime.By.HealthCheckId.Region` | HealthCheckId, Region |
| `ConnectionTime` | Milliseconds | Region, HealthCheckId | direct | `cloud.aws.route53.ConnectionTime.By.HealthCheckId.Region` | HealthCheckId, Region |
| `HealthCheckPercentageHealthy` | Percent | Region, HealthCheckId | direct | `cloud.aws.route53.HealthCheckPercentageHealthy.By.HealthCheckId` | HealthCheckId |
| `HealthCheckStatus` | None | Region, HealthCheckId | direct | `cloud.aws.route53.HealthCheckStatus.By.HealthCheckId` | HealthCheckId |
| `SSLHandshakeTime` | Milliseconds | Region, HealthCheckId, Region | requires_custom_metric | _—_ | _—_ |
| `SSLHandshakeTime` | Milliseconds | Region, HealthCheckId | requires_custom_metric | _—_ | _—_ |
| `TimeToFirstByte` | Milliseconds | Region, HealthCheckId, Region | direct | `cloud.aws.route53.TimeToFirstByte.By.HealthCheckId.Region` | HealthCheckId, Region |
| `TimeToFirstByte` | Milliseconds | Region, HealthCheckId | direct | `cloud.aws.route53.TimeToFirstByte.By.HealthCheckId.Region` | HealthCheckId, Region |

</details>

### Route53Resolver (`route53_resolver`)

- Classic entity: `cloud:aws:route53resolver` (dimension `EndpointId`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (5)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `InboundQueryVolume` | Count | EndpointId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `InboundQueryVolume` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `OutboundQueryAggregateVolume` | Count | EndpointId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `OutboundQueryVolume` | Count | EndpointId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `OutboundQueryVolume` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (5)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `EndpointHealthyENICount` | Count | EndpointId | no_new_coverage | _—_ | _—_ |
| `EndpointUnHealthyENICount` | Count | EndpointId | no_new_coverage | _—_ | _—_ |
| `InboundQueryVolume` | Count | Region, RniId | no_new_coverage | _—_ | _—_ |
| `OutboundQueryAggregateVolume` | Count | Region | no_new_coverage | _—_ | _—_ |
| `OutboundQueryAggregateVolume` | Count | Region, RniId | no_new_coverage | _—_ | _—_ |

</details>

### SageMaker (`sagemaker`)

- Classic entity: `cloud:aws:sage_maker:endpoint` (dimension `EndpointName`)
- New block: `AWS::AppRunner::Service` → Smartscape `AWS_APPRUNNER_SERVICE`
- Namespaces: `AWS/AppRunner`
- New recommended metrics: 11

**Raw CloudWatch metrics — Recommended (16)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CPUUtilization` | Percent | Region, Host | dimension_change | `cloud.aws.apprunner.CPUUtilization.By.ServiceID.ServiceName` | ServiceID, ServiceName | same CW metric, different dimensioning (classic=['Region', 'Host'] vs new=['ServiceID', 'ServiceName']) |
| `MemoryUtilization` | Percent | Region, Host | dimension_change | `cloud.aws.apprunner.MemoryUtilization.By.ServiceID.ServiceName` | ServiceID, ServiceName | same CW metric, different dimensioning (classic=['Region', 'Host'] vs new=['ServiceID', 'ServiceName']) |
| `GPUMemoryUtilization` | Percent | Region, Host | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `GPUUtilization` | Percent | Region, Host | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DiskUtilization` | Percent | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CPUUtilization` | Percent | EndpointName, VariantName | dimension_change | `cloud.aws.apprunner.CPUUtilization.By.ServiceID.ServiceName` | ServiceID, ServiceName | same CW metric, different dimensioning (classic=['EndpointName', 'VariantName'] vs new=['ServiceID', 'ServiceName']) |
| `GPUMemoryUtilization` | Percent | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `GPUUtilization` | Percent | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MemoryUtilization` | Percent | EndpointName, VariantName | dimension_change | `cloud.aws.apprunner.MemoryUtilization.By.ServiceID.ServiceName` | ServiceID, ServiceName | same CW metric, different dimensioning (classic=['EndpointName', 'VariantName'] vs new=['ServiceID', 'ServiceName']) |
| `Invocations` | None | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ModelLatency` | Microseconds | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `OverheadLatency` | Microseconds | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DatasetObjectsAutoAnnotated` | None | Region, LabelingJobName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DatasetObjectsHumanAnnotated` | None | Region, LabelingJobName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `DatasetObjectsLabelingFailed` | None | Region, LabelingJobName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TotalDatasetObjectsLabeled` | None | Region, LabelingJobName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (15)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `LoadedModelCount` | None | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ |
| `Invocation4XXErrors` | None | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ |
| `Invocation5XXErrors` | None | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ |
| `InvocationsPerInstance` | None | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ |
| `ModelCacheHit` | None | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ |
| `ModelLoadingTime` | Microseconds | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ |
| `ModelLoadingWaitTime` | Microseconds | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ |
| `ModelDownloadingTime` | Microseconds | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ |
| `ModelUnloadingTime` | Microseconds | EndpointName, VariantName | requires_custom_metric | _—_ | _—_ |
| `ActiveWorkers` | None | Region, LabelingJobName | requires_custom_metric | _—_ | _—_ |
| `JobsFailed` | None | Region | requires_custom_metric | _—_ | _—_ |
| `JobsStopped` | None | Region | requires_custom_metric | _—_ | _—_ |
| `JobsSucceeded` | None | Region | requires_custom_metric | _—_ | _—_ |
| `TasksSubmitted` | None | Region, LabelingJobName | requires_custom_metric | _—_ | _—_ |
| `TimeSpent` | Seconds | Region, LabelingJobName | requires_custom_metric | _—_ | _—_ |

</details>

### ServiceCatalog (`service_catalog`)

- Classic entity: `None` (dimension `None`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (4)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ProvisionedProductLaunch` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ProvisionedProductLaunch` | Count | Region, ProductId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ProvisionedProductLaunch` | Count | Region, State | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ProvisionedProductLaunch` | Count | Region, ProvisioningArtifactId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

### SES (`ses`)

- Classic entity: `None` (dimension `None`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (5)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `Delivery` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Reject` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Reputation.BounceRate` | Percent | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Reputation.ComplaintRate` | Percent | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Send` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (8)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `Bounce` | Count | Region | no_new_coverage | _—_ | _—_ |
| `Click` | Count | Region | no_new_coverage | _—_ | _—_ |
| `Complaint` | Count | Region | no_new_coverage | _—_ | _—_ |
| `Open` | Count | Region | no_new_coverage | _—_ | _—_ |
| `PublishExpired` | Count | Region, RuleName | no_new_coverage | _—_ | _—_ |
| `PublishExpired` | Count | Region, RuleSetName | no_new_coverage | _—_ | _—_ |
| `PublishFailure` | Count | Region, RuleName | no_new_coverage | _—_ | _—_ |
| `Rendering Failure` | Count | Region | no_new_coverage | _—_ | _—_ |

</details>

### SNS (`sns`)

- Classic entity: `cloud:aws:sns` (dimension `TopicName`)
- New block: `AWS::SNS::Topic` → Smartscape `AWS_SNS_TOPIC`
- Namespaces: `AWS/SNS`
- New recommended metrics: 7

**Raw CloudWatch metrics — Recommended (3)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `NumberOfMessagesPublished` | Count | TopicName | direct | `cloud.aws.sns.NumberOfMessagesPublished.By.TopicName` | TopicName |  |
| `NumberOfNotificationsDelivered` | Count | TopicName | direct | `cloud.aws.sns.NumberOfNotificationsDelivered.By.TopicName` | TopicName |  |
| `NumberOfNotificationsFailed` | Count/Minute | TopicName | direct | `cloud.aws.sns.NumberOfNotificationsFailed.By.TopicName` | TopicName |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (34)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `NumberOfMessagesPublished` | Count | Application, Region | dimension_change | `cloud.aws.sns.NumberOfMessagesPublished.By.TopicName` | TopicName |
| `NumberOfMessagesPublished` | Count | Country, Region, SMSType | dimension_change | `cloud.aws.sns.NumberOfMessagesPublished.By.TopicName` | TopicName |
| `NumberOfMessagesPublished` | Count | Platform, Region | dimension_change | `cloud.aws.sns.NumberOfMessagesPublished.By.TopicName` | TopicName |
| `NumberOfNotificationsDelivered` | Count | Application, Region | dimension_change | `cloud.aws.sns.NumberOfNotificationsDelivered.By.TopicName` | TopicName |
| `NumberOfNotificationsDelivered` | Count | Country, Region, SMSType | dimension_change | `cloud.aws.sns.NumberOfNotificationsDelivered.By.TopicName` | TopicName |
| `NumberOfNotificationsDelivered` | Count | Platform, Region | dimension_change | `cloud.aws.sns.NumberOfNotificationsDelivered.By.TopicName` | TopicName |
| `NumberOfNotificationsFailed` | Count/Minute | Application, Region | dimension_change | `cloud.aws.sns.NumberOfNotificationsFailed.By.TopicName` | TopicName |
| `NumberOfNotificationsFailed` | Count/Minute | Country, Region, SMSType | dimension_change | `cloud.aws.sns.NumberOfNotificationsFailed.By.TopicName` | TopicName |
| `NumberOfNotificationsFailed` | Count/Minute | Platform, Region | dimension_change | `cloud.aws.sns.NumberOfNotificationsFailed.By.TopicName` | TopicName |
| `NumberOfNotificationsFilteredOut-InvalidAttributes` | Count | Application, Region | requires_custom_metric | _—_ | _—_ |
| `NumberOfNotificationsFilteredOut-InvalidAttributes` | Count | Country, Region, SMSType | requires_custom_metric | _—_ | _—_ |
| `NumberOfNotificationsFilteredOut-InvalidAttributes` | Count | Platform, Region | requires_custom_metric | _—_ | _—_ |
| `NumberOfNotificationsFilteredOut-InvalidAttributes` | Count | TopicName | requires_custom_metric | _—_ | _—_ |
| `NumberOfNotificationsFilteredOut-NoMessageAttributes` | Count | Application, Region | requires_custom_metric | _—_ | _—_ |
| `NumberOfNotificationsFilteredOut-NoMessageAttributes` | Count | Country, Region, SMSType | requires_custom_metric | _—_ | _—_ |
| `NumberOfNotificationsFilteredOut-NoMessageAttributes` | Count | Platform, Region | requires_custom_metric | _—_ | _—_ |
| `NumberOfNotificationsFilteredOut-NoMessageAttributes` | Count | TopicName | requires_custom_metric | _—_ | _—_ |
| `NumberOfNotificationsFilteredOut` | Count | Application, Region | dimension_change | `cloud.aws.sns.NumberOfNotificationsFilteredOut.By.TopicName` | TopicName |
| `NumberOfNotificationsFilteredOut` | Count | Country, Region, SMSType | dimension_change | `cloud.aws.sns.NumberOfNotificationsFilteredOut.By.TopicName` | TopicName |
| `NumberOfNotificationsFilteredOut` | Count | Platform, Region | dimension_change | `cloud.aws.sns.NumberOfNotificationsFilteredOut.By.TopicName` | TopicName |
| `NumberOfNotificationsFilteredOut` | Count | TopicName | direct | `cloud.aws.sns.NumberOfNotificationsFilteredOut.By.TopicName` | TopicName |
| `PublishSize` | Bytes | Application, Region | dimension_change | `cloud.aws.sns.PublishSize.By.TopicName` | TopicName |
| `PublishSize` | Bytes | Country, Region, SMSType | dimension_change | `cloud.aws.sns.PublishSize.By.TopicName` | TopicName |
| `PublishSize` | Bytes | Platform, Region | dimension_change | `cloud.aws.sns.PublishSize.By.TopicName` | TopicName |
| `PublishSize` | Bytes | TopicName | direct | `cloud.aws.sns.PublishSize.By.TopicName` | TopicName |
| `SMSMonthToDateSpentUSD` | Count | Application, Region | requires_custom_metric | _—_ | _—_ |
| `SMSMonthToDateSpentUSD` | Count | Country, Region, SMSType | requires_custom_metric | _—_ | _—_ |
| `SMSMonthToDateSpentUSD` | Count | Platform, Region | requires_custom_metric | _—_ | _—_ |
| `SMSMonthToDateSpentUSD` | Count | Region 1 | requires_custom_metric | _—_ | _—_ |
| `SMSMonthToDateSpentUSD` | Count | TopicName | requires_custom_metric | _—_ | _—_ |
| `SMSSuccessRate` | Count | Application, Region | dimension_change | `cloud.aws.sns.SMSSuccessRate.By.TopicName` | TopicName |
| `SMSSuccessRate` | Count | Country, Region, SMSType | dimension_change | `cloud.aws.sns.SMSSuccessRate.By.TopicName` | TopicName |
| `SMSSuccessRate` | Count | Platform, Region | dimension_change | `cloud.aws.sns.SMSSuccessRate.By.TopicName` | TopicName |
| `SMSSuccessRate` | Count | TopicName | direct | `cloud.aws.sns.SMSSuccessRate.By.TopicName` | TopicName |

</details>

### SQS (`sqs`)

- Classic entity: `cloud:aws:sqs` (dimension `QueueName`)
- New block: `AWS::SQS::Queue` → Smartscape `AWS_SQS_QUEUE`
- Namespaces: `AWS/SQS`
- New recommended metrics: 9

**Raw CloudWatch metrics — Recommended (1)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ApproximateAgeOfOldestMessage` | Seconds | QueueName | direct | `cloud.aws.sqs.ApproximateAgeOfOldestMessage.By.QueueName` | QueueName |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (8)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ApproximateNumberOfMessagesDelayed` | Count | QueueName | direct | `cloud.aws.sqs.ApproximateNumberOfMessagesDelayed.By.QueueName` | QueueName |
| `ApproximateNumberOfMessagesNotVisible` | Count | QueueName | direct | `cloud.aws.sqs.ApproximateNumberOfMessagesNotVisible.By.QueueName` | QueueName |
| `ApproximateNumberOfMessagesVisible` | Count | QueueName | direct | `cloud.aws.sqs.ApproximateNumberOfMessagesVisible.By.QueueName` | QueueName |
| `NumberOfEmptyReceives` | Count | QueueName | direct | `cloud.aws.sqs.NumberOfEmptyReceives.By.QueueName` | QueueName |
| `NumberOfMessagesDeleted` | Count | QueueName | direct | `cloud.aws.sqs.NumberOfMessagesDeleted.By.QueueName` | QueueName |
| `NumberOfMessagesReceived` | Count | QueueName | direct | `cloud.aws.sqs.NumberOfMessagesReceived.By.QueueName` | QueueName |
| `NumberOfMessagesSent` | Count | QueueName | direct | `cloud.aws.sqs.NumberOfMessagesSent.By.QueueName` | QueueName |
| `SentMessageSize` | Bytes | QueueName | direct | `cloud.aws.sqs.SentMessageSize.By.QueueName` | QueueName |

</details>

### S3_other (`s3_other`)

- Classic entity: `None` (dimension `BucketName`)
- New block: `AWS::S3::Bucket` → Smartscape `AWS_S3_BUCKET`
- Namespaces: `AWS/S3`
- New recommended metrics: 14

**Raw CloudWatch metrics — Recommended (3)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `AllRequests` | Count | BucketName, FilterId | direct | `cloud.aws.s3.AllRequests.By.BucketName.FilterId` | BucketName, FilterId |  |
| `4xxErrors` | Count | BucketName, FilterId | direct | `cloud.aws.s3.4xxErrors.By.BucketName.FilterId` | BucketName, FilterId |  |
| `5xxErrors` | Count | BucketName, FilterId | direct | `cloud.aws.s3.5xxErrors.By.BucketName.FilterId` | BucketName, FilterId |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (13)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `BytesDownloaded` | Bytes | BucketName, FilterId | direct | `cloud.aws.s3.BytesDownloaded.By.BucketName.FilterId` | BucketName, FilterId |
| `BytesUploaded` | Bytes | BucketName, FilterId | direct | `cloud.aws.s3.BytesUploaded.By.BucketName.FilterId` | BucketName, FilterId |
| `DeleteRequests` | Count | BucketName, FilterId | direct | `cloud.aws.s3.DeleteRequests.By.BucketName.FilterId` | BucketName, FilterId |
| `FirstByteLatency` | Milliseconds | BucketName, FilterId | direct | `cloud.aws.s3.FirstByteLatency.By.BucketName.FilterId` | BucketName, FilterId |
| `GetRequests` | Count | BucketName, FilterId | direct | `cloud.aws.s3.GetRequests.By.BucketName.FilterId` | BucketName, FilterId |
| `HeadRequests` | Count | BucketName, FilterId | direct | `cloud.aws.s3.HeadRequests.By.BucketName.FilterId` | BucketName, FilterId |
| `ListRequests` | Count | BucketName, FilterId | direct | `cloud.aws.s3.ListRequests.By.BucketName.FilterId` | BucketName, FilterId |
| `PostRequests` | Count | BucketName, FilterId | direct | `cloud.aws.s3.PostRequests.By.BucketName.FilterId` | BucketName, FilterId |
| `PutRequests` | Count | BucketName, FilterId | direct | `cloud.aws.s3.PutRequests.By.BucketName.FilterId` | BucketName, FilterId |
| `SelectRequests` | Count | BucketName, FilterId | direct | `cloud.aws.s3.SelectRequests.By.BucketName.FilterId` | BucketName, FilterId |
| `SelectReturnedBytes` | Bytes | BucketName, FilterId | requires_custom_metric | _—_ | _—_ |
| `SelectScannedBytes` | Bytes | BucketName, FilterId | requires_custom_metric | _—_ | _—_ |
| `TotalRequestLatency` | Milliseconds | BucketName, FilterId | direct | `cloud.aws.s3.TotalRequestLatency.By.BucketName.FilterId` | BucketName, FilterId |

</details>

### SWF (`swf`)

- Classic entity: `cloud:aws:swf` (dimension `Domain`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (14)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ActivityTaskScheduleToCloseTime` | Milliseconds | Domain, ActivityTypeName, ActivityTypeVersion | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ActivityTaskScheduleToStartTime` | Milliseconds | Domain, ActivityTypeName, ActivityTypeVersion | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ActivityTaskStartToCloseTime` | Milliseconds | Domain, ActivityTypeName, ActivityTypeVersion | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ConsumedCapacity` | Count | Region, DecisionName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `DecisionTaskScheduleToStartTime` | Milliseconds | Domain, WorkflowTypeName, WorkflowTypeVersion | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `DecisionTaskStartToCloseTime` | Milliseconds | Domain, WorkflowTypeName, WorkflowTypeVersion | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ThrottledEvents` | Count | Region, DecisionName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `WorkflowStartToCloseTime` | Milliseconds | Domain, WorkflowTypeName, WorkflowTypeVersion | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `WorkflowsCanceled` | Count | Domain, WorkflowTypeName, WorkflowTypeVersion | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `WorkflowsCompleted` | Count | Domain, WorkflowTypeName, WorkflowTypeVersion | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `WorkflowsContinuedAsNew` | Count | Domain, WorkflowTypeName, WorkflowTypeVersion | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `WorkflowsFailed` | Count | Domain, WorkflowTypeName, WorkflowTypeVersion | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `WorkflowsTerminated` | Count | Domain, WorkflowTypeName, WorkflowTypeVersion | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `WorkflowsTimedOut` | Count | Domain, WorkflowTypeName, WorkflowTypeVersion | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (16)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ActivityTasksCanceled` | Count | Domain, ActivityTypeName, ActivityTypeVersion | no_new_coverage | _—_ | _—_ |
| `ActivityTasksCompleted` | Count | Domain, ActivityTypeName, ActivityTypeVersion | no_new_coverage | _—_ | _—_ |
| `ActivityTasksFailed` | Count | Domain, ActivityTypeName, ActivityTypeVersion | no_new_coverage | _—_ | _—_ |
| `ConsumedCapacity` | Count | Region, APIName | no_new_coverage | _—_ | _—_ |
| `DecisionTasksCompleted` | Count | Domain, WorkflowTypeName, WorkflowTypeVersion | no_new_coverage | _—_ | _—_ |
| `PendingTasks` | Count | Domain | no_new_coverage | _—_ | _—_ |
| `ProvisionedBucketSize` | Count | Region, APIName | no_new_coverage | _—_ | _—_ |
| `ProvisionedBucketSize` | Count | Region, DecisionName | no_new_coverage | _—_ | _—_ |
| `ProvisionedRefillRate` | Count | Region, APIName | no_new_coverage | _—_ | _—_ |
| `ProvisionedRefillRate` | Count | Region, DecisionName | no_new_coverage | _—_ | _—_ |
| `ScheduledActivityTasksTimedOutOnClose` | Count | Domain, ActivityTypeName, ActivityTypeVersion | no_new_coverage | _—_ | _—_ |
| `ScheduledActivityTasksTimedOutOnStart` | Count | Domain, ActivityTypeName, ActivityTypeVersion | no_new_coverage | _—_ | _—_ |
| `StartedActivityTasksTimedOutOnClose` | Count | Domain, ActivityTypeName, ActivityTypeVersion | no_new_coverage | _—_ | _—_ |
| `StartedActivityTasksTimedOutOnHeartbeat` | Count | Domain, ActivityTypeName, ActivityTypeVersion | no_new_coverage | _—_ | _—_ |
| `StartedDecisionTasksTimedOutOnClose` | Count | Domain, WorkflowTypeName, WorkflowTypeVersion | no_new_coverage | _—_ | _—_ |
| `ThrottledEvents` | Count | Region, APIName | no_new_coverage | _—_ | _—_ |

</details>

### StepFunctions (`step_functions`)

- Classic entity: `None` (dimension `StateMachineArn`)
- New block: `AWS::StepFunctions::StateMachine` → Smartscape `AWS_STEPFUNCTIONS_STATEMACHINE`
- Namespaces: `AWS/States`
- New recommended metrics: 7

**Raw CloudWatch metrics — Recommended (27)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ActivitiesFailed` | Count | Region, ActivityArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ActivitiesHeartbeatTimedOut` | Count | Region, ActivityArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ActivitiesScheduled` | Count | Region, ActivityArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ActivitiesSucceeded` | Count | Region, ActivityArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ActivitiesTimedOut` | Count | Region, ActivityArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ActivityRunTime` | Milliseconds | Region, ActivityArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ConsumedCapacity` | Count | Region, ServiceMetric | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ConsumedCapacity` | Count | Region, APIName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ExecutionThrottled` | Count | Region, StateMachineArn | direct | `cloud.aws.states.ExecutionThrottled.By.StateMachineArn` | StateMachineArn | dimension set differs slightly (classic=['Region', 'StateMachineArn'] vs new=['StateMachineArn']) |
| `ExecutionTime` | Milliseconds | Region, StateMachineArn | direct | `cloud.aws.states.ExecutionTime.By.StateMachineArn` | StateMachineArn | dimension set differs slightly (classic=['Region', 'StateMachineArn'] vs new=['StateMachineArn']) |
| `ExecutionsAborted` | Count | Region, StateMachineArn | direct | `cloud.aws.states.ExecutionsAborted.By.StateMachineArn` | StateMachineArn | dimension set differs slightly (classic=['Region', 'StateMachineArn'] vs new=['StateMachineArn']) |
| `ExecutionsFailed` | Count | Region, StateMachineArn | direct | `cloud.aws.states.ExecutionsFailed.By.StateMachineArn` | StateMachineArn | dimension set differs slightly (classic=['Region', 'StateMachineArn'] vs new=['StateMachineArn']) |
| `ExecutionsStarted` | Count | Region, StateMachineArn | direct | `cloud.aws.states.ExecutionsStarted.By.StateMachineArn` | StateMachineArn | dimension set differs slightly (classic=['Region', 'StateMachineArn'] vs new=['StateMachineArn']) |
| `ExecutionsSucceeded` | Count | Region, StateMachineArn | direct | `cloud.aws.states.ExecutionsSucceeded.By.StateMachineArn` | StateMachineArn | dimension set differs slightly (classic=['Region', 'StateMachineArn'] vs new=['StateMachineArn']) |
| `ExecutionsTimedOut` | Count | Region, StateMachineArn | direct | `cloud.aws.states.ExecutionsTimedOut.By.StateMachineArn` | StateMachineArn | dimension set differs slightly (classic=['Region', 'StateMachineArn'] vs new=['StateMachineArn']) |
| `LambdaFunctionRunTime` | Milliseconds | Region, LambdaFunctionArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `LambdaFunctionsFailed` | Count | Region, LambdaFunctionArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `LambdaFunctionsScheduled` | Count | Region, LambdaFunctionArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `LambdaFunctionsSucceeded` | Count | Region, LambdaFunctionArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `LambdaFunctionsTimedOut` | Count | Region, LambdaFunctionArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServiceIntegrationRunTime` | Milliseconds | Region, ServiceIntegrationResourceArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServiceIntegrationsFailed` | Count | Region, ServiceIntegrationResourceArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServiceIntegrationsScheduled` | Count | Region, ServiceIntegrationResourceArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServiceIntegrationsSucceeded` | Count | Region, ServiceIntegrationResourceArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServiceIntegrationsTimedOut` | Count | Region, ServiceIntegrationResourceArn | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ThrottledEvents` | Count | Region, ServiceMetric | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ThrottledEvents` | Count | Region, APIName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (13)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ActivitiesStarted` | Count | Region, ActivityArn | requires_custom_metric | _—_ | _—_ |
| `ActivityScheduleTime` | Milliseconds | Region, ActivityArn | requires_custom_metric | _—_ | _—_ |
| `ActivityTime` | Milliseconds | Region, ActivityArn | requires_custom_metric | _—_ | _—_ |
| `LambdaFunctionScheduleTime` | Milliseconds | Region, LambdaFunctionArn | requires_custom_metric | _—_ | _—_ |
| `LambdaFunctionTime` | Milliseconds | Region, LambdaFunctionArn | requires_custom_metric | _—_ | _—_ |
| `LambdaFunctionsStarted` | Count | Region, LambdaFunctionArn | requires_custom_metric | _—_ | _—_ |
| `ProvisionedBucketSize` | Count | Region, ServiceMetric | requires_custom_metric | _—_ | _—_ |
| `ProvisionedBucketSize` | Count | Region, APIName | requires_custom_metric | _—_ | _—_ |
| `ProvisionedRefillRate` | Count | Region, ServiceMetric | requires_custom_metric | _—_ | _—_ |
| `ProvisionedRefillRate` | Count | Region, APIName | requires_custom_metric | _—_ | _—_ |
| `ServiceIntegrationScheduleTime` | Milliseconds | Region, ServiceIntegrationResourceArn | requires_custom_metric | _—_ | _—_ |
| `ServiceIntegrationTime` | Milliseconds | Region, ServiceIntegrationResourceArn | requires_custom_metric | _—_ | _—_ |
| `ServiceIntegrationsStarted` | Count | Region, ServiceIntegrationResourceArn | requires_custom_metric | _—_ | _—_ |

</details>

### StorageGateway (`storage_gateway`)

- Classic entity: `cloud:aws:storagegateway` (dimension `GatewayName`)
- New block: `AWS::StorageGateway::Gateway` → Smartscape `AWS_STORAGEGATEWAY_GATEWAY`
- Namespaces: `AWS/StorageGateway`
- New recommended metrics: 10

**Raw CloudWatch metrics — Recommended (38)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CacheFree` | Bytes | GatewayName, GatewayId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CacheHitPercent` | Percent | Region, ShareId | dimension_change | `cloud.aws.storagegateway.CacheHitPercent.By.GatewayId.GatewayName` | GatewayId, GatewayName | same CW metric, different dimensioning (classic=['Region', 'ShareId'] vs new=['GatewayId', 'GatewayName']) |
| `CacheHitPercent` | Percent | Region, VolumeId | dimension_change | `cloud.aws.storagegateway.CacheHitPercent.By.GatewayId.GatewayName` | GatewayId, GatewayName | same CW metric, different dimensioning (classic=['Region', 'VolumeId'] vs new=['GatewayId', 'GatewayName']) |
| `CacheHitPercent` | Percent | GatewayName, GatewayId | direct | `cloud.aws.storagegateway.CacheHitPercent.By.GatewayId.GatewayName` | GatewayId, GatewayName |  |
| `CachePercentDirty` | Percent | Region, ShareId | dimension_change | `cloud.aws.storagegateway.CachePercentDirty.By.GatewayId.GatewayName` | GatewayId, GatewayName | same CW metric, different dimensioning (classic=['Region', 'ShareId'] vs new=['GatewayId', 'GatewayName']) |
| `CachePercentDirty` | Percent | Region, VolumeId | dimension_change | `cloud.aws.storagegateway.CachePercentDirty.By.GatewayId.GatewayName` | GatewayId, GatewayName | same CW metric, different dimensioning (classic=['Region', 'VolumeId'] vs new=['GatewayId', 'GatewayName']) |
| `CachePercentDirty` | Percent | GatewayName, GatewayId | direct | `cloud.aws.storagegateway.CachePercentDirty.By.GatewayId.GatewayName` | GatewayId, GatewayName |  |
| `CachePercentUsed` | Percent | Region, ShareId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CachePercentUsed` | Percent | Region, VolumeId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CachePercentUsed` | Percent | GatewayName, GatewayId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `CacheUsed` | Bytes | GatewayName, GatewayId | direct | `cloud.aws.storagegateway.CacheUsed.By.GatewayId.GatewayName` | GatewayId, GatewayName |  |
| `CloudBytesDownloaded` | Bytes | Region, ShareId | dimension_change | `cloud.aws.storagegateway.CloudBytesDownloaded.By.GatewayId.GatewayName` | GatewayId, GatewayName | same CW metric, different dimensioning (classic=['Region', 'ShareId'] vs new=['GatewayId', 'GatewayName']) |
| `CloudBytesDownloaded` | Bytes | GatewayName, GatewayId | direct | `cloud.aws.storagegateway.CloudBytesDownloaded.By.GatewayId.GatewayName` | GatewayId, GatewayName |  |
| `CloudBytesUploaded` | Bytes | Region, ShareId | dimension_change | `cloud.aws.storagegateway.CloudBytesUploaded.By.GatewayId.GatewayName` | GatewayId, GatewayName | same CW metric, different dimensioning (classic=['Region', 'ShareId'] vs new=['GatewayId', 'GatewayName']) |
| `IndexFetches` | Count | Region, ShareId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `IndexFetches` | Count | GatewayName, GatewayId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `IoWaitPercent` | Percent | GatewayName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MemTotalBytes` | Bytes | GatewayName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `MemUsedBytes` | Bytes | GatewayName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `NfsSessions` | Count | GatewayName | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `QueuedWrites` | Bytes | Region, VolumeId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `QueuedWrites` | Bytes | GatewayName, GatewayId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ReadBytes` | Bytes | Region, VolumeId | dimension_change | `cloud.aws.storagegateway.ReadBytes.By.GatewayId.GatewayName` | GatewayId, GatewayName | same CW metric, different dimensioning (classic=['Region', 'VolumeId'] vs new=['GatewayId', 'GatewayName']) |
| `ReadBytes` | Bytes | GatewayName, GatewayId | direct | `cloud.aws.storagegateway.ReadBytes.By.GatewayId.GatewayName` | GatewayId, GatewayName |  |
| `ReadTime` | Milliseconds | Region, VolumeId | dimension_change | `cloud.aws.storagegateway.ReadTime.By.GatewayId.GatewayName` | GatewayId, GatewayName | same CW metric, different dimensioning (classic=['Region', 'VolumeId'] vs new=['GatewayId', 'GatewayName']) |
| `ReadTime` | Milliseconds | GatewayNam, GatewayIde | dimension_change | `cloud.aws.storagegateway.ReadTime.By.GatewayId.GatewayName` | GatewayId, GatewayName | same CW metric, different dimensioning (classic=['GatewayNam', 'GatewayIde'] vs new=['GatewayId', 'GatewayName']) |
| `TimeSinceLastRecoveryPoint` | Seconds | Region, VolumeId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `TotalCacheSize` | Bytes | GatewayName, GatewayId | direct | `cloud.aws.storagegateway.TotalCacheSize.By.GatewayId.GatewayName` | GatewayId, GatewayName |  |
| `UploadBufferFree` | Bytes | GatewayName, GatewayId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `UploadBufferPercentUsed` | Percent | GatewayName, GatewayId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `UploadBufferUsed` | Bytes | GatewayName, GatewayId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `WorkingStorageFree` | Bytes | GatewayName, GatewayId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `WorkingStoragePercentUsed` | Percent | GatewayName, GatewayId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `WorkingStorageUsed` | Bytes | GatewayName, GatewayId | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `WriteBytes` | Bytes | Region, VolumeId | dimension_change | `cloud.aws.storagegateway.WriteBytes.By.GatewayId.GatewayName` | GatewayId, GatewayName | same CW metric, different dimensioning (classic=['Region', 'VolumeId'] vs new=['GatewayId', 'GatewayName']) |
| `WriteBytes` | Bytes | GatewayName, GatewayId | direct | `cloud.aws.storagegateway.WriteBytes.By.GatewayId.GatewayName` | GatewayId, GatewayName |  |
| `WriteTime` | Milliseconds | Region, VolumeId | dimension_change | `cloud.aws.storagegateway.WriteTime.By.GatewayId.GatewayName` | GatewayId, GatewayName | same CW metric, different dimensioning (classic=['Region', 'VolumeId'] vs new=['GatewayId', 'GatewayName']) |
| `WriteTime` | Milliseconds | GatewayName, GatewayId | direct | `cloud.aws.storagegateway.WriteTime.By.GatewayId.GatewayName` | GatewayId, GatewayName |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (7)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `CloudBytesUploaded` | Bytes | GatewayName, GatewayId | direct | `cloud.aws.storagegateway.CloudBytesUploaded.By.GatewayId.GatewayName` | GatewayId, GatewayName |
| `CloudDownloadLatency` | Milliseconds | GatewayName, GatewayId | requires_custom_metric | _—_ | _—_ |
| `SmbV1Sessions` | Count | GatewayName | requires_custom_metric | _—_ | _—_ |
| `SmbV2Sessions` | Count | GatewayName | requires_custom_metric | _—_ | _—_ |
| `SmbV3Sessions` | Count | GatewayName | requires_custom_metric | _—_ | _—_ |
| `TimeSinceLastRecoveryPoint` | Seconds | GatewayName, GatewayId | requires_custom_metric | _—_ | _—_ |
| `UserCpuPercent` | Percent | GatewayName | requires_custom_metric | _—_ | _—_ |

</details>

### SystemsManagerRunCommand (`ssm_run_command`)

- Classic entity: `None` (dimension `None`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (3)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CommandsDeliveryTimedOut` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `CommandsFailed` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `CommandsSucceeded` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

### Textract (`textract`)

- Classic entity: `None` (dimension `None`)
- New block: `AWS::Cassandra::Keyspace` → Smartscape `AWS_CASSANDRA_KEYSPACE`
- Namespaces: `AWS/Cassandra`
- New recommended metrics: 2

**Raw CloudWatch metrics — Recommended (1)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ResponseTime` | Milliseconds | Region, Operation | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

<details><summary>Raw CloudWatch metrics — Non-recommended (4)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `ServerErrorCount` | Count | Region, Operation | requires_custom_metric | _—_ | _—_ |
| `SuccessfulRequestCount` | Count | Region, Operation | dimension_change | `cloud.aws.cassandra.SuccessfulRequestCount.By.Keyspace.Operation` | Keyspace, Operation |
| `ThrottledCount` | Count | Region, Operation | requires_custom_metric | _—_ | _—_ |
| `UserErrorCount` | Count | Region, Operation | requires_custom_metric | _—_ | _—_ |

</details>

### TransferFamily (`transfer_family`)

- Classic entity: `cloud:aws:transfer` (dimension `ServerId`)
- New block: `AWS::EC2::TransitGateway` → Smartscape `AWS_EC2_TRANSITGATEWAY`
- Namespaces: `AWS/TransitGateway`
- New recommended metrics: 9

**Raw CloudWatch metrics — Recommended (2)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `BytesIn` | Bytes | ServerId | dimension_change | `cloud.aws.transitgateway.BytesIn.By.TransitGateway` | TransitGateway | same CW metric, different dimensioning (classic=['ServerId'] vs new=['TransitGateway']) |
| `BytesOut` | Bytes | ServerId | dimension_change | `cloud.aws.transitgateway.BytesOut.By.TransitGateway` | TransitGateway | same CW metric, different dimensioning (classic=['ServerId'] vs new=['TransitGateway']) |

### TransitGateway (`transit_gateway`)

- Classic entity: `cloud:aws:transitgateway` (dimension `TransitGateway`)
- New block: `AWS::EC2::TransitGateway` → Smartscape `AWS_EC2_TRANSITGATEWAY`
- Namespaces: `AWS/TransitGateway`
- New recommended metrics: 9

**Raw CloudWatch metrics — Recommended (8)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `BytesDropCountBlackhole` | Count | TransitGateway | direct | `cloud.aws.transitgateway.BytesDropCountBlackhole.By.TransitGateway` | TransitGateway |  |
| `BytesDropCountNoRoute` | Count | TransitGateway | direct | `cloud.aws.transitgateway.BytesDropCountNoRoute.By.TransitGateway` | TransitGateway |  |
| `BytesIn` | Bytes | TransitGateway | direct | `cloud.aws.transitgateway.BytesIn.By.TransitGateway` | TransitGateway |  |
| `BytesOut` | Bytes | TransitGateway | direct | `cloud.aws.transitgateway.BytesOut.By.TransitGateway` | TransitGateway |  |
| `PacketDropCountBlackhole` | Count | TransitGateway | direct | `cloud.aws.transitgateway.PacketDropCountBlackhole.By.TransitGateway` | TransitGateway |  |
| `PacketDropCountNoRoute` | Count | TransitGateway | direct | `cloud.aws.transitgateway.PacketDropCountNoRoute.By.TransitGateway` | TransitGateway |  |
| `PacketsIn` | Count | TransitGateway | direct | `cloud.aws.transitgateway.PacketsIn.By.TransitGateway` | TransitGateway |  |
| `PacketsOut` | Count | TransitGateway | direct | `cloud.aws.transitgateway.PacketsOut.By.TransitGateway` | TransitGateway |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (18)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `BytesDropCountBlackhole` | Count | TransitGateway, TransitGatewayAttachment | direct | `cloud.aws.transitgateway.BytesDropCountBlackhole.By.TransitGateway` | TransitGateway |
| `BytesDropCountNoRoute` | Count | TransitGateway, TransitGatewayAttachment | direct | `cloud.aws.transitgateway.BytesDropCountNoRoute.By.TransitGateway` | TransitGateway |
| `BytesIn` | Bytes | TransitGateway, TransitGatewayAttachment | direct | `cloud.aws.transitgateway.BytesIn.By.TransitGateway` | TransitGateway |
| `BytesOut` | Bytes | TransitGateway, TransitGatewayAttachment | direct | `cloud.aws.transitgateway.BytesOut.By.TransitGateway` | TransitGateway |
| `IGMPJoins` | Count | TransitGateway, TransitGatewayAttachment | requires_custom_metric | _—_ | _—_ |
| `IGMPQueries` | Count | TransitGateway, TransitGatewayAttachment | requires_custom_metric | _—_ | _—_ |
| `IGMPReceives` | Count | TransitGateway, TransitGatewayAttachment | requires_custom_metric | _—_ | _—_ |
| `MulticastBytesIn` | Bytes | TransitGateway, TransitGatewayAttachment | requires_custom_metric | _—_ | _—_ |
| `MulticastBytesOut` | Bytes | TransitGateway, TransitGatewayAttachment | requires_custom_metric | _—_ | _—_ |
| `MulticastPacketDropCount` | Count | TransitGateway, TransitGatewayAttachment | requires_custom_metric | _—_ | _—_ |
| `MulticastPacketsIn` | Count | TransitGateway, TransitGatewayAttachment | requires_custom_metric | _—_ | _—_ |
| `MulticastPacketsOut` | Count | TransitGateway, TransitGatewayAttachment | requires_custom_metric | _—_ | _—_ |
| `NumberofMulticastDomains` | Count | TransitGateway | requires_custom_metric | _—_ | _—_ |
| `NumberofMulticastGroupMembers` | Count | TransitGateway | requires_custom_metric | _—_ | _—_ |
| `PacketDropCountBlackhole` | Count | TransitGateway, TransitGatewayAttachment | direct | `cloud.aws.transitgateway.PacketDropCountBlackhole.By.TransitGateway` | TransitGateway |
| `PacketDropCountNoRoute` | Count | TransitGateway, TransitGatewayAttachment | direct | `cloud.aws.transitgateway.PacketDropCountNoRoute.By.TransitGateway` | TransitGateway |
| `PacketsIn` | Count | TransitGateway, TransitGatewayAttachment | direct | `cloud.aws.transitgateway.PacketsIn.By.TransitGateway` | TransitGateway |
| `PacketsOut` | Count | TransitGateway, TransitGatewayAttachment | direct | `cloud.aws.transitgateway.PacketsOut.By.TransitGateway` | TransitGateway |

</details>

### Translate (`translate`)

- Classic entity: `None` (dimension `None`)
- New block: `AWS::Cassandra::Keyspace` → Smartscape `AWS_CASSANDRA_KEYSPACE`
- Namespaces: `AWS/Cassandra`
- New recommended metrics: 2

**Raw CloudWatch metrics — Recommended (6)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `CharacterCount` | Count | Region, LanguagePair, Operation | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ResponseTime` | Milliseconds | Region, LanguagePair, Operation | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `ServerErrorCount` | Count | Region, Operation | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `SuccessfulRequestCount` | Count | Region, Operation | dimension_change | `cloud.aws.cassandra.SuccessfulRequestCount.By.Keyspace.Operation` | Keyspace, Operation | same CW metric, different dimensioning (classic=['Region', 'Operation'] vs new=['Keyspace', 'Operation']) |
| `ThrottledCount` | Count | Region, Operation | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |
| `UserErrorCount` | Count | Region, Operation | requires_custom_metric | _—_ | _—_ | CW metric is real in AWS but the new integration does not include it in the recommended-metrics list for this resource — enable recommended+custom MCS and add it explicitly |

### TrustedAdvisor (`trusted_advisor`)

- Classic entity: `None` (dimension `None`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (5)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `RedChecks` | Count | Region, Category | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `RedResources` | Count | Region, CheckName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ServiceLimitUsage` | Percent | Region, ServiceLimit, ServiceName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `YellowChecks` | Count | Region, Category | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `YellowResources` | Count | Region, CheckName | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (1)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `GreenChecks` | Count | Region, Category | no_new_coverage | _—_ | _—_ |

</details>

### VPCNatGateway (`vpc_nat_gateway`)

- Classic entity: `cloud:aws:nat_gateway` (dimension `NatGatewayId`)
- New block: `AWS::EC2::NatGateway` → Smartscape `AWS_EC2_NATGATEWAY`
- Namespaces: `AWS/NATGateway`
- New recommended metrics: 14

**Raw CloudWatch metrics — Recommended (6)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `ActiveConnectionCount` | Count | NatGatewayId | direct | `cloud.aws.natgateway.ActiveConnectionCount.By.NatGatewayId` | NatGatewayId |  |
| `ConnectionAttemptCount` | Count | NatGatewayId | direct | `cloud.aws.natgateway.ConnectionAttemptCount.By.NatGatewayId` | NatGatewayId |  |
| `ConnectionEstablishedCount` | Count | NatGatewayId | direct | `cloud.aws.natgateway.ConnectionEstablishedCount.By.NatGatewayId` | NatGatewayId |  |
| `ErrorPortAllocation` | Count | NatGatewayId | direct | `cloud.aws.natgateway.ErrorPortAllocation.By.NatGatewayId` | NatGatewayId |  |
| `IdleTimeoutCount` | Count | NatGatewayId | direct | `cloud.aws.natgateway.IdleTimeoutCount.By.NatGatewayId` | NatGatewayId |  |
| `PacketsDropCount` | Count | NatGatewayId | direct | `cloud.aws.natgateway.PacketsDropCount.By.NatGatewayId` | NatGatewayId |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (8)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `BytesInFromDestination` | Bytes | NatGatewayId | direct | `cloud.aws.natgateway.BytesInFromDestination.By.NatGatewayId` | NatGatewayId |
| `BytesInFromSource` | Bytes | NatGatewayId | direct | `cloud.aws.natgateway.BytesInFromSource.By.NatGatewayId` | NatGatewayId |
| `BytesOutToDestination` | Bytes | NatGatewayId | direct | `cloud.aws.natgateway.BytesOutToDestination.By.NatGatewayId` | NatGatewayId |
| `BytesOutToSource` | Bytes | NatGatewayId | direct | `cloud.aws.natgateway.BytesOutToSource.By.NatGatewayId` | NatGatewayId |
| `PacketsInFromDestination` | Count | NatGatewayId | direct | `cloud.aws.natgateway.PacketsInFromDestination.By.NatGatewayId` | NatGatewayId |
| `PacketsInFromSource` | Count | NatGatewayId | direct | `cloud.aws.natgateway.PacketsInFromSource.By.NatGatewayId` | NatGatewayId |
| `PacketsOutToDestination` | Count | NatGatewayId | direct | `cloud.aws.natgateway.PacketsOutToDestination.By.NatGatewayId` | NatGatewayId |
| `PacketsOutToSource` | Count | NatGatewayId | direct | `cloud.aws.natgateway.PacketsOutToSource.By.NatGatewayId` | NatGatewayId |

</details>

### SiteToSiteVPN (`vpn`)

- Classic entity: `cloud:aws:vpn` (dimension `VpnId`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (6)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `TunnelDataIn` | Bytes | VpnId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `TunnelDataIn` | Bytes | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `TunnelDataOut` | Bytes | VpnId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `TunnelDataOut` | Bytes | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `TunnelState` | Count | Region | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `TunnelState` | Count | VpnId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (3)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `TunnelDataIn` | Bytes | Region, TunnelIpAddress | no_new_coverage | _—_ | _—_ |
| `TunnelDataOut` | Bytes | Region, TunnelIpAddress | no_new_coverage | _—_ | _—_ |
| `TunnelState` | Count | Region, TunnelIpAddress | no_new_coverage | _—_ | _—_ |

</details>

### WAFClassic (`waf_classic`)

- Classic entity: `None` (dimension `None`)
- New block: `AWS::WAFv2::WebACL` → Smartscape `AWS_WAFV2_WEBACL`
- Namespaces: `AWS/WAFV2`
- New recommended metrics: 9

**Raw CloudWatch metrics — Recommended (20)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `AllowedRequests` | Count | WebACL, Region, Rule | direct | `cloud.aws.wafv2.AllowedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL |  |
| `AllowedRequests` | Count | WebACL, Region, RuleGroup | dimension_change | `cloud.aws.wafv2.AllowedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | same CW metric, different dimensioning (classic=['WebACL', 'Region', 'RuleGroup'] vs new=['Region', 'Rule', 'WebACL']) |
| `AllowedRequests` | Count | Region, Rule, RuleGroup | dimension_change | `cloud.aws.wafv2.AllowedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | same CW metric, different dimensioning (classic=['Region', 'Rule', 'RuleGroup'] vs new=['Region', 'Rule', 'WebACL']) |
| `AllowedRequests` | Count | WebACL, Rule | direct | `cloud.aws.wafv2.AllowedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | dimension set differs slightly (classic=['WebACL', 'Rule'] vs new=['Region', 'Rule', 'WebACL']) |
| `AllowedRequests` | Count | WebACL, RuleGroup | dimension_change | `cloud.aws.wafv2.AllowedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | same CW metric, different dimensioning (classic=['WebACL', 'RuleGroup'] vs new=['Region', 'Rule', 'WebACL']) |
| `BlockedRequests` | Count | WebACL, Region, Rule | direct | `cloud.aws.wafv2.BlockedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL |  |
| `BlockedRequests` | Count | WebACL, Region, RuleGroup | dimension_change | `cloud.aws.wafv2.BlockedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | same CW metric, different dimensioning (classic=['WebACL', 'Region', 'RuleGroup'] vs new=['Region', 'Rule', 'WebACL']) |
| `BlockedRequests` | Count | Region, Rule, RuleGroup | dimension_change | `cloud.aws.wafv2.BlockedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | same CW metric, different dimensioning (classic=['Region', 'Rule', 'RuleGroup'] vs new=['Region', 'Rule', 'WebACL']) |
| `BlockedRequests` | Count | WebACL, Rule | direct | `cloud.aws.wafv2.BlockedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | dimension set differs slightly (classic=['WebACL', 'Rule'] vs new=['Region', 'Rule', 'WebACL']) |
| `BlockedRequests` | Count | WebACL, RuleGroup | dimension_change | `cloud.aws.wafv2.BlockedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | same CW metric, different dimensioning (classic=['WebACL', 'RuleGroup'] vs new=['Region', 'Rule', 'WebACL']) |
| `CountedRequests` | Count | WebACL, Region, Rule | direct | `cloud.aws.wafv2.CountedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL |  |
| `CountedRequests` | Count | WebACL, Region, RuleGroup | dimension_change | `cloud.aws.wafv2.CountedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | same CW metric, different dimensioning (classic=['WebACL', 'Region', 'RuleGroup'] vs new=['Region', 'Rule', 'WebACL']) |
| `CountedRequests` | Count | Region, Rule, RuleGroup | dimension_change | `cloud.aws.wafv2.CountedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | same CW metric, different dimensioning (classic=['Region', 'Rule', 'RuleGroup'] vs new=['Region', 'Rule', 'WebACL']) |
| `CountedRequests` | Count | WebACL, Rule | direct | `cloud.aws.wafv2.CountedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | dimension set differs slightly (classic=['WebACL', 'Rule'] vs new=['Region', 'Rule', 'WebACL']) |
| `CountedRequests` | Count | WebACL, RuleGroup | dimension_change | `cloud.aws.wafv2.CountedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | same CW metric, different dimensioning (classic=['WebACL', 'RuleGroup'] vs new=['Region', 'Rule', 'WebACL']) |
| `PassedRequests` | Count | WebACL, Region, Rule | direct | `cloud.aws.wafv2.PassedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL |  |
| `PassedRequests` | Count | WebACL, Region, RuleGroup | dimension_change | `cloud.aws.wafv2.PassedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | same CW metric, different dimensioning (classic=['WebACL', 'Region', 'RuleGroup'] vs new=['Region', 'Rule', 'WebACL']) |
| `PassedRequests` | Count | Region, Rule, RuleGroup | dimension_change | `cloud.aws.wafv2.PassedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | same CW metric, different dimensioning (classic=['Region', 'Rule', 'RuleGroup'] vs new=['Region', 'Rule', 'WebACL']) |
| `PassedRequests` | Count | WebACL, Rule | direct | `cloud.aws.wafv2.PassedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | dimension set differs slightly (classic=['WebACL', 'Rule'] vs new=['Region', 'Rule', 'WebACL']) |
| `PassedRequests` | Count | WebACL, RuleGroup | dimension_change | `cloud.aws.wafv2.PassedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL | same CW metric, different dimensioning (classic=['WebACL', 'RuleGroup'] vs new=['Region', 'Rule', 'WebACL']) |

### WAFv2 (`wafv2`)

- Classic entity: `None` (dimension `WebACL`)
- New block: `AWS::WAFv2::WebACL` → Smartscape `AWS_WAFV2_WEBACL`
- Namespaces: `AWS/WAFV2`
- New recommended metrics: 9

**Raw CloudWatch metrics — Recommended (2)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `AllowedRequests` | Count | WebACL, Region, Rule | direct | `cloud.aws.wafv2.AllowedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL |  |
| `BlockedRequests` | Count | WebACL, Region, Rule | direct | `cloud.aws.wafv2.BlockedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL |  |

<details><summary>Raw CloudWatch metrics — Non-recommended (1)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `CountedRequests` | Count | WebACL, Region, Rule | direct | `cloud.aws.wafv2.CountedRequests.By.Region.Rule.WebACL` | Region, Rule, WebACL |

</details>

### WorkMail (`workmail`)

- Classic entity: `cloud:aws:workmail` (dimension `OrganizationId`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (5)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `IncomingEmailBounced` | Count | OrganizationId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `MailboxEmailDelivered` | Count | OrganizationId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `OrganizationEmailReceived` | Count | OrganizationId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `OutgoingEmailBounced` | Count | OrganizationId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `OutgoingEmailSent` | Count | OrganizationId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

### WorkSpaces (`workspaces`)

- Classic entity: `cloud:aws:workspaces` (dimension `WorkspaceId`)
- **New block: no match** — new integration does not yet cover this service.

**Raw CloudWatch metrics — Recommended (21)**

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims | Notes |
|---|---|---|---|---|---|---|
| `Available` | Count | WorkspaceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Available` | Count | Region, DirectoryId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ConnectionAttempt` | Count | WorkspaceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ConnectionAttempt` | Count | Region, DirectoryId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ConnectionFailure` | Count | WorkspaceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ConnectionFailure` | Count | Region, DirectoryId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ConnectionSuccess` | Count | WorkspaceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `ConnectionSuccess` | Count | Region, DirectoryId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `InSessionLatency` | Milliseconds | WorkspaceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `InSessionLatency` | Milliseconds | Region, DirectoryId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Maintenance` | Count | WorkspaceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Maintenance` | Count | Region, DirectoryId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `SessionDisconnect` | Count | WorkspaceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `SessionDisconnect` | Count | Region, DirectoryId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `SessionLaunchTime` | Seconds | WorkspaceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `SessionLaunchTime` | Seconds | Region, DirectoryId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Stopped` | Count | WorkspaceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Stopped` | Count | Region, DirectoryId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Unhealthy` | Count | WorkspaceId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `Unhealthy` | Count | Region, DirectoryId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |
| `UserConnected` | Count | Region, DirectoryId | no_new_coverage | _—_ | _—_ | no new-integration support matrix block mapped to this classic service |

<details><summary>Raw CloudWatch metrics — Non-recommended (1)</summary>

| CloudWatch name | Unit | Classic dims | Category | New DT key | New dims |
|---|---|---|---|---|---|
| `UserConnected` | Count | WorkspaceId | no_new_coverage | _—_ | _—_ |

</details>

## New-integration-only Smartscape resource types

These support-matrix blocks have recommended metrics but **no classic service page mapped to them by CloudWatch-name overlap**. Some of these may well have classic pages — if so the mapping heuristic missed the link (e.g. because the classic page uses a different CloudWatch namespace for the same concept) and it's worth auditing.

| CloudFormation type | Smartscape node | Namespaces | Recommended metrics |
|---|---|---|---|
| `AWS::Athena::CapacityReservation` | `AWS_ATHENA_CAPACITYRESERVATION` | `AWS/Athena` | 3 |
| `AWS::Bedrock::AgentAlias` | `AWS_BEDROCK_AGENTALIAS` | `AWS/Bedrock/Agents` | 13 |
| `AWS::Cassandra::Stream` | `AWS_CASSANDRA_STREAM` | `AWS/Cassandra` | 8 |
| `AWS::Cassandra::Table` | `AWS_CASSANDRA_TABLE` | `AWS/Cassandra` | 18 |
| `AWS::EC2::VPCEndpoint` | `AWS_EC2_VPCENDPOINT` | `AWS/PrivateLinkEndpoints` | 10 |
| `AWS::EC2::VPCEndpointService` | `AWS_EC2_VPCENDPOINTSERVICE` | `AWS/PrivateLinkServices` | 25 |
| `AWS::ECR::Repository` | `AWS_ECR_REPOSITORY` | `AWS/ECR` | 1 |
| `AWS::EMRServerless::Application` | `AWS_EMRSERVERLESS_APPLICATION` | `AWS/EMRServerless` | 16 |
| `AWS::EMRServerless::JobRun` | `AWS_EMRSERVERLESS_JOBRUN` | `AWS/EMRServerless` | 8 |
| `AWS::Glue::Job` | `AWS_GLUE_JOB` | _none_ | 18 |
