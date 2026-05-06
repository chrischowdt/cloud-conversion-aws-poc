import {
  detectClassicMetricPatterns,
  detectClassicEntityPatterns,
  detectClassicEntitySelectorPatterns,
  extractClassicMetricKeys,
  CLASSIC_ENTITY_TYPES,
  CLASSIC_METRIC_PREFIXES,
} from './classicPatterns';

// ─── CLASSIC_ENTITY_TYPES ────────────────────────────────────────────────────

describe('CLASSIC_ENTITY_TYPES', () => {
  it('includes dynamo_db_table in AWS types', () => {
    expect(CLASSIC_ENTITY_TYPES.AWS).toContain('dynamo_db_table');
  });

  it('AWS list has 9 types (8 originally + dynamo_db_table)', () => {
    expect(CLASSIC_ENTITY_TYPES.AWS).toHaveLength(9);
  });

  it('Azure list has all 12 extended types', () => {
    const expected = [
      'azure_vm', 'azure_vm_scale_set', 'azure_load_balancer',
      'azure_event_hub_namespace', 'azure_event_hub', 'azure_redis_cache',
      'azure_function_app', 'azure_storage_account', 'azure_cosmos_db',
      'azure_web_app', 'azure_sql_server', 'azure_sql_database',
    ];
    for (const type of expected) {
      expect(CLASSIC_ENTITY_TYPES.Azure).toContain(type);
    }
    expect(CLASSIC_ENTITY_TYPES.Azure).toHaveLength(12);
  });

  it('GCP list contains custom_device', () => {
    expect(CLASSIC_ENTITY_TYPES.GCP).toContain('custom_device');
  });
});

// ─── CLASSIC_METRIC_PREFIXES ─────────────────────────────────────────────────

describe('CLASSIC_METRIC_PREFIXES', () => {
  it('AWS prefixes include dt.cloud.aws., builtin:cloud.aws., ext:cloud.aws., cloud.aws.', () => {
    expect(CLASSIC_METRIC_PREFIXES.AWS).toContain('dt.cloud.aws.');
    expect(CLASSIC_METRIC_PREFIXES.AWS).toContain('builtin:cloud.aws.');
    expect(CLASSIC_METRIC_PREFIXES.AWS).toContain('ext:cloud.aws.');
    expect(CLASSIC_METRIC_PREFIXES.AWS).toContain('cloud.aws.');
  });

  it('Azure prefixes include dt.cloud.azure. and cloud.azure.microsoft_', () => {
    expect(CLASSIC_METRIC_PREFIXES.Azure).toContain('dt.cloud.azure.');
    expect(CLASSIC_METRIC_PREFIXES.Azure).toContain('cloud.azure.microsoft_');
  });

  it('GCP prefixes include cloud.gcp. and builtin:cloud.gcp.', () => {
    expect(CLASSIC_METRIC_PREFIXES.GCP).toContain('cloud.gcp.');
    expect(CLASSIC_METRIC_PREFIXES.GCP).toContain('builtin:cloud.gcp.');
  });
});

// ─── detectClassicMetricPatterns — AWS ───────────────────────────────────────

