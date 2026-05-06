# New AWS Connection in Dynatrace (Smartscape on Grail)

> **Scope**: This document covers the **new** AWS cloud platform monitoring integration only.
> It does **NOT** cover the classic (legacy) AWS monitoring integration — see [aws-classic.md](aws-classic.md) for that.

## Overview

The new AWS connection is Dynatrace's next-generation AWS monitoring integration, built on the Grail data lakehouse. It replaces the classic ActiveGate-based architecture with a cloud-native data acquisition (DA) pipeline that runs entirely within the Dynatrace platform. It introduces **Smartscape on Grail** — a purpose-built entity model where each AWS resource type gets its own dedicated entity type (prefixed `AWS_`), with rich topology and relationships.

---

## 1. Architecture

### 1.1 Data Acquisition Components

| Component | `dt.da.source` Value | Purpose |
|---|---|---|
| **Metric Poller** | `aws-metric-poller` | Polls CloudWatch `ListMetrics` and `GetMetricData` APIs on 5-minute intervals with 7-minute delay |
| **Smartscape Poller (Full)** | `aws-smartscape-poller-full` | Full discovery of AWS resource topology via AWS APIs |
| **Smartscape Poller (Lightweight)** | `aws-smartscape-poller-lightweight` | Lightweight topology refresh |
| **Smartscape Poller (Resource Changes)** | `aws-smartscape-poller-resource-changes` | Incremental topology updates triggered by resource change events |
| **Log Ingest** | `aws-log-ingest` | Ingests CloudWatch logs from AWS |

> Unlike the classic connection, which requires an ActiveGate for polling, the new connection runs entirely inside the Dynatrace platform as a managed data acquisition service.

### 1.2 Authentication & Connection Configuration

| Property | Value |
|---|---|
| **Settings Schema** | `builtin:hyperscaler-authentication.connections.aws` |
| **Auth Methods** | IAM Cross-account Role-based (`awsRoleBasedAuthentication`) or AWS Web Identity (`awsWebIdentity`) |
| **Connection Properties** | `name` (text), `type` (enum), auth config (roleArn + consumers list) |

#### Consumers

Each connection specifies which Dynatrace integrations consume it. The consumer determines what the connection is used for:

| Consumer | Display Name | Purpose |
|---|---|---|
| `SVC:com.dynatrace.da` | Data Acquisition | Metric polling + Smartscape topology discovery |
| `APP:dynatrace.biz.carbon` | Cost & Carbon Optimization | FinOps / carbon tracking |
| `SVC:com.dynatrace.bo` | Business Observability | Business analytics |
| `SVC:com.dynatrace.openpipeline` | OpenPipeline | Log/event pipeline ingest |
| `SVC:com.dynatrace.grail` | Grail | Direct Grail data ingest |
| `APP:dynatrace.aws.connector` | AWS Connector | (Web Identity auth only) |
| `NONE` | None | Connection exists but has no active consumer |

> **Key insight**: Only connections with `SVC:com.dynatrace.da` as a consumer perform metric and Smartscape polling. A connection configured for FinOps or OpenPipeline only does **not** generate metrics or create Smartscape entities. Multiple connections can exist for the same AWS account with different consumers.

#### Querying Connections

