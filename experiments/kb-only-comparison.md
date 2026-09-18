# Knowledgebase-only conversion experiment

## EQY-Metrics

- tiles compared: **74**
- queries the KB conversion changed: **52**
- KB output identical to the hand-done final: **15**
- differed: **59** (of which: only the hand process converted **7**, only the KB touched **0**)
- KB left untouched: 22 · hand-done left untouched: 15

**Rules the KB fired:** R4×161, R5×99, R7×11, R9×1

**No KB rule available:** selector-predicate×51, unmapped-metric×11, metric-streams×1

### tile `tiles/2`
```
CLASSIC : timeseries cpu_utilization_by_service_name = avg(cloud.aws.ecs.cpu_utilization_by_service_name, filter: { contains(ServiceName, "eqy") }), by: { ServiceName } | sort arrayAvg(cpu_utilization_by_service_name) desc | limit
KB-ONLY : timeseries cpu_utilization_by_service_name = avg(cloud.aws.ecs.cpu_utilization_by_service_name, filter: { contains(ServiceName, "eqy") }), by: { ServiceName } | sort arrayAvg(cpu_utilization_by_service_name) desc | limit
HAND    : timeseries cpu_utilization_by_service_name = avg(`cloud.aws.ecs.CPUUtilization.By.ClusterName.ServiceName`, filter: { contains(ServiceName, "eqy") }), by: { ServiceName } | sort arrayAvg(cpu_utilization_by_service_name) 
```

### tile `tiles/3`
```
CLASSIC : timeseries memory_utilization_by_service_name = avg(cloud.aws.ecs.memory_utilization_by_service_name, filter: { contains(ServiceName, "eqy") }), by: { ServiceName } | sort arrayAvg(memory_utilization_by_service_name) des
KB-ONLY : timeseries memory_utilization_by_service_name = avg(cloud.aws.ecs.memory_utilization_by_service_name, filter: { contains(ServiceName, "eqy") }), by: { ServiceName } | sort arrayAvg(memory_utilization_by_service_name) des
HAND    : timeseries memory_utilization_by_service_name = avg(`cloud.aws.ecs.MemoryUtilization.By.ClusterName.ServiceName`, filter: { contains(ServiceName, "eqy") }), by: { ServiceName } | sort arrayAvg(memory_utilization_by_servi
```

### tile `tiles/4`
```
CLASSIC : timeseries cpu_utilization_by_service_name = avg(cloud.aws.ecs.cpu_utilization_by_service_name, filter: { (ServiceName == "eqy-ChatStreamHandler") OR (ServiceName == "eqy-FlinkSignalPublisher") OR (ServiceName == "eqy-Mi
KB-ONLY : timeseries cpu_utilization_by_service_name = avg(cloud.aws.ecs.cpu_utilization_by_service_name, filter: { (ServiceName == "eqy-ChatStreamHandler") OR (ServiceName == "eqy-FlinkSignalPublisher") OR (ServiceName == "eqy-Mi
HAND    : timeseries cpu_utilization_by_service_name = avg(`cloud.aws.ecs.CPUUtilization.By.ClusterName.ServiceName`, filter: { (ServiceName == "eqy-ChatStreamHandler") OR (ServiceName == "eqy-FlinkSignalPublisher") OR (ServiceNam
```