describe('detectClassicMetricPatterns — AWS', () => {
  it('detects dt.cloud.aws. prefix', () => {
    const result = detectClassicMetricPatterns('fetch metric.series | filter startsWith(metric.key, "dt.cloud.aws.ec2")', 'AWS');
    expect(result).toContain('dt.cloud.aws.');
  });

  it('detects builtin:cloud.aws. prefix', () => {
    const result = detectClassicMetricPatterns('builtin:cloud.aws.ec2.cpu_usage', 'AWS');
    expect(result).toContain('builtin:cloud.aws.');
  });

  it('detects ext:cloud.aws. prefix', () => {
    const result = detectClassicMetricPatterns('ext:cloud.aws.elb.requests', 'AWS');
    expect(result).toContain('ext:cloud.aws.');
  });

  it('detects classic cloud.aws. non-builtin pattern (snake_case second token)', () => {
    const result = detectClassicMetricPatterns('cloud.aws.ec2.cpu_credit_usage', 'AWS');
    expect(result).toContain('cloud.aws.');
  });

  it('does NOT detect new-connection cloud.aws. pattern (PascalCase.By. second token)', () => {
    const result = detectClassicMetricPatterns('cloud.aws.EC2.CPUCreditUsage.By.InstanceType', 'AWS');
    expect(result).not.toContain('cloud.aws.');
  });

  it('returns empty array when no classic patterns present', () => {
    expect(detectClassicMetricPatterns('fetch dt.entity.host | fields entity.name', 'AWS')).toEqual([]);
  });

  it('returns deduplicated results', () => {
    const text = 'dt.cloud.aws.ec2 dt.cloud.aws.lambda';
    const result = detectClassicMetricPatterns(text, 'AWS');
    const dtCloudCount = result.filter((p) => p === 'dt.cloud.aws.').length;
    expect(dtCloudCount).toBe(1);
  });
});

// ─── detectClassicMetricPatterns — Azure ─────────────────────────────────────

describe('detectClassicMetricPatterns — Azure', () => {
  it('detects dt.cloud.azure. prefix', () => {
    const result = detectClassicMetricPatterns('dt.cloud.azure.sql.dtu_consumption', 'Azure');
    expect(result).toContain('dt.cloud.azure.');
  });

  it('detects cloud.azure.microsoft_ prefix', () => {
    const result = detectClassicMetricPatterns('cloud.azure.microsoft_compute.cpu', 'Azure');
    expect(result).toContain('cloud.azure.microsoft_');
  });

  it('detects dt.entity.azure_* in DQL text', () => {
    const result = detectClassicMetricPatterns('fetch dt.entity.azure_vm | fields entity.name', 'Azure');
    expect(result).toContain('dt.entity.azure_*');
  });

  it('returns empty array when no classic Azure patterns present', () => {
    expect(detectClassicMetricPatterns('fetch dt.entity.host', 'Azure')).toEqual([]);
  });
});

// ─── detectClassicMetricPatterns — GCP ───────────────────────────────────────

describe('detectClassicMetricPatterns — GCP', () => {
  it('detects classic cloud.gcp. pattern (second segment ends _googleapis_com)', () => {
    const result = detectClassicMetricPatterns('cloud.gcp.compute_googleapis_com.instance.cpu', 'GCP');
    expect(result).toContain('cloud.gcp.');
  });

  it('does NOT detect new-connection cloud.gcp. pattern (second segment is resource type)', () => {
    const result = detectClassicMetricPatterns('cloud.gcp.gce_instance.cpu.utilization', 'GCP');
    expect(result).not.toContain('cloud.gcp.');
  });

  it('detects builtin:cloud.gcp. prefix', () => {
    const result = detectClassicMetricPatterns('builtin:cloud.gcp.gke.cluster.cpu', 'GCP');
    expect(result).toContain('builtin:cloud.gcp.');
  });
});

// ─── detectClassicEntityPatterns — AWS ───────────────────────────────────────

describe('detectClassicEntityPatterns — AWS', () => {
  it('detects fetch dt.entity.ec2_instance', () => {
    const result = detectClassicEntityPatterns('fetch dt.entity.ec2_instance | filter ...', 'AWS');
    expect(result).toContain('dt.entity.ec2_instance');
  });

  it('detects fetch dt.entity.dynamo_db_table', () => {
    const result = detectClassicEntityPatterns('fetch dt.entity.dynamo_db_table', 'AWS');
    expect(result).toContain('dt.entity.dynamo_db_table');
  });

  it('detects fetch dt.entity.ebs_volume', () => {
    const result = detectClassicEntityPatterns('fetch dt.entity.ebs_volume', 'AWS');
    expect(result).toContain('dt.entity.ebs_volume');
  });

  it('is case-insensitive', () => {
    const result = detectClassicEntityPatterns('FETCH DT.ENTITY.EC2_INSTANCE', 'AWS');
    expect(result).toContain('dt.entity.ec2_instance');
  });

  it('does not match partial names (word boundary)', () => {
    // ec2_instance_extra should not match ec2_instance
    const result = detectClassicEntityPatterns('fetch dt.entity.ec2_instanceExtra', 'AWS');
    expect(result).not.toContain('dt.entity.ec2_instance');
  });

  it('returns empty array for non-AWS entity references', () => {
    expect(detectClassicEntityPatterns('fetch dt.entity.azure_vm', 'AWS')).toEqual([]);
  });

  it('returns deduplicated results for multiple matches of the same type', () => {
    const text = 'fetch dt.entity.ec2_instance | append [fetch dt.entity.ec2_instance]';
    const result = detectClassicEntityPatterns(text, 'AWS');
    const count = result.filter((p) => p === 'dt.entity.ec2_instance').length;
    expect(count).toBe(1);
  });
});