Configured connections can always be queried via the Settings V2 API (`builtin:hyperscaler-authentication.connections.aws`), regardless of whether they are actively ingesting data. This is the most reliable way to detect new AWS connections — see [Section 8.5](#85-detect-active-new-connections-via-settings-api) and [Section 10](#10-migration-relevance).

### 1.3 Metric Polling Schedule

The new connection uses the same 5-minute polling interval as the classic connection:

- Polling runs every **5 minutes**, evaluating a 5-minute window
- **7-minute delay** to account for CloudWatch eventual consistency
- Example: A job starting at 9:00 AM evaluates data points for 8:48–8:53 AM

### 1.4 Streaming (Push-based) — Coming Soon

Amazon CloudWatch Metric Streams is planned as a secondary ingest method for the new connection. This will enable near-real-time push-based ingestion for latency-sensitive use cases.

---

## 2. Smartscape on Grail Entity Model

### 2.1 Entity Types

The new connection creates **Smartscape on Grail** entities. Each AWS resource type has a dedicated entity type. The naming convention is `AWS_<SERVICE>_<RESOURCETYPE>`.

| Smartscape Entity Type | AWS CloudFormation Type | AWS Service |
|---|---|---|
| `AWS_ACCOUNT` | *(infrastructure)* | AWS Account (topology container) |
| `AWS_REGION` | *(infrastructure)* | AWS Region (topology container) |
| `AWS_LAMBDA_FUNCTION` | `AWS::Lambda::Function` | Lambda |
| `AWS_LOGS_LOGGROUP` | `AWS::Logs::LogGroup` | CloudWatch Logs |
| `AWS_EC2_VOLUME` | `AWS::EC2::Volume` | EBS |
| `AWS_EC2_INSTANCE` | `AWS::EC2::Instance` | EC2 |
| `AWS_RDS_DBINSTANCE` | `AWS::RDS::DBInstance` | RDS |
| `AWS_AUTOSCALING_AUTOSCALINGGROUP` | `AWS::AutoScaling::AutoScalingGroup` | Auto Scaling |
| `AWS_ELASTICACHE_CACHECLUSTER` | `AWS::ElastiCache::CacheCluster` | ElastiCache |
| `AWS_RDS_DBCLUSTER` | `AWS::RDS::DBCluster` | RDS Aurora |
| `AWS_ECR_REPOSITORY` | `AWS::ECR::Repository` | ECR |
| `AWS_S3_BUCKET` | `AWS::S3::Bucket` | S3 |
| `AWS_ELASTICLOADBALANCINGV2_LOADBALANCER` | `AWS::ElasticLoadBalancingV2::LoadBalancer` | NLB / ALB |
| `AWS_ROUTE53_HEALTHCHECK` | `AWS::Route53::HealthCheck` | Route 53 |
| `AWS_EKS_CLUSTER` | `AWS::EKS::Cluster` | EKS |
| `AWS_KINESISFIREHOSE_DELIVERYSTREAM` | `AWS::KinesisFirehose::DeliveryStream` | Kinesis Firehose |
| `AWS_DYNAMODB_TABLE` | `AWS::DynamoDB::Table` | DynamoDB |
| `AWS_EC2_NATGATEWAY` | `AWS::EC2::NatGateway` | VPC NAT Gateway |
| `AWS_CLOUDFRONT_DISTRIBUTION` | `AWS::CloudFront::Distribution` | CloudFront |
| `AWS_SNS_TOPIC` | `AWS::SNS::Topic` | SNS |

> **Entity ID Format**: `<ENTITY_TYPE>-<HEX_ID>`, e.g., `AWS_EC2_INSTANCE-727B36DA1E9C8E2A`, `AWS_LAMBDA_FUNCTION-6BFC8E54C76A807D`.

> **Note**: Smartscape on Grail entity types can only be queried with `smartscapeNodes <Entity_Type>` command and MUST NOT be confused with querying classic entities (via `fetch dt.entity.<type>` DQL queries). The new AWS connection only creates Smartscape nodes and edges and never uses classic entities.

> **Warning — Entity Name Collision**: Some classic built-in entity types share **identical names** with Smartscape on Grail entity types. Most notably, `AWS_LAMBDA_FUNCTION` exists in **both** systems — as a classic entity (queryable via `fetch dt.entity.aws_lambda_function`) and as a Smartscape on Grail node (queryable via `smartscapeNodes AWS_LAMBDA_FUNCTION`). The same applies to `AWS_APPLICATION_LOAD_BALANCER`, `AWS_NETWORK_LOAD_BALANCER`, `AWS_CREDENTIALS`, and `AWS_AVAILABILITY_ZONE`. These are **completely separate entity systems** despite the identical type names. Classic entities live in Cassandra and are queried with `fetch dt.entity.<type>`; Smartscape on Grail entities live in Grail and are queried with `smartscapeNodes <EntityType>`. When both classic and new connections coexist, entities from both systems will be present for the same AWS resources.

### 2.2 Full Documented Entity Types (Support Matrix)

The Dynatrace support matrix documents the following AWS resource types (CloudFormation types). Each maps to a Smartscape on Grail entity type:

**Compute**: `AWS::EC2::Instance`, `AWS::Lambda::Function`, `AWS::ECS::Cluster`, `AWS::ECS::Service`, `AWS::ECS::Task`, `AWS::EKS::Cluster`, `AWS::EKS::Nodegroup`, `AWS::AppRunner::Service`, `AWS::ElasticBeanstalk::Environment`

**Storage**: `AWS::S3::Bucket`, `AWS::EFS::FileSystem`, `AWS::EC2::Volume`, `AWS::FSx::FileSystem`, `AWS::Backup::BackupVault`

**Database**: `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`, `AWS::DynamoDB::Table`, `AWS::ElastiCache::CacheCluster`, `AWS::Neptune::DBCluster`, `AWS::Neptune::DBInstance`, `AWS::DocDB::DBCluster`, `AWS::DocDB::DBInstance`, `AWS::Redshift::Cluster`, `AWS::DAX::Cluster`, `AWS::Cassandra::Table`, `AWS::QLDB::Ledger` (if applicable)

**Networking**: `AWS::EC2::VPC`, `AWS::EC2::Subnet`, `AWS::EC2::NatGateway`, `AWS::EC2::TransitGateway`, `AWS::EC2::VPNConnection`, `AWS::EC2::VPCEndpoint`, `AWS::ElasticLoadBalancingV2::LoadBalancer`, `AWS::ElasticLoadBalancing::LoadBalancer`, `AWS::CloudFront::Distribution`, `AWS::Route53::HealthCheck`, `AWS::Route53::HostedZone`, `AWS::DirectConnect::DXCon`, `AWS::GlobalAccelerator::Accelerator`

**Application Integration**: `AWS::SNS::Topic`, `AWS::SQS::Queue`, `AWS::Events::EventBus`, `AWS::StepFunctions::StateMachine`

**Analytics & Streaming**: `AWS::Kinesis::Stream`, `AWS::KinesisFirehose::DeliveryStream`, `AWS::MSK::Cluster`, `AWS::OpenSearch::Domain`, `AWS::Athena::WorkGroup`, `AWS::Glue::Job`, `AWS::EMR::Cluster`, `AWS::Redshift::Cluster`

**AI/ML**: `AWS::Bedrock::Agent`, `AWS::Bedrock::Guardrail`, `AWS::Bedrock::KnowledgeBase`, `AWS::SageMaker::Endpoint`

**Management & Monitoring**: `AWS::Logs::LogGroup`, `AWS::CloudTrail::Trail`, `AWS::ECR::Repository`, `AWS::CodeBuild::Project`

**Security & Identity**: `AWS::IAM::Role`, `AWS::IAM::User`, `AWS::KMS::Key`, `AWS::WAFv2::WebACL`, `AWS::NetworkFirewall::Firewall`, `AWS::CloudHSM::Cluster`

### 2.3 Topology & Relationships

The support matrix defines relationships between AWS resource types. Examples:

| Source | Relationship | Target |
|---|---|---|
| `AWS::EC2::Instance` | `uses` | `AWS::EC2::SecurityGroup` |
| `AWS::EC2::Instance` | `is_attached_to` | `AWS::EC2::Subnet` |
| `AWS::ECS::Task` | `belongs_to` | `AWS::ECS::Cluster` |
| `AWS::ECS::Task` | `runs_on` | `AWS::ECS::ContainerInstance` |
| `AWS::RDS::DBInstance` | `is_part_of` | `AWS::RDS::DBCluster` |
| `AWS::Lambda::Function` | `uses` | `AWS::IAM::Role` |
| `AWS::S3::Bucket` | `uses` | `AWS::KMS::Key` |
| `AWS::EKS::Nodegroup` | `belongs_to` | `AWS::EKS::Cluster` |

Relationship types: `uses`, `is_attached_to`, `belongs_to`, `is_part_of`, `runs_on`, `routes_to`, `contains`, `balances`, `balanced_by`, `calls`

### 2.4 Resource Discovery via AWS APIs

Dynatrace discovers resources by calling AWS APIs for each resource type. The support matrix documents the exact API calls:

| Resource Type | API | Operation |
|---|---|---|
| `AWS::EC2::Instance` | `ec2` | `DescribeInstances` |
| `AWS::Lambda::Function` | `lambda` | `ListFunctions` + `GetFunction` |
| `AWS::RDS::DBInstance` | `rds` | `DescribeDbInstances` |
| `AWS::S3::Bucket` | `s3` | `ListBuckets` |
| `AWS::ECS::Cluster` | `ecs` | `ListClusters` + `DescribeClusters` |
| `AWS::EKS::Cluster` | `eks` | `ListClusters` + `DescribeCluster` |

---

## 3. Metric Key Format

### 3.1 Pattern

All new connection metrics follow a single, consistent format:

```
cloud.aws.<service>.<MetricName>.By.<Dim1>.<Dim2>...
```

- `<service>` — lowercase CloudWatch namespace fragment (e.g., `ec2`, `lambda`, `rds`, `ebs`, `elasticache`)
- `<MetricName>` — CloudWatch metric name in PascalCase (e.g., `CPUUtilization`, `Invocations`)
- `By` — literal separator
- `<Dim1>.<Dim2>` — CloudWatch dimension names in PascalCase, dot-separated, alphabetically ordered

Examples:
- `cloud.aws.ec2.CPUUtilization.By.InstanceId`
- `cloud.aws.lambda.Invocations.By.FunctionName`
- `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier`
- `cloud.aws.ebs.VolumeAvgReadLatency.By.InstanceId.VolumeId`
- `cloud.aws.elasticache.CPUUtilization.By.CacheClusterId.CacheNodeId`

### 3.2 Shared Pattern with Classic Non-Built-in Polling

> **Important**: The `cloud.aws.<service>.<MetricName>.By.<Dim>` pattern is **identical** to what the classic non-built-in polling produces. See [Section 5](#5-disambiguating-new-vs-classic-connection) for how to tell them apart.

### 3.3 Metric Collection Sets (MCS)

The new connection supports three types of Metric Collection Sets:

| MCS Type | API Name | Description |
|---|---|---|
| **Recommended** | `essential` | Immutable, opinionated Dynatrace metric set per service. Optimal starting point. |
| **Recommended + Custom** | — | Recommended metrics plus user-defined additional metrics. |
| **Auto-Discovery** | — | All key metrics for a service auto-discovered. Pre-set, immutable dimensions. High DPS risk. |

Only one MCS can be assigned to a service at a time.

### 3.4 Default Recommended Services

When onboarding via Quick Start, these services are enabled by default:

API Gateway, Auto Scaling, CloudFront, DynamoDB, EBS, EC2, ECR, ECS, EFS, ELB (Classic), ELB v2 (ALB/NLB), Lambda, NAT Gateway, PrivateLink Endpoints, PrivateLink Services, RDS, Route 53, S3, SNS, SQS

---

## 4. Metric Dimensions and Enrichment

### 4.1 Enrichment Dimensions

Every metric from the new connection carries these platform-enriched dimensions:

| Dimension | Description | Example |
|---|---|---|
| `dt.da.source` | Data acquisition source identifier | `aws-metric-poller` |
| `dt.smartscape_source.type` | Smartscape entity type | `AWS_EC2_INSTANCE` |
| `dt.smartscape_source.id` | Smartscape entity ID | `AWS_EC2_INSTANCE-727B36DA1E9C8E2A` |
| `aws.account.id` | AWS account ID | `497414168292` |
| `aws.region` | AWS region | `us-east-1` |

### 4.2 CloudWatch Dimension Passthrough

CloudWatch dimensions from the metric are passed through as top-level dimensions on the metric series. These dimensions also appear in the metric key name after `By.`:

| Metric Key | Passthrough Dimension | Example Value |
|---|---|---|
| `cloud.aws.lambda.Invocations.By.FunctionName` | `FunctionName` | `my-lambda-fn` |
| `cloud.aws.ec2.CPUUtilization.By.InstanceId` | `InstanceId` | `i-0abc123def456` |
| `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier` | `DBInstanceIdentifier` | `my-db-instance` |
| `cloud.aws.ebs.VolumeAvgReadLatency.By.InstanceId.VolumeId` | `InstanceId`, `VolumeId` | `i-0abc...`, `vol-0def...` |

### 4.3 AWS Tag Enrichment

Metrics are enriched with AWS tags as `aws.tag.<TagKey>` dimensions. Up to 20 user-provided tags can be used for enrichment. Tag-based filtering supports up to 5 include and 5 exclude rules.

> **Note**: Tag enrichment availability may depend on connection configuration and specific tag import settings.

### 4.4 Dimensions NOT Present (vs Classic)

| Dimension | Present in Classic | Present in New |
|---|---|---|
| `dt.source_entity` | Yes (entity ID) | **No** |
| `dt.source_entity.type` | Yes (e.g., `ec2_instance`, `cloud:aws:rds`) | **No** |
| `dt.entity.cloud:aws:account` | Yes (classic custom device entity ID) | **No** — new connection uses `dt.smartscape_source.type == "AWS_ACCOUNT"` instead |
| `dt.source` | Yes (`"AWS Metric Streams"` for streams) | **No** |

> **Note on parallel ingestion**: If both classic and new connections monitor the same AWS account simultaneously, metrics from `cloud.aws.*` keys may carry dimensions from **both** connections (e.g., both `dt.da.source` and `dt.entity.cloud:aws:account` on the same series). This mixed-dimension state is an artifact of parallel ingestion, not a feature of the new connection. By default, no aggregated account-level metrics are ingested by either connection.

---

## 5. Disambiguating New vs Classic Connection

The same `cloud.aws.<service>.<MetricName>.By.<Dim>` metric key can come from either the new connection or the classic non-built-in polling. These rules distinguish them:

| Rule | Connection Type |
|---|---|
| `dt.da.source == "aws-metric-poller"` | **New** connection |
| `dt.smartscape_source.type` is present (e.g., `AWS_EC2_INSTANCE`) | **New** connection |
| `dt.smartscape_source.id` is present (e.g., `AWS_EC2_INSTANCE-...`) | **New** connection |
| `dt.source_entity.type` starts with `cloud:aws:` | **Classic** non-built-in |
| `dt.entity.cloud:aws:account` dimension is present | **Classic** connection |
| `dt.source_entity.type` is a built-in type (e.g., `ec2_instance`) | **Classic** built-in |
| `dt.source == "AWS Metric Streams"` | **Classic** Metric Streams |
| Metric key starts with `dt.cloud.aws.` | **Classic** built-in (exclusive) |

> **Warning — Parallel Ingestion**: When both connections monitor the same AWS account, the same `cloud.aws.*` metric can be ingested twice — once by each connection. This results in **double cost** and **duplicate data points**. In this scenario, metrics will carry a mix of dimensions from both connections (e.g., both `dt.da.source` from the new connection and `dt.entity.cloud:aws:account` from the classic connection on the same series). Running both connections in parallel is not recommended and should be flagged as a migration issue.

---

## 6. Complete Metric Inventory

### 6.1 By Entity Type

#### AWS_LAMBDA_FUNCTION (5 metrics)
- `cloud.aws.lambda.ConcurrentExecutions.By.FunctionName`
- `cloud.aws.lambda.Duration.By.FunctionName`
- `cloud.aws.lambda.Errors.By.FunctionName`
- `cloud.aws.lambda.Invocations.By.FunctionName`
- `cloud.aws.lambda.Throttles.By.FunctionName`

#### AWS_EC2_INSTANCE (15 metrics)
- `cloud.aws.ec2.CPUCreditBalance.By.InstanceId`
- `cloud.aws.ec2.CPUCreditUsage.By.InstanceId`
- `cloud.aws.ec2.CPUUtilization.By.InstanceId`
- `cloud.aws.ec2.DiskReadBytes.By.InstanceId`
- `cloud.aws.ec2.DiskReadOps.By.InstanceId`
- `cloud.aws.ec2.DiskWriteBytes.By.InstanceId`
- `cloud.aws.ec2.DiskWriteOps.By.InstanceId`
- `cloud.aws.ec2.EBSIOBalance_percentage.By.InstanceId`
- `cloud.aws.ec2.EBSReadBytes.By.InstanceId`
- `cloud.aws.ec2.EBSReadOps.By.InstanceId`
- `cloud.aws.ec2.EBSWriteBytes.By.InstanceId`
- `cloud.aws.ec2.EBSWriteOps.By.InstanceId`
- `cloud.aws.ec2.NetworkIn.By.InstanceId`
- `cloud.aws.ec2.NetworkOut.By.InstanceId`
- `cloud.aws.ec2.StatusCheckFailed.By.InstanceId`

#### AWS_EC2_VOLUME (11 metrics)
- `cloud.aws.ebs.BurstBalance.By.VolumeId`
- `cloud.aws.ebs.VolumeAvgReadLatency.By.InstanceId.VolumeId`
- `cloud.aws.ebs.VolumeAvgWriteLatency.By.InstanceId.VolumeId`
- `cloud.aws.ebs.VolumeIdleTime.By.VolumeId`
- `cloud.aws.ebs.VolumeQueueLength.By.VolumeId`
- `cloud.aws.ebs.VolumeReadBytes.By.VolumeId`
- `cloud.aws.ebs.VolumeReadOps.By.VolumeId`
- `cloud.aws.ebs.VolumeTotalReadTime.By.VolumeId`
- `cloud.aws.ebs.VolumeTotalWriteTime.By.VolumeId`
- `cloud.aws.ebs.VolumeWriteBytes.By.VolumeId`
- `cloud.aws.ebs.VolumeWriteOps.By.VolumeId`

#### AWS_RDS_DBINSTANCE (12 metrics)
- `cloud.aws.rds.CPUUtilization.By.DBInstanceIdentifier`
- `cloud.aws.rds.DatabaseConnections.By.DBInstanceIdentifier`
- `cloud.aws.rds.FreeableMemory.By.DBInstanceIdentifier`
- `cloud.aws.rds.FreeStorageSpace.By.DBInstanceIdentifier`
- `cloud.aws.rds.NetworkReceiveThroughput.By.DBInstanceIdentifier`
- `cloud.aws.rds.NetworkTransmitThroughput.By.DBInstanceIdentifier`
- `cloud.aws.rds.ReadIOPS.By.DBInstanceIdentifier`
- `cloud.aws.rds.ReadLatency.By.DBInstanceIdentifier`
- `cloud.aws.rds.ReadThroughput.By.DBInstanceIdentifier`
- `cloud.aws.rds.SwapUsage.By.DBInstanceIdentifier`
- `cloud.aws.rds.WriteIOPS.By.DBInstanceIdentifier`
- `cloud.aws.rds.WriteLatency.By.DBInstanceIdentifier`
- `cloud.aws.rds.WriteThroughput.By.DBInstanceIdentifier`

#### AWS_RDS_DBCLUSTER (3 metrics)
- `cloud.aws.rds.VolumeBytesUsed.By.DBClusterIdentifier`
- `cloud.aws.rds.VolumeReadIOPs.By.DBClusterIdentifier`
- `cloud.aws.rds.VolumeWriteIOPs.By.DBClusterIdentifier`

#### AWS_AUTOSCALING_AUTOSCALINGGROUP (7 metrics)
- `cloud.aws.autoscaling.GroupDesiredCapacity.By.AutoScalingGroupName`
- `cloud.aws.autoscaling.GroupInServiceInstances.By.AutoScalingGroupName`
- `cloud.aws.autoscaling.GroupMaxSize.By.AutoScalingGroupName`
- `cloud.aws.autoscaling.GroupMinSize.By.AutoScalingGroupName`
- `cloud.aws.autoscaling.GroupPendingInstances.By.AutoScalingGroupName`
- `cloud.aws.autoscaling.GroupStandbyInstances.By.AutoScalingGroupName`
- `cloud.aws.autoscaling.GroupTerminatingInstances.By.AutoScalingGroupName`

#### AWS_ELASTICACHE_CACHECLUSTER (24 metrics)
- `cloud.aws.elasticache.CacheHitRate.By.CacheClusterId`
- `cloud.aws.elasticache.CacheHitRate.By.CacheClusterId.CacheNodeId`
- `cloud.aws.elasticache.CacheHits.By.CacheClusterId`
- `cloud.aws.elasticache.CacheHits.By.CacheClusterId.CacheNodeId`
- `cloud.aws.elasticache.CacheMisses.By.CacheClusterId`
- `cloud.aws.elasticache.CacheMisses.By.CacheClusterId.CacheNodeId`
- `cloud.aws.elasticache.CPUUtilization.By.CacheClusterId`
- `cloud.aws.elasticache.CPUUtilization.By.CacheClusterId.CacheNodeId`
- `cloud.aws.elasticache.CurrConnections.By.CacheClusterId`
- `cloud.aws.elasticache.CurrConnections.By.CacheClusterId.CacheNodeId`
- `cloud.aws.elasticache.DatabaseMemoryUsagePercentage.By.CacheClusterId`
- `cloud.aws.elasticache.DatabaseMemoryUsagePercentage.By.CacheClusterId.CacheNodeId`
- `cloud.aws.elasticache.EngineCPUUtilization.By.CacheClusterId`
- `cloud.aws.elasticache.EngineCPUUtilization.By.CacheClusterId.CacheNodeId`
- `cloud.aws.elasticache.Evictions.By.CacheClusterId`
- `cloud.aws.elasticache.Evictions.By.CacheClusterId.CacheNodeId`
- `cloud.aws.elasticache.FreeableMemory.By.CacheClusterId`
- `cloud.aws.elasticache.FreeableMemory.By.CacheClusterId.CacheNodeId`
- `cloud.aws.elasticache.NetworkBytesIn.By.CacheClusterId`
- `cloud.aws.elasticache.NetworkBytesIn.By.CacheClusterId.CacheNodeId`
- `cloud.aws.elasticache.NetworkBytesOut.By.CacheClusterId`
- `cloud.aws.elasticache.NetworkBytesOut.By.CacheClusterId.CacheNodeId`
- `cloud.aws.elasticache.SwapUsage.By.CacheClusterId`
- `cloud.aws.elasticache.SwapUsage.By.CacheClusterId.CacheNodeId`

#### AWS_ELASTICLOADBALANCINGV2_LOADBALANCER (11 metrics)
- `cloud.aws.networkelb.ActiveFlowCount_TCP.By.LoadBalancer`
- `cloud.aws.networkelb.ActiveFlowCount_TLS.By.LoadBalancer`
- `cloud.aws.networkelb.ClientTLSNegotiationErrorCount.By.LoadBalancer`
- `cloud.aws.networkelb.HealthyHostCount.By.LoadBalancer.TargetGroup`
- `cloud.aws.networkelb.PortAllocationErrorCount.By.LoadBalancer`
- `cloud.aws.networkelb.RejectedFlowCount.By.LoadBalancer`
- `cloud.aws.networkelb.TargetTLSNegotiationErrorCount.By.LoadBalancer`
- `cloud.aws.networkelb.TCP_Client_Reset_Count.By.LoadBalancer`
- `cloud.aws.networkelb.TCP_ELB_Reset_Count.By.LoadBalancer`
- `cloud.aws.networkelb.TCP_Target_Reset_Count.By.LoadBalancer`
- `cloud.aws.networkelb.UnHealthyHostCount.By.LoadBalancer.TargetGroup`

#### AWS_S3_BUCKET (13 metrics)
- `cloud.aws.s3.4xxErrors.By.BucketName.FilterId`
- `cloud.aws.s3.5xxErrors.By.BucketName.FilterId`
- `cloud.aws.s3.AllRequests.By.BucketName.FilterId`
- `cloud.aws.s3.BytesDownloaded.By.BucketName.FilterId`
- `cloud.aws.s3.BytesUploaded.By.BucketName.FilterId`
- `cloud.aws.s3.DeleteRequests.By.BucketName.FilterId`
- `cloud.aws.s3.FirstByteLatency.By.BucketName.FilterId`
- `cloud.aws.s3.GetRequests.By.BucketName.FilterId`
- `cloud.aws.s3.HeadRequests.By.BucketName.FilterId`
- `cloud.aws.s3.ListRequests.By.BucketName.FilterId`
- `cloud.aws.s3.PostRequests.By.BucketName.FilterId`
- `cloud.aws.s3.PutRequests.By.BucketName.FilterId`
- `cloud.aws.s3.TotalRequestLatency.By.BucketName.FilterId`

#### AWS_EKS_CLUSTER (8 metrics)
- `cloud.aws.eks.apiserver_admission_webhook_request_total.By.ClusterName`
- `cloud.aws.eks.apiserver_request_total.By.ClusterName`
- `cloud.aws.eks.apiserver_request_total_4XX.By.ClusterName`
- `cloud.aws.eks.apiserver_request_total_5XX.By.ClusterName`
- `cloud.aws.eks.apiserver_storage_size_bytes.By.ClusterName`
- `cloud.aws.eks.scheduler_pending_pods.By.ClusterName`
- `cloud.aws.eks.scheduler_schedule_attempts_ERROR.By.ClusterName`
- `cloud.aws.eks.scheduler_schedule_attempts_total.By.ClusterName`

#### AWS_LOGS_LOGGROUP (3 metrics)
- `cloud.aws.logs.ForwardedBytes.By.DestinationType.FilterName.LogGroupName`
- `cloud.aws.logs.IncomingBytes.By.LogGroupName`
- `cloud.aws.logs.IncomingLogEvents.By.LogGroupName`

#### AWS_KINESISFIREHOSE_DELIVERYSTREAM (6 metrics)
- `cloud.aws.firehose.DeliveryToHttpEndpoint.DataFreshness.By.DeliveryStreamName`
- `cloud.aws.firehose.DeliveryToHttpEndpoint.Records.By.DeliveryStreamName`
- `cloud.aws.firehose.DeliveryToHttpEndpoint.Success.By.DeliveryStreamName`
- `cloud.aws.firehose.IncomingBytes.By.DeliveryStreamName`
- `cloud.aws.firehose.IncomingRecords.By.DeliveryStreamName`
- `cloud.aws.firehose.ThrottledRecords.By.DeliveryStreamName`

#### AWS_DYNAMODB_TABLE (5 metrics)
- `cloud.aws.dynamodb.ConsumedReadCapacityUnits.By.TableName`
- `cloud.aws.dynamodb.ConsumedWriteCapacityUnits.By.TableName`
- `cloud.aws.dynamodb.ProvisionedReadCapacityUnits.By.TableName`
- `cloud.aws.dynamodb.ProvisionedWriteCapacityUnits.By.TableName`
- `cloud.aws.dynamodb.SuccessfulRequestLatency.By.Operation.TableName`

#### AWS_EC2_NATGATEWAY (14 metrics)
- `cloud.aws.natgateway.ActiveConnectionCount.By.NatGatewayId`
- `cloud.aws.natgateway.BytesInFromDestination.By.NatGatewayId`
- `cloud.aws.natgateway.BytesInFromSource.By.NatGatewayId`
- `cloud.aws.natgateway.BytesOutToDestination.By.NatGatewayId`
- `cloud.aws.natgateway.BytesOutToSource.By.NatGatewayId`
- `cloud.aws.natgateway.ConnectionAttemptCount.By.NatGatewayId`
- `cloud.aws.natgateway.ConnectionEstablishedCount.By.NatGatewayId`
- `cloud.aws.natgateway.ErrorPortAllocation.By.NatGatewayId`
- `cloud.aws.natgateway.IdleTimeoutCount.By.NatGatewayId`
- `cloud.aws.natgateway.PacketsDropCount.By.NatGatewayId`
- `cloud.aws.natgateway.PacketsInFromDestination.By.NatGatewayId`
- `cloud.aws.natgateway.PacketsInFromSource.By.NatGatewayId`
- `cloud.aws.natgateway.PacketsOutToDestination.By.NatGatewayId`
- `cloud.aws.natgateway.PacketsOutToSource.By.NatGatewayId`

#### AWS_CLOUDFRONT_DISTRIBUTION (6 metrics)
- `cloud.aws.cloudfront.4xxErrorRate.By.DistributionId.Region`
- `cloud.aws.cloudfront.5xxErrorRate.By.DistributionId.Region`
- `cloud.aws.cloudfront.BytesDownloaded.By.DistributionId.Region`
- `cloud.aws.cloudfront.BytesUploaded.By.DistributionId.Region`
- `cloud.aws.cloudfront.Requests.By.DistributionId.Region`
- `cloud.aws.cloudfront.TotalErrorRate.By.DistributionId.Region`

#### AWS_ECR_REPOSITORY (1 metric)
- `cloud.aws.ecr.RepositoryPullCount.By.RepositoryName`

#### AWS_ROUTE53_HEALTHCHECK (2 metrics)
- `cloud.aws.route53.HealthCheckPercentageHealthy.By.HealthCheckId`
- `cloud.aws.route53.HealthCheckStatus.By.HealthCheckId`

#### AWS_SNS_TOPIC (5 metrics)
- `cloud.aws.sns.NumberOfMessagesPublished.By.TopicName`
- `cloud.aws.sns.NumberOfNotificationsDelivered.By.TopicName`
- `cloud.aws.sns.NumberOfNotificationsFailed.By.TopicName`
- `cloud.aws.sns.NumberOfNotificationsFilteredOut.By.TopicName`
- `cloud.aws.sns.PublishSize.By.TopicName`

### 6.2 Internal / Self-Monitoring Metrics

The new connection also emits internal self-monitoring metrics:

| Metric Key | `dt.da.source` | Description |
|---|---|---|
| `dac.enrichment_processor.number_of_processed_metric_data_points` | `aws-metric-poller` | Number of metric data points processed |
| `dac.enrichment_processor.api.dac_metric_polling_time.timer` | `aws-metric-poller` | Time spent polling CloudWatch metrics |
| `dac.enrichment_processor.api.dac_metric_ingestion_latency.timer` | `aws-metric-poller` | Metric ingestion latency |
| `dac.enrichment_processor.number_of_processed_smartscape_entries` | `aws-smartscape-poller-full` | Smartscape entries processed |
| `dac.enrichment_processor.api.dac_smartscape_polling_time.timer` | `aws-smartscape-poller-full` | Smartscape polling time |
| `dac.enrichment_processor.number_of_processed_log_records` | `aws-log-ingest` | Log records processed |
| `dt.sfm.da.aws.metric.data_points.count` | `aws-metric-poller` | SFM: metric data point count |
| `dt.sfm.da.aws.smartscape.updates.count` | `aws-smartscape-poller-full` | SFM: smartscape update count |
| `dt.sfm.da.aws.log.records.count` | `aws-log-ingest` | SFM: log records count |

---

## 7. Advanced Metric Ingest

### 7.1 Any AWS Metric

The new connection supports ingesting CloudWatch metrics from **any** AWS service — even those not yet in the Dynatrace native service list. Enable "Ingest any AWS metrics" in connection settings and provide namespace and metric names.

Limitations: These metrics do **not** follow the signals-in-context principle — they are not linked to entities, not visible in topology, and not enriched with AWS tags. They can be used in custom dashboards, DQL queries, and custom alerts.

### 7.2 Custom (User-Instrumented) Metrics

CloudWatch custom metrics published via AWS SDKs can also be ingested. Enable "Ingest custom (user-instrumented) metrics" in connection settings.

Same limitations as "Any AWS metric" — no entity linking, no topology, no tag enrichment.

---

## 8. DQL Query Patterns

### 8.1 List All New Connection Metrics

```dql
fetch metric.series
| fields metric.key, dt.da.source, dt.smartscape_source.type
| filter dt.da.source == "aws-metric-poller"
| summarize cnt=count(), by:{metric.key, dt.smartscape_source.type}
| sort dt.smartscape_source.type asc, cnt desc
```

### 8.2 List All AWS Smartscape Entity Types

Smartscape on Grail entities **must** be queried with `smartscapeNodes`, not `fetch metric.series` or `fetch dt.entity.*`:

```dql
smartscapeNodes "*"
| filter startsWith(type, "AWS_")
| summarize cnt = count(), by: { type }
| sort cnt desc
```

> **Note**: This returns ALL Smartscape entity types — including infrastructure types like `AWS_EC2_NETWORKINTERFACE`, `AWS_IAM_ROLE`, `AWS_KMS_KEY`, etc. — far more than the subset with Cloud Monitoring metrics. In the gmg environment, 71 distinct `AWS_*` entity types exist, while only ~20 have metrics linked via `dt.smartscape_source.type`.

### 8.2a Query a Specific AWS Entity Type

```dql
smartscapeNodes AWS_EC2_INSTANCE
| fields id, name, type, aws.account.id, aws.region
| limit 10
```

### 8.2b Count Entities Per Type (Metrics-Linked Only)

To count only entity types that have metrics linked (via `dt.smartscape_source.type` on metric series):

```dql
fetch metric.series
| fieldsKeep dt.da.source, dt.smartscape_source.type, dt.smartscape_source.id
| filter dt.da.source == "aws-metric-poller"
  AND isNotNull(dt.smartscape_source.type)
  AND dt.smartscape_source.type != "CONTAINER"
| summarize entity_count = countDistinct(dt.smartscape_source.id), by:{dt.smartscape_source.type}
| sort entity_count desc
```

### 8.3 Find All Data Acquisition Sources

```dql
fetch metric.series
| fieldsKeep dt.da.source
| filter isNotNull(dt.da.source) AND contains(dt.da.source, "aws")
| summarize cnt=count(), by:{dt.da.source}
| sort cnt desc
```

### 8.4 Detect Parallel Classic + New Ingestion

```dql
// Metrics that have BOTH classic and new connection dimensions
fetch metric.series
| fields metric.key, dt.da.source, dt.source_entity.type, dt.smartscape_source.type
| filter startsWith(metric.key, "cloud.aws.")
| summarize
    has_new = countIf(dt.da.source == "aws-metric-poller") > 0,
    has_classic = countIf(isNotNull(dt.source_entity.type)) > 0,
    by:{metric.key}
| filter has_new AND has_classic
```

### 8.5 Detect Active New Connections via Settings API

The most reliable way to detect new AWS connections is to query the Settings V2 API. This works even when metric ingest is disabled or the connection is unhealthy:

```
// Settings V2 API (not DQL — use Dynatrace API or dtctl)
dtctl get settings --schema builtin:hyperscaler-authentication.connections.aws
```

Each settings object returns:
- `value.name` — connection name
- `value.type` — auth method (`awsRoleBasedAuthentication` or `awsWebIdentity`)
- `value.awsRoleBasedAuthentication.roleArn` — IAM role ARN (includes the AWS account ID)
- `value.awsRoleBasedAuthentication.consumers` — list of consumers using the connection

Only connections with `SVC:com.dynatrace.da` as a consumer perform metric and Smartscape polling. Other consumers (`SVC:com.dynatrace.bo`, `SVC:com.dynatrace.openpipeline`, `APP:dynatrace.biz.carbon`) use the connection for other purposes.

### 8.6 Detect Active Connections via Smartscape Entities

Even when metric polling is disabled, connections configured with the Data Acquisition consumer run Smartscape pollers that create topology. Query Smartscape directly:

```dql
// Find all AWS accounts with Smartscape entities (works even when metric polling is disabled)
smartscapeNodes "*"
| filter startsWith(type, "AWS_") AND type != "AWS_ACCOUNT" AND type != "AWS_REGION" AND type != "AWS_AVAILABILITY_ZONE"
| summarize
    entityTypes = collectDistinct(type),
    regions = collectDistinct(aws.region),
    entityCount = count(),
    by: { aws.account.id }
| sort entityCount desc
```

```dql
// Find all AWS accounts via metric data (only works when metric polling is enabled)
fetch metric.series
| filter dt.da.source == "aws-metric-poller"
| fieldsAdd aws.account.id, aws.region
| summarize
    entityTypes = collectDistinct(dt.smartscape_source.type),
    regions = collectDistinct(aws.region),
    seriesCount = count(),
    by:{aws.account.id}
| sort seriesCount desc
```

```dql
// Self-monitoring: Check Smartscape poller activity (runs independently of metric poller)
fetch metric.series
| filter contains(dt.da.source, "aws-smartscape-poller")
| summarize cnt=count(), by:{metric.key, dt.da.source}
| sort dt.da.source asc
```

> **Important**: Metric-based detection only works when metric ingest is enabled. Metric ingest is configurable per new AWS connection and customers can turn it off entirely. For a complete picture, always combine with Settings API queries (Section 8.5) and direct Smartscape topology queries.

### 8.7 Self-Monitoring Overview

```dql
fetch metric.series
| fieldsKeep metric.key, dt.da.source
| filter contains(dt.da.source, "aws") AND (startsWith(metric.key, "dac.") OR startsWith(metric.key, "dt.sfm.da.aws."))
| summarize cnt=count(), by:{metric.key, dt.da.source}
| sort dt.da.source asc
```

---

## 9. Key Differences: New vs Classic

| Aspect | New Connection | Classic Built-in | Classic Non-Built-in |
|---|---|---|---|
| **Architecture** | Cloud-native DA service | ActiveGate polling | ActiveGate polling |
| **Entity model** | Smartscape on Grail (`AWS_*`) | Dedicated types (`EC2_INSTANCE`) | `CUSTOM_DEVICE` (`cloud:aws:*`) |
| **Entity ID format** | `AWS_EC2_INSTANCE-<hex>` | `EC2_INSTANCE-<hex>` | `CUSTOM_DEVICE-<hex>` |
| **Metric key prefix** | `cloud.aws.*` | `dt.cloud.aws.*` | `cloud.aws.*` |
| **Metric key naming** | PascalCase, `By.` separator | Short, Dynatrace-curated | PascalCase or snake_case |
| **`dt.da.source`** | `aws-metric-poller` | (null) | (null) |
| **`dt.smartscape_source.type`** | `AWS_EC2_INSTANCE`, etc. | (null) | (null) |
| **`dt.source_entity.type`** | (null) | Built-in type name | `cloud:aws:<service>` |
| **AWS tags** | `aws.tag.<Key>` (up to 20) | Imported to entity | Imported to entity |
| **Topology** | Full (relationships, hierarchy) | Full (built-in) | Custom device groups |
| **Signals-in-context** | Yes (metrics linked to entities) | Yes | Limited |
| **Settings Schema** | `builtin:hyperscaler-authentication.connections.aws` | Legacy Config API | Legacy Config API |
| **Connection Detection** | Settings API + metrics + Smartscape | Config API only | Config API only |
| **Metric ingest** | Configurable (can be disabled) | Always on | Always on |
| **ActiveGate** | Not required | Not required (only for large envs) | Required |
| **Polling interval** | 5 min | 5 min | 5 min |

---

## 10. Migration Relevance

When assisting with cloud migration from classic to new connections, the app needs to:

1. **Detect active new connections** — use a multi-layered detection strategy (metric ingest is configurable and can be disabled entirely):
   - **Settings API** (primary, always reliable): Query `builtin:hyperscaler-authentication.connections.aws` settings objects to find all configured connections, regardless of health or metric ingest status. Each object reveals the connection name, auth method, IAM role ARN (which embeds the AWS account ID), and which consumers are enabled. Only connections with `SVC:com.dynatrace.da` as a consumer do metric/Smartscape polling.
   - **Smartscape topology** (secondary): Query metric series for `aws.account.id` dimensions and `dt.smartscape_source.id` to discover which AWS accounts have active Smartscape on Grail entities. Also check Smartscape poller self-monitoring metrics (`dt.da.source` containing `aws-smartscape-poller`) to confirm topology discovery is running.
   - **Metric series** (supplementary): Query for `dt.da.source == "aws-metric-poller"` and enumerate `dt.smartscape_source.type` values. This confirms active metric ingestion but will miss connections where metric polling is disabled.
   - **Absence of data** (edge case): If the Settings API shows a configured connection with `SVC:com.dynatrace.da` but no metrics or Smartscape entities are found, the connection may be unhealthy, misconfigured, or the IAM role may be invalid. This should be flagged as a migration concern.
2. **Map classic entities to new entities** — e.g., `EC2_INSTANCE` (classic built-in) → `AWS_EC2_INSTANCE` (new), `CUSTOM_DEVICE` with `cloud:aws:rds` (classic non-built-in) → `AWS_RDS_DBINSTANCE` (new)
3. **Detect parallel ingestion** — when both classic and new connections are active for the same account, flag the overlap and quantify duplicate metric series
4. **Map metric keys** — classic built-in metrics (`dt.cloud.aws.*`) have **no** direct equivalent in the new connection; the new connection uses `cloud.aws.*` keys exclusively
5. **Handle entity type differences** — classic `CUSTOM_DEVICE` entities with `cloud:aws:*` sub-types need to be mapped to the corresponding `AWS_*` Smartscape entity types
6. **Account for coverage gaps** — the new connection may not yet support all services that the classic connection monitors. Compare active services in both connections.
7. **Verify tag enrichment** — classic tags are imported to entities; new connection tags are enriched as `aws.tag.*` metric dimensions. Migration must preserve tag-based dashboards and alerts.
8. **Flag log ingest configuration (future scope)** — the new connection includes an `aws-log-ingest` DA component (`dt.da.source == "aws-log-ingest"`) and supports `SVC:com.dynatrace.openpipeline` as a connection consumer. Log migration from classic Firehose-based ingest to the new connection's native log ingest is a per-connection task, not per-service. Out of scope for the initial implementation.

---

## References

- [Integrated AWS cloud services (Support Matrix)](https://docs.dynatrace.com/docs/ingest-from/amazon-web-services/aws-support-matrix-file)
- [CloudWatch metrics](https://docs.dynatrace.com/docs/ingest-from/amazon-web-services/ingest-telemetry/aws-cloudwatch-metrics)
- [Semantic Dictionary — AWS entities](https://docs.dynatrace.com/docs/semantic-dictionary/model/smartscape/aws) (requires authentication)
