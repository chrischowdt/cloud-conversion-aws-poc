import {
  lookupMetricKey,
  isMigratable,
  isServiceSupported,
  hasEndOfLifeMetrics,
  getEndOfLifeInfo,
} from './metricKeyMapping';

// ─── lookupMetricKey — GCP ────────────────────────────────────────────────────

describe('lookupMetricKey — GCP', () => {
  it('always returns found: false for GCP regardless of key', () => {
    const result = lookupMetricKey('builtin:cloud.aws.ec2.cpu', 'GCP');
    expect(result.found).toBe(false);
    expect(result.dacMetricKey).toBeNull();
    expect(result.namespace).toBeNull();
    expect(result.isRecommended).toBe(false);
    expect(result.endOfLife).toBe(false);
  });
});

// ─── lookupMetricKey — AWS builtin key ───────────────────────────────────────

describe('lookupMetricKey — AWS builtInMetricKey', () => {
  // Real key from dac-aws-to-2ndgen-metrics.json
  const key = 'builtin:aws.alb.active.connection.count';

  it('returns found: true', () => {
    expect(lookupMetricKey(key, 'AWS').found).toBe(true);
  });

  it('returns the recommended DAC metric key', () => {
    const result = lookupMetricKey(key, 'AWS');
    expect(result.dacMetricKey).toBe(
      'cloud.aws.applicationelb.ActiveConnectionCount.By.LoadBalancer',
    );
  });

  it('returns isRecommended: true when dacRecommendedMetricKey is valid', () => {
    expect(lookupMetricKey(key, 'AWS').isRecommended).toBe(true);
  });

  it('returns the correct CloudWatch namespace', () => {
    expect(lookupMetricKey(key, 'AWS').namespace).toBe('AWS/ApplicationELB');
  });

  it('returns endOfLife: false for a non-EOL metric', () => {
    expect(lookupMetricKey(key, 'AWS').endOfLife).toBe(false);
  });
});

// ─── lookupMetricKey — AWS secondGenMetricKey (ext:) with recommended ────────

describe('lookupMetricKey — AWS secondGenMetricKey with dacRecommendedMetricKey', () => {
  // Real key from dac-aws-to-2ndgen-metrics.json
  const key = 'ext:cloud.aws.sageMakerEndpointInstances.cpuUtilizationAverageByVariantName';

  it('returns found: true', () => {
    expect(lookupMetricKey(key, 'AWS').found).toBe(true);
  });

  it('returns the recommended DAC metric key (not autodiscovered)', () => {
    const result = lookupMetricKey(key, 'AWS');
    expect(result.dacMetricKey).toBe(
      'cloud.aws.sagemaker_endpoint.CPUUtilization.By.EndpointName.VariantName',
    );
    expect(result.isRecommended).toBe(true);
  });
});

// ─── lookupMetricKey — AWS autodiscovered-only fallback ──────────────────────

describe('lookupMetricKey — AWS autodiscovered-only (no recommended key)', () => {
  // Real key: dacRecommendedMetricKey is "not-matched", dacAutodiscoveredMetricKey is valid
  const key =
    'ext:cloud.aws.sageMakerEndpointInstances.loadedModelCountAverageByVariantName';

  it('returns found: true', () => {
    expect(lookupMetricKey(key, 'AWS').found).toBe(true);
  });

  it('returns the autodiscovered DAC metric key', () => {
    const result = lookupMetricKey(key, 'AWS');
    expect(result.dacMetricKey).toBe(
      'cloud.aws.sagemaker_endpoints.LoadedModelCount.By.EndpointName.VariantName',
    );
  });

  it('returns isRecommended: false', () => {
    expect(lookupMetricKey(key, 'AWS').isRecommended).toBe(false);
  });

  it('returns a non-null dacMetricKey (autodiscovery provides 100% coverage)', () => {
    expect(lookupMetricKey(key, 'AWS').dacMetricKey).not.toBeNull();
  });
});

// ─── lookupMetricKey — AWS key not in table ───────────────────────────────────