// ─── detectClassicEntityPatterns — Azure ─────────────────────────────────────

describe('detectClassicEntityPatterns — Azure', () => {
  it('detects fetch dt.entity.azure_vm', () => {
    const result = detectClassicEntityPatterns('fetch dt.entity.azure_vm', 'Azure');
    expect(result).toContain('dt.entity.azure_vm');
  });

  it('detects all 12 extended Azure entity types', () => {
    const types = [
      'azure_vm', 'azure_vm_scale_set', 'azure_load_balancer', 'azure_event_hub_namespace',
      'azure_event_hub', 'azure_redis_cache', 'azure_function_app', 'azure_storage_account',
      'azure_cosmos_db', 'azure_web_app', 'azure_sql_server', 'azure_sql_database',
    ];
    for (const t of types) {
      const result = detectClassicEntityPatterns(`fetch dt.entity.${t}`, 'Azure');
      expect(result).toContain(`dt.entity.${t}`);
    }
  });

  it('catches unknown azure_* types via wildcard', () => {
    const result = detectClassicEntityPatterns('fetch dt.entity.azure_unknown_service', 'Azure');
    expect(result).toContain('dt.entity.azure_*');
  });

  it('returns empty array for AWS entity references', () => {
    expect(detectClassicEntityPatterns('fetch dt.entity.ec2_instance', 'Azure')).toEqual([]);
  });
});

// ─── detectClassicEntityPatterns — GCP ───────────────────────────────────────

describe('detectClassicEntityPatterns — GCP', () => {
  it('detects fetch dt.entity.custom_device for GCP', () => {
    const result = detectClassicEntityPatterns('fetch dt.entity.custom_device | filter contains(toString(entity.type), "cloud:gcp")', 'GCP');
    expect(result).toContain('dt.entity.custom_device');
  });

  it('returns empty array for non-custom_device entities', () => {
    expect(detectClassicEntityPatterns('fetch dt.entity.ec2_instance', 'GCP')).toEqual([]);
  });
});

// ─── detectClassicEntitySelectorPatterns — AWS ───────────────────────────────

describe('detectClassicEntitySelectorPatterns — AWS', () => {
  it('detects type(EC2_INSTANCE) in entity selector', () => {
    const result = detectClassicEntitySelectorPatterns('type(EC2_INSTANCE)', 'AWS');
    expect(result).toContain('EC2_INSTANCE');
  });

  it('detects type(AWS_LAMBDA_FUNCTION)', () => {
    const result = detectClassicEntitySelectorPatterns('type(AWS_LAMBDA_FUNCTION),tag("env:prod")', 'AWS');
    expect(result).toContain('AWS_LAMBDA_FUNCTION');
  });

  it('is case-insensitive — detects type(ec2_instance)', () => {
    const result = detectClassicEntitySelectorPatterns('type(ec2_instance)', 'AWS');
    expect(result).toContain('EC2_INSTANCE');
  });

  it('returns empty array for empty string', () => {
    expect(detectClassicEntitySelectorPatterns('', 'AWS')).toEqual([]);
  });

  it('does not detect Azure types for AWS provider', () => {
    const result = detectClassicEntitySelectorPatterns('type(AZURE_VM)', 'AWS');
    expect(result).toEqual([]);
  });

  it('returns deduplicated results for multiple occurrences', () => {
    const text = 'type(EC2_INSTANCE),entityId("ABC"),type(EC2_INSTANCE)';
    const result = detectClassicEntitySelectorPatterns(text, 'AWS');
    expect(result.filter((t) => t === 'EC2_INSTANCE')).toHaveLength(1);
  });
});