### tile `tiles/6`
```
CLASSIC : timeseries response_time = avg(dt.service.request.response_time, filter: { ( in(dt.entity.service, classicEntitySelector("type(service),entityName.contains(\" United.Mobile.Services.LiveActivity.Api\")"))) AND ( in(dt.en
KB-ONLY : timeseries response_time = avg(dt.service.request.response_time, filter: { ( in(dt.smartscape.service, classicEntitySelector("type(service),entityName.contains(\" United.Mobile.Services.LiveActivity.Api\")"))) AND ( `tag
HAND    : timeseries response_time = avg(dt.service.request.response_time, filter: { ( getNodeField(dt.smartscape.service, "name") ~ " United.Mobile.Services.LiveActivity.Api") AND ( getNodeField(dt.smartscape.service, "tags:aws")
```

### tile `tiles/7`
```
CLASSIC : timeseries failure_count = sum(dt.service.request.failure_count, filter: { ( in(dt.entity.service, classicEntitySelector("type(service),entityName.contains(\" United.Mobile.Services.LiveActivity.Api\")"))) AND ( in(dt.en
KB-ONLY : timeseries failure_count = sum(dt.service.request.failure_count, filter: { ( in(dt.smartscape.service, classicEntitySelector("type(service),entityName.contains(\" United.Mobile.Services.LiveActivity.Api\")"))) AND ( `tag
HAND    : timeseries failure_count = sum(dt.service.request.failure_count, filter: { ( getNodeField(dt.smartscape.service, "name") ~ " United.Mobile.Services.LiveActivity.Api") AND ( getNodeField(dt.smartscape.service, "tags:aws")
```

### tile `tiles/8`
```
CLASSIC : timeseries count = sum(dt.service.request.count, filter: { ( in(dt.entity.service, classicEntitySelector("type(service),entityName.contains(\" United.Mobile.Services.LiveActivity.Api\")"))) AND ( in(dt.entity.service, cl
KB-ONLY : timeseries count = sum(dt.service.request.count, filter: { ( in(dt.smartscape.service, classicEntitySelector("type(service),entityName.contains(\" United.Mobile.Services.LiveActivity.Api\")"))) AND ( `tags`[applicationci
HAND    : timeseries count = sum(dt.service.request.count, filter: { ( getNodeField(dt.smartscape.service, "name") ~ " United.Mobile.Services.LiveActivity.Api") AND ( getNodeField(dt.smartscape.service, "tags:aws")[applicationci] 
```

## AAP : JET : Dynamo DB Metrics

- tiles compared: **27**
- queries the KB conversion changed: **27**
- KB output identical to the hand-done final: **0**
- differed: **27** (of which: only the hand process converted **0**, only the KB touched **0**)
- KB left untouched: 0 · hand-done left untouched: 0

**Rules the KB fired:** R4×204, R1×54, R7×33, R2×27, R-rel×27

**No KB rule available:** unmapped-entity×54, unmapped-metric×33, relationship×27

### tile `tiles/0`
```
CLASSIC : timeseries avg(cloud.aws.dynamodb.successful_request_latency_by_operation), by:{dt.entity.custom_device} | lookup [fetch dt.entity.custom_device | fieldsAdd dt.entity.aws_credentials = accessible_by[dt.entity.aws_credent
KB-ONLY : timeseries avg(cloud.aws.dynamodb.successful_request_latency_by_operation), by:{dt.smartscape.custom_device} | lookup [fetch dt.entity.custom_device | fieldsAdd dt.smartscape.aws_credentials = accessible_by[dt.smartscape
HAND    : timeseries avg(`cloud.aws.dynamodb.SuccessfulRequestLatency.By.Operation.TableName`), by:{dt.smartscape.aws_dynamodb_table} | lookup [smartscapeNodes AWS_DYNAMODB_TABLE | fields name, id, aws.account.id], sourceField:dt.
```

### tile `tiles/1`
```
CLASSIC : timeseries avg(cloud.aws.dynamodb.successful_request_latency_by_operation), by:{dt.entity.custom_device} | lookup [fetch dt.entity.custom_device | fieldsAdd dt.entity.aws_credentials = accessible_by[dt.entity.aws_credent
KB-ONLY : timeseries avg(cloud.aws.dynamodb.successful_request_latency_by_operation), by:{dt.smartscape.custom_device} | lookup [fetch dt.entity.custom_device | fieldsAdd dt.smartscape.aws_credentials = accessible_by[dt.smartscape
HAND    : timeseries avg(`cloud.aws.dynamodb.SuccessfulRequestLatency.By.Operation.TableName`), by:{dt.smartscape.aws_dynamodb_table} | lookup [smartscapeNodes AWS_DYNAMODB_TABLE | fields name, id, aws.account.id], sourceField:dt.
```

### tile `tiles/2`
```
CLASSIC : timeseries avg(cloud.aws.dynamodb.successful_request_latency_by_operation), by:{dt.entity.custom_device} | lookup [fetch dt.entity.custom_device | fieldsAdd dt.entity.aws_credentials = accessible_by[dt.entity.aws_credent
KB-ONLY : timeseries avg(cloud.aws.dynamodb.successful_request_latency_by_operation), by:{dt.smartscape.custom_device} | lookup [fetch dt.entity.custom_device | fieldsAdd dt.smartscape.aws_credentials = accessible_by[dt.smartscape
HAND    : timeseries avg(`cloud.aws.dynamodb.SuccessfulRequestLatency.By.Operation.TableName`), by:{dt.smartscape.aws_dynamodb_table} | lookup [smartscapeNodes AWS_DYNAMODB_TABLE | fields name, id, aws.account.id], sourceField:dt.
```

### tile `tiles/6`
```
CLASSIC : timeseries throttled = sum(cloud.aws.dynamodb.throttled_requests_sum_by_operation, default:0), by:{dt.entity.custom_device} | lookup [fetch dt.entity.custom_device | fieldsAdd dt.entity.aws_credentials = accessible_by[dt
KB-ONLY : timeseries throttled = sum(cloud.aws.dynamodb.throttled_requests_sum_by_operation, default:0), by:{dt.smartscape.custom_device} | lookup [fetch dt.entity.custom_device | fieldsAdd dt.smartscape.aws_credentials = accessib
HAND    : timeseries throttled = sum(`cloud.aws.dynamodb.ThrottledRequests.By.Operation.TableName`, default:0), by:{dt.smartscape.aws_dynamodb_table} | lookup [smartscapeNodes AWS_DYNAMODB_TABLE | fields name, id, aws.account.id],
```

### tile `tiles/7`
```
CLASSIC : timeseries throttled = sum(cloud.aws.dynamodb.throttled_requests_sum_by_operation, default:0), by:{dt.entity.custom_device} | lookup [fetch dt.entity.custom_device | fieldsAdd dt.entity.aws_credentials = accessible_by[dt
KB-ONLY : timeseries throttled = sum(cloud.aws.dynamodb.throttled_requests_sum_by_operation, default:0), by:{dt.smartscape.custom_device} | lookup [fetch dt.entity.custom_device | fieldsAdd dt.smartscape.aws_credentials = accessib
HAND    : timeseries throttled = sum(`cloud.aws.dynamodb.ThrottledRequests.By.Operation.TableName`, default:0), by:{dt.smartscape.aws_dynamodb_table} | lookup [smartscapeNodes AWS_DYNAMODB_TABLE | fields name, id, aws.account.id],
```

### tile `tiles/8`
```
CLASSIC : timeseries throttled = sum(cloud.aws.dynamodb.throttled_requests_sum_by_operation, default:0), by:{dt.entity.custom_device} | lookup [fetch dt.entity.custom_device | fieldsAdd dt.entity.aws_credentials = accessible_by[dt
KB-ONLY : timeseries throttled = sum(cloud.aws.dynamodb.throttled_requests_sum_by_operation, default:0), by:{dt.smartscape.custom_device} | lookup [fetch dt.entity.custom_device | fieldsAdd dt.smartscape.aws_credentials = accessib
HAND    : timeseries throttled = sum(`cloud.aws.dynamodb.ThrottledRequests.By.Operation.TableName`, default:0), by:{dt.smartscape.aws_dynamodb_table} | lookup [smartscapeNodes AWS_DYNAMODB_TABLE | fields name, id, aws.account.id],
```