describe('lookupMetricKey — AWS key not found', () => {
  it('returns found: false for an unknown key', () => {
    const result = lookupMetricKey('builtin:unknown.metric.key', 'AWS');
    expect(result.found).toBe(false);
    expect(result.dacMetricKey).toBeNull();
    expect(result.namespace).toBeNull();
  });

  it('returns found: false for dt.cloud.aws.* prefix (not indexed in mapping table)', () => {
    const result = lookupMetricKey('dt.cloud.aws.ec2.cpu_usage', 'AWS');
    expect(result.found).toBe(false);
  });
});

// ─── lookupMetricKey — Azure builtInMetricKey ────────────────────────────────

describe('lookupMetricKey — Azure builtInMetricKey', () => {
  const key = 'builtin:cloud.azure.apiMgmt.capacity';

  it('returns found: true', () => {
    expect(lookupMetricKey(key, 'Azure').found).toBe(true);
  });

  it('returns the recommended DAC metric key', () => {
    const result = lookupMetricKey(key, 'Azure');
    expect(result.dacMetricKey).toBe(
      'cloud.azure.microsoft_apimanagement.service.Capacity',
    );
  });

  it('returns isRecommended: true', () => {
    expect(lookupMetricKey(key, 'Azure').isRecommended).toBe(true);
  });

  it('returns the correct ARM resource type as namespace', () => {
    expect(lookupMetricKey(key, 'Azure').namespace).toBe(
      'Microsoft.ApiManagement/service',
    );
  });
});

// ─── lookupMetricKey — Azure supportingServiceMetricKey (ext:) ───────────────

describe('lookupMetricKey — Azure supportingServiceMetricKey (ext:)', () => {
  const key = 'ext:cloud.azure.microsoft_apimanagement.service.requests';

  it('returns found: true (uses supportingServiceMetricKey, not secondGenMetricKey)', () => {
    expect(lookupMetricKey(key, 'Azure').found).toBe(true);
  });

  it('returns dacMetricKey via autodiscovered fallback', () => {
    const result = lookupMetricKey(key, 'Azure');
    expect(result.dacMetricKey).toBe(
      'cloud.azure.microsoft_apimanagement.service.Requests',
    );
    expect(result.isRecommended).toBe(false);
  });
});

// ─── lookupMetricKey — Azure EOL metric ──────────────────────────────────────

describe('lookupMetricKey — Azure end-of-life metric', () => {
  const key =
    'ext:cloud.azure.microsoft_classiccompute.virtualmachines.disk_read_bytes_sec';

  it('returns found: true', () => {
    expect(lookupMetricKey(key, 'Azure').found).toBe(true);
  });

  it('returns endOfLife: true', () => {
    expect(lookupMetricKey(key, 'Azure').endOfLife).toBe(true);
  });

  it('still returns a dacMetricKey (autodiscovered) despite being EOL', () => {
    expect(lookupMetricKey(key, 'Azure').dacMetricKey).not.toBeNull();
  });

  it('returns the correct ARM namespace', () => {
    expect(lookupMetricKey(key, 'Azure').namespace).toBe(
      'Microsoft.ClassicCompute/virtualMachines',
    );
  });
});

// ─── isMigratable ────────────────────────────────────────────────────────────

describe('isMigratable', () => {
  it('returns false for GCP regardless of keys', () => {
    expect(isMigratable(['builtin:aws.alb.active.connection.count'], 'GCP')).toBe(false);
  });

  it('returns false for empty key array', () => {
    expect(isMigratable([], 'AWS')).toBe(false);
  });

  it('returns true when all keys resolve to a non-null DAC metric key (AWS)', () => {
    expect(
      isMigratable(['builtin:aws.alb.active.connection.count'], 'AWS'),
    ).toBe(true);
  });

  it('returns true for keys resolved via autodiscovery (AWS)', () => {
    expect(
      isMigratable(
        ['ext:cloud.aws.sageMakerEndpointInstances.loadedModelCountAverageByVariantName'],
        'AWS',
      ),
    ).toBe(true);
  });

  it('returns false when any key is not in the mapping table', () => {
    expect(
      isMigratable(
        ['builtin:aws.alb.active.connection.count', 'builtin:totally.unknown.metric'],
        'AWS',
      ),
    ).toBe(false);
  });

  it('returns true for Azure keys that resolve correctly', () => {
    expect(isMigratable(['builtin:cloud.azure.apiMgmt.capacity'], 'Azure')).toBe(true);
  });
});