// ─── detectClassicEntitySelectorPatterns — Azure ─────────────────────────────

describe('detectClassicEntitySelectorPatterns — Azure', () => {
  it('detects type(AZURE_VM)', () => {
    const result = detectClassicEntitySelectorPatterns('type(AZURE_VM)', 'Azure');
    expect(result).toContain('AZURE_VM');
  });

  it('detects type(AZURE_FUNCTION_APP)', () => {
    const result = detectClassicEntitySelectorPatterns('type(AZURE_FUNCTION_APP)', 'Azure');
    expect(result).toContain('AZURE_FUNCTION_APP');
  });
});

// ─── detectClassicEntitySelectorPatterns — GCP ───────────────────────────────

describe('detectClassicEntitySelectorPatterns — GCP', () => {
  it('detects type(CUSTOM_DEVICE) for GCP', () => {
    const result = detectClassicEntitySelectorPatterns('type(CUSTOM_DEVICE)', 'GCP');
    expect(result).toContain('CUSTOM_DEVICE');
  });

  it('returns empty array when no CUSTOM_DEVICE reference present', () => {
    expect(detectClassicEntitySelectorPatterns('type(EC2_INSTANCE)', 'GCP')).toEqual([]);
  });
});

// ─── extractClassicMetricKeys — duplicate key bug ─────────────────────────────

describe('extractClassicMetricKeys — no duplicate extraction (sub-prefix guard)', () => {
  it('ext:cloud.aws.X yields only one key, not also cloud.aws.X', () => {
    const keys = extractClassicMetricKeys('ext:cloud.aws.dax.cpuUtilization', 'AWS');
    // Should contain the full prefixed key
    expect(keys).toContain('ext:cloud.aws.dax.cpuUtilization');
    // Must NOT also contain the bare cloud.aws. sub-match
    expect(keys).not.toContain('cloud.aws.dax.cpuUtilization');
    expect(keys).toHaveLength(1);
  });

  it('builtin:cloud.aws.X yields only one key', () => {
    const keys = extractClassicMetricKeys('builtin:cloud.aws.ec2.cpu_usage', 'AWS');
    expect(keys).toContain('builtin:cloud.aws.ec2.cpu_usage');
    expect(keys).not.toContain('cloud.aws.ec2.cpu_usage');
    expect(keys).toHaveLength(1);
  });

  it('ext:cloud.azure.X yields only one key', () => {
    const keys = extractClassicMetricKeys('ext:cloud.azure.microsoft_compute.vm.cpu', 'Azure');
    expect(keys).toContain('ext:cloud.azure.microsoft_compute.vm.cpu');
    expect(keys).not.toContain('cloud.azure.microsoft_');
    expect(keys).toHaveLength(1);
  });

  it('standalone cloud.aws.X (no prefix) is still extracted', () => {
    const keys = extractClassicMetricKeys('cloud.aws.ec2.cpu_usage', 'AWS');
    expect(keys).toContain('cloud.aws.ec2.cpu_usage');
    expect(keys).toHaveLength(1);
  });

  it('expression with multiple prefixed keys deduplicates correctly', () => {
    const expr = 'ext:cloud.aws.dax.cpuUtilization:avg + ext:cloud.aws.ec2.cpu';
    const keys = extractClassicMetricKeys(expr, 'AWS');
    expect(keys).toContain('ext:cloud.aws.dax.cpuUtilization');
    expect(keys).toContain('ext:cloud.aws.ec2.cpu');
    // No bare cloud.aws. sub-matches
    expect(keys.filter((k) => !k.startsWith('ext:'))).toHaveLength(0);
  });
});