// ─── hasEndOfLifeMetrics ──────────────────────────────────────────────────────

describe('hasEndOfLifeMetrics', () => {
  it('returns false for GCP', () => {
    expect(
      hasEndOfLifeMetrics(
        ['ext:cloud.azure.microsoft_classiccompute.virtualmachines.disk_read_bytes_sec'],
        'GCP',
      ),
    ).toBe(false);
  });

  it('returns false for empty key array', () => {
    expect(hasEndOfLifeMetrics([], 'Azure')).toBe(false);
  });

  it('returns true when at least one key is EOL (Azure)', () => {
    expect(
      hasEndOfLifeMetrics(
        ['ext:cloud.azure.microsoft_classiccompute.virtualmachines.disk_read_bytes_sec'],
        'Azure',
      ),
    ).toBe(true);
  });

  it('returns false when no key is EOL (AWS)', () => {
    expect(
      hasEndOfLifeMetrics(['builtin:aws.alb.active.connection.count'], 'AWS'),
    ).toBe(false);
  });

  it('returns true even when mixed with non-EOL keys', () => {
    expect(
      hasEndOfLifeMetrics(
        [
          'builtin:cloud.azure.apiMgmt.capacity',
          'ext:cloud.azure.microsoft_classiccompute.virtualmachines.disk_read_bytes_sec',
        ],
        'Azure',
      ),
    ).toBe(true);
  });

  it('returns false when key is not found in the table', () => {
    expect(hasEndOfLifeMetrics(['builtin:totally.unknown.metric'], 'Azure')).toBe(false);
  });
});

// ─── isServiceSupported ───────────────────────────────────────────────────────

describe('isServiceSupported', () => {
  it('returns false for GCP', () => {
    expect(isServiceSupported('AWS/ApplicationELB', 'GCP')).toBe(false);
  });

  it('returns false for null namespace', () => {
    expect(isServiceSupported(null, 'AWS')).toBe(false);
  });

  it('returns true for a known AWS namespace', () => {
    expect(isServiceSupported('AWS/ApplicationELB', 'AWS')).toBe(true);
  });

  it('returns true for a known Azure ARM resource type', () => {
    expect(isServiceSupported('Microsoft.ApiManagement/service', 'Azure')).toBe(true);
  });

  it('returns false for an unknown namespace', () => {
    expect(isServiceSupported('AWS/NonExistentService', 'AWS')).toBe(false);
  });
});

// ─── getEndOfLifeInfo ─────────────────────────────────────────────────────────

describe('getEndOfLifeInfo', () => {
  it('returns null for GCP', () => {
    expect(getEndOfLifeInfo('Microsoft.ClassicCompute/virtualMachines', 'GCP')).toBeNull();
  });

  it('returns null for null namespace', () => {
    expect(getEndOfLifeInfo(null, 'Azure')).toBeNull();
  });

  it('returns EOL info for a known Azure EOL service', () => {
    const info = getEndOfLifeInfo('Microsoft.ClassicCompute/virtualMachines', 'Azure');
    expect(info).not.toBeNull();
    expect(info?.endOfLifeDate).toBe('2023-09-06');
    expect(info?.announcementUrl).toContain('microsoft.com');
  });

  it('returns null for a non-EOL Azure service', () => {
    // Microsoft.ApiManagement/service is not in end-of-life-services.json
    expect(getEndOfLifeInfo('Microsoft.ApiManagement/service', 'Azure')).toBeNull();
  });

  it('returns null for AWS (CW namespace does not match CloudFormation types in EOL file)', () => {
    // AWS EOL file uses CloudFormation types (e.g. AWS::OpsWorks::Stack), not CW namespaces
    expect(getEndOfLifeInfo('AWS/ApplicationELB', 'AWS')).toBeNull();
  });
});
