import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { rewriteDql, isBlockingWarning } from './dql-rewriter.ts';
import type {
  CompositeFormula,
  DetectedRecipe,
  MappingEntry,
  RecipeIndex,
} from './recipe-lookup.ts';

function buildIndex(entries: MappingEntry[]): RecipeIndex {
  const byClassicId = new Map<string, MappingEntry>();
  const byDqlClassicKey = new Map<string, MappingEntry>();
  for (const e of entries) {
    byClassicId.set(e.classicMetricId, e);
    // Build the corresponding dt.cloud.aws.* key the same way the real loader does.
    const builtinSuffix = e.classicMetricId.replace(/^builtin:/, '');
    const dqlKey =
      'dt.' + builtinSuffix.split('.').map((p) => p.replace(/(?<!^)(?=[A-Z])/g, '_').toLowerCase()).join('.');
    byDqlClassicKey.set(dqlKey, e);
  }
  return { byClassicId, byDqlClassicKey };
}

const cpuRecipe: DetectedRecipe = {
  classicAggregation: 'avg',
  newAggregation: 'avg',
  newAggregationMode: 'raw',
  scale: 1.0006,
  verdict: 'exact-fit',
  pearsonR: 0.992,
  residualSmape: 0.05,
  source: 'detect-per-resource',
};

const netRxRecipe: DetectedRecipe = {
  classicAggregation: 'avg',
  newAggregation: 'sum',
  newAggregationMode: 'per_second',
  scale: 0.97,
  verdict: 'exact-fit',
  pearsonR: 0.999,
  residualSmape: 0.01,
};

const throttleWriteRecipe: DetectedRecipe = {
  classicAggregation: 'sum',
  newAggregation: 'sum',
  newAggregationMode: 'raw',
  scale: 2.0,
  verdict: 'exact-fit',
  pearsonR: 1.0,
  residualSmape: 0,
};

const cpuEntry: MappingEntry = {
  service: 'EC2',
  classicMetricId: 'builtin:cloud.aws.ec2.cpu.usage',
  newDtMetricKey: 'cloud.aws.ec2.CPUUtilization.By.InstanceId',
  detectedRecipe: cpuRecipe,
};

const netRxEntry: MappingEntry = {
  service: 'EC2',
  classicMetricId: 'builtin:cloud.aws.ec2.net.rx',
  newDtMetricKey: 'cloud.aws.ec2.NetworkIn.By.InstanceId',
  detectedRecipe: netRxRecipe,
};

const throttleWriteEntry: MappingEntry = {
  service: 'DynamoDB',
  classicMetricId: 'builtin:cloud.aws.dynamo.throttledEvents.write',
  newDtMetricKey: 'cloud.aws.dynamodb.WriteThrottleEvents.By.TableName',
  detectedRecipe: throttleWriteRecipe,
};

const compositeFormula: CompositeFormula = {
  classicMetricId: 'builtin:cloud.aws.dynamo.capacityUnits.read',
  formula: '(consumed / provisioned) * 100',
  components: [
    {
      role: 'consumed',
      newDtMetricKey: 'cloud.aws.dynamodb.ConsumedReadCapacityUnits.By.TableName',
      newAggregation: 'sum',
    },
    {
      role: 'provisioned',
      newDtMetricKey: 'cloud.aws.dynamodb.ProvisionedReadCapacityUnits.By.TableName',
      newAggregation: 'avg',
    },
  ],
  verified: false,
  verificationNotes: 'unverified — empirical test failed',
};

const capacityEntry: MappingEntry = {
  service: 'DynamoDB',
  classicMetricId: 'builtin:cloud.aws.dynamo.capacityUnits.read',
  compositeFormula,
};

describe('rewriteDql — metric key swap (basic)', () => {
  it('replaces classic metric key, keeps aggregation when recipe matches', () => {
    const idx = buildIndex([cpuEntry]);
    const r = rewriteDql(
      'timeseries cpu = avg(builtin:cloud.aws.ec2.cpu.usage)',
      idx
    );
    assert.match(r.rewritten, /avg\(`cloud\.aws\.ec2\.CPUUtilization\.By\.InstanceId`\)/);
    assert.equal(r.transforms[0]?.kind, 'metric-key');
  });

  it('emits clean agg call for per_second recipe + warns to apply division as a pipeline step', () => {
    const idx = buildIndex([netRxEntry]);
    const r = rewriteDql('timeseries x = avg(builtin:cloud.aws.ec2.net.rx)', idx);
    // Clean agg call — no inline arithmetic (DQL rejects that).
    assert.match(r.rewritten, /sum\(`cloud\.aws\.ec2\.NetworkIn\.By\.InstanceId`\)/);
    assert.doesNotMatch(r.rewritten, /\/ 300/);
    assert.doesNotMatch(r.rewritten, /\* 0\.97/);
    // Warning describes the post-aggregation math.
    const w = r.warnings.find((w) => /post-aggregation math/.test(w.text));
    assert.ok(w);
    assert.match(w!.text, /divide by bucket-interval seconds/);
    assert.match(w!.text, /multiply by scale 0\.97/);
  });

  it('emits clean agg call for non-1 scale + warns', () => {
    const idx = buildIndex([throttleWriteEntry]);
    const r = rewriteDql('timeseries x = sum(builtin:cloud.aws.dynamo.throttledEvents.write)', idx);
    assert.match(r.rewritten, /sum\(`cloud\.aws\.dynamodb\.WriteThrottleEvents\.By\.TableName`\)/);
    assert.doesNotMatch(r.rewritten, /\* 2/);
    const w = r.warnings.find((w) => /post-aggregation math/.test(w.text));
    assert.ok(w);
    assert.match(w!.text, /multiply by scale 2/);
  });

  it('skips unmodified scale=1 (no scale wrapper)', () => {
    const idx = buildIndex([cpuEntry]); // cpuRecipe scale=1.0006 → diff < 0.05, no wrap
    const r = rewriteDql('timeseries x = avg(builtin:cloud.aws.ec2.cpu.usage)', idx);
    // Should NOT contain `* 1` wrapper
    assert.doesNotMatch(r.rewritten, /\*\s*1\.\d+/);
  });
});

describe('rewriteDql — entity dimension swap', () => {
  it('replaces dt.entity.ec2_instance with dt.smartscape.aws_ec2_instance', () => {
    const idx = buildIndex([cpuEntry]);
    const r = rewriteDql(
      'timeseries avg(builtin:cloud.aws.ec2.cpu.usage), by:{ dt.entity.ec2_instance }',
      idx
    );
    assert.match(r.rewritten, /by:\{ dt\.smartscape\.aws_ec2_instance \}/);
    const dimTransforms = r.transforms.filter((t) => t.kind === 'entity-dim');
    assert.equal(dimTransforms.length, 1);
    assert.equal(dimTransforms[0]?.after, 'dt.smartscape.aws_ec2_instance');
  });

  it('preserves backtick quoting style for special-char entity types', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'timeseries avg(some_metric), by:{ `dt.entity.cloud:aws:applicationelb` }',
      idx
    );
    assert.match(r.rewritten, /`dt\.smartscape\.aws_elasticloadbalancingv2_loadbalancer`/);
  });

  it('warns on unknown entity types and leaves them alone', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'timeseries avg(some_metric), by:{ dt.entity.totally_unknown }',
      idx
    );
    assert.match(r.rewritten, /dt\.entity\.totally_unknown/);
    assert.ok(r.warnings.some((w) => w.kind === 'unmapped-entity-type'));
  });

  it('leaves non-AWS host_group untouched with a non-blocking non-aws-entity note', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'timeseries avg(x), by:{ dt.entity.host_group }',
      idx
    );
    assert.match(r.rewritten, /dt\.entity\.host_group/);
    assert.ok(r.warnings.some((w) => w.kind === 'non-aws-entity'));
    assert.equal(isBlockingWarning('non-aws-entity'), false);
  });
});

describe('rewriteDql — reviewer-feedback fixes (entity.name / tags / region)', () => {
  it('entityAttr(x,"entity.name") → getNodeName(x), not getNodeField', () => {
    const r = rewriteDql(
      'timeseries { count(some_metric) }, by:{ dt.entity.aws_application_load_balancer }, filter: { matchesValue(entityAttr(dt.entity.aws_application_load_balancer, "entity.name"), "*ccl*") }',
      buildIndex([])
    );
    assert.match(r.rewritten, /matchesValue\(getNodeName\(dt\.smartscape\.aws_elasticloadbalancingv2_loadbalancer\), "\*ccl\*"\)/);
    assert.doesNotMatch(r.rewritten, /getNodeField\([^)]*"entity\.name"\)/);
  });

  it('AWS tag literal filter in(tags,"[AWS]Key:val") → tags[Key] == "val"', () => {
    const r = rewriteDql(
      'timeseries { avg(x) }, by:{ dt.entity.dynamo_db_table }, filter: in(entityAttr(dt.entity.dynamo_db_table, "tags"), "[AWS]ApplicationCI:fbs")',
      buildIndex([])
    );
    assert.match(r.rewritten, /getNodeField\(dt\.smartscape\.aws_dynamodb_table, "tags:aws"\)\[ApplicationCI\] == "fbs"/);
    assert.doesNotMatch(r.rewritten, /in\(getNodeField/);
  });

  it('AWS tag concat filter via a tags var → tags[Key] == $Var (both arg orders)', () => {
    const r = rewriteDql(
      'timeseries requests = avg(x), by:{dt.entity.aws_application_load_balancer}\n| fieldsAdd tags = entityAttr(dt.entity.aws_application_load_balancer, "tags")\n| filter in(concat("[AWS]ApplicationCI:", $ApplicationCI), tags) and in(tags, concat("[AWS]env:", $Env))',
      buildIndex([])
    );
    assert.match(r.rewritten, /tags\[ApplicationCI\] == \$ApplicationCI/);
    assert.match(r.rewritten, /tags\[env\] == \$Env/);
    assert.doesNotMatch(r.rewritten, /in\(concat/);
  });

  it('does NOT touch a bare `tags` not sourced from an AWS tag record (span safety)', () => {
    const q = 'fetch spans | filter in(tags, "[AWS]ApplicationCI:fbs")';
    const r = rewriteDql(q, buildIndex([]));
    assert.match(r.rewritten, /in\(tags, "\[AWS\]ApplicationCI:fbs"\)/); // unchanged
  });

  it('region from ARN split (splitString(arn,":")[3]) → aws.region field', () => {
    const r = rewriteDql(
      'timeseries {avg(x)}, by:{ dt.entity.dynamo_db_table }\n| fieldsAdd arn=entityAttr(dt.entity.dynamo_db_table, "arn")\n| fieldsAdd region = splitString(arn, ":")[3]',
      buildIndex([])
    );
    assert.match(r.rewritten, /region = getNodeField\(dt\.smartscape\.aws_dynamodb_table, "aws\.region"\)/);
    assert.doesNotMatch(r.rewritten, /splitString\(arn, ":"\)\[3\]/);
  });

  it('drops the now-dead arn fieldsAdd once region uses aws.region (standalone stage)', () => {
    const r = rewriteDql(
      'timeseries {avg(x)}, by:{ dt.entity.dynamo_db_table }\n| fieldsAdd arn=entityAttr(dt.entity.dynamo_db_table, "arn")\n| fieldsAdd region = splitString(arn, ":")[3]\n| filter in(region,$Region)',
      buildIndex([])
    );
    assert.doesNotMatch(r.rewritten, /"arn"/); // arn fieldsAdd removed
    assert.match(r.rewritten, /region = getNodeField\(dt\.smartscape\.aws_dynamodb_table, "aws\.region"\)/);
  });

  it('keeps the arn fieldsAdd (renamed to aws.arn) when arn is still referenced elsewhere', () => {
    const r = rewriteDql(
      'timeseries {avg(x)}, by:{ dt.entity.dynamo_db_table }\n| fieldsAdd arn=entityAttr(dt.entity.dynamo_db_table, "arn")\n| fieldsAdd region = splitString(arn, ":")[3]\n| fields arn, region',
      buildIndex([])
    );
    assert.match(r.rewritten, /arn=getNodeField\(dt\.smartscape\.aws_dynamodb_table, "aws\.arn"\)/);
  });

  it('renames getNodeField(x,"arn") → "aws.arn" (bare arn reads null on new side)', () => {
    const r = rewriteDql(
      'timeseries {avg(x)}, by:{ dt.entity.aws_lambda_function }\n| fieldsAdd a = entityAttr(dt.entity.aws_lambda_function, "arn")\n| fields a',
      buildIndex([])
    );
    assert.match(r.rewritten, /getNodeField\(dt\.smartscape\.aws_lambda_function, "aws\.arn"\)/);
    assert.doesNotMatch(r.rewritten, /"arn"\)/);
  });

  it('splitString(arn,":")[4] → aws.account.id field', () => {
    const r = rewriteDql(
      'timeseries {avg(x)}, by:{ dt.entity.aws_lambda_function }\n| fieldsAdd arn = entityAttr(dt.entity.aws_lambda_function,"arn")\n| fieldsAdd account = splitString(arn, ":")[4]',
      buildIndex([])
    );
    assert.match(r.rewritten, /account = getNodeField\(dt\.smartscape\.aws_lambda_function, "aws\.account\.id"\)/);
  });

  it('dt.smartscape.X.entity.name (dim field path) → getNodeName(X)', () => {
    const r = rewriteDql(
      'timeseries {avg(x)}, by:{ dt.entity.aws_application_load_balancer }\n| filter contains(dt.entity.aws_application_load_balancer.entity.name, "aap")',
      buildIndex([])
    );
    assert.match(r.rewritten, /contains\(getNodeName\(dt\.smartscape\.aws_elasticloadbalancingv2_loadbalancer\), "aap"\)/);
  });

  it('dangling dt.smartscape.aws_account column → the account-name column (credential collapse)', () => {
    const r = rewriteDql(
      'timeseries avg = avg(cloud.aws.lambda.invocations_sum), by:{dt.entity.custom_device = dt.source_entity}\n| fieldsAdd dt.entity.aws_credentials = entityAttr(dt.entity.custom_device, "accessible_by")[dt.entity.aws_credentials][0]\n| fieldsAdd awsAccount = lower(entityName(dt.entity.aws_credentials))\n| fields name, dt.entity.custom_device, dt.entity.aws_credentials',
      buildIndex([])
    );
    // Native-dim path (Pass 0.6): the dangling credential column resolves to the
    // native aws.account.name dim, not a nonexistent bare account.name.
    assert.match(r.rewritten, /\| fields name, dt\.smartscape\.aws_lambda_function, aws\.account\.name/);
    assert.doesNotMatch(r.rewritten, /dt\.smartscape\.aws_account/);
    assert.doesNotMatch(r.rewritten, /(?<!aws\.)\baccount\.name\b/);
  });

  it('dedupes a duplicate grouping dim in a by:{} clause (FIELD_SPECIFIED_TWICE)', () => {
    const r = rewriteDql(
      'timeseries {avg(x)}, by:{ dt.entity.dynamo_db_table }\n| summarize sum(y), by:{Table, dt.entity.dynamo_db_table, dt.entity.dynamo_db_table}',
      buildIndex([])
    );
    const by = r.rewritten.match(/by:\{([^}]*)\}/g)?.pop() ?? '';
    assert.equal((by.match(/dt\.smartscape\.aws_dynamodb_table/g) ?? []).length, 1);
  });

  it('names a bare getNodeName/getNodeField fieldsAdd operand (was nameless → invalid)', () => {
    const r = rewriteDql(
      'timeseries {avg(x)}, by:{dt.entity.aws_application_load_balancer}\n| fieldsAdd dt.entity.aws_application_load_balancer.tags, dt.entity.aws_application_load_balancer.entity.name',
      buildIndex([])
    );
    assert.match(r.rewritten, /`dt\.smartscape\.aws_elasticloadbalancingv2_loadbalancer\.tags` = getNodeField\([^)]*"tags:aws"\)/);
    assert.match(r.rewritten, /`dt\.smartscape\.aws_elasticloadbalancingv2_loadbalancer\.name` = getNodeName\(/);
    // no bare function-call operand remains (fieldsAdd ... getNodeField without =)
    assert.doesNotMatch(r.rewritten, /fieldsAdd\s+getNodeField/);
  });

  it('leaves an already-named fieldsAdd operand untouched', () => {
    const r = rewriteDql(
      'timeseries {avg(x)}, by:{dt.entity.aws_lambda_function}\n| fieldsAdd nm = entityName(dt.entity.aws_lambda_function)',
      buildIndex([])
    );
    assert.match(r.rewritten, /fieldsAdd nm = getNodeName\(dt\.smartscape\.aws_lambda_function\)/);
  });

  it('leaves dt.smartscape.aws_account alone when no account-name column is resolvable', () => {
    // No AWS_ACCOUNT lookup / account.name in the query → can't resolve → no-op.
    const r = rewriteDql('timeseries {avg(x)}, by:{ dt.entity.aws_credentials }\n| fields dt.entity.aws_credentials', buildIndex([]));
    assert.match(r.rewritten, /dt\.smartscape\.aws_account/);
  });

  it('dt.smartscape.X.tags field-access + [AWS] filter → getNodeField tags:aws key compare', () => {
    const r = rewriteDql(
      'timeseries requests = avg(dt.cloud.aws.alb.requests), by:{dt.entity.aws_application_load_balancer}\n| filter in(concat("[AWS]ApplicationCI:", $ApplicationCI), dt.entity.aws_application_load_balancer.tags)',
      buildIndex([])
    );
    assert.match(r.rewritten, /getNodeField\(dt\.smartscape\.aws_elasticloadbalancingv2_loadbalancer, "tags:aws"\)\[ApplicationCI\] == \$ApplicationCI/);
    assert.doesNotMatch(r.rewritten, /\.tags\b(?!:)/);
  });

  it('does NOT touch splitString(x,":")[3] when x is not a traced ARN var (safety)', () => {
    const r = rewriteDql('fetch dt.entity.aws_lambda_function | fieldsAdd region = splitString(other, ":")[3]', buildIndex([]));
    assert.match(r.rewritten, /splitString\(other, ":"\)\[3\]/);
  });

  it('region from a lookup-prefixed device.customProperties[REGION_NAME] → node aws.region', () => {
    const r = rewriteDql(
      'timeseries {sum(x)}, by:{dt.entity.dynamo_db_table = dt.source_entity}\n| lookup [fetch dt.entity.dynamo_db_table | fields name, id], sourceField:dt.entity.dynamo_db_table, lookupField:id, prefix:"device."\n| fieldsAdd region = device.customProperties[REGION_NAME]',
      buildIndex([])
    );
    assert.match(r.rewritten, /region = getNodeField\(dt\.smartscape\.aws_dynamodb_table, "aws\.region"\)/);
    assert.doesNotMatch(r.rewritten, /customProperties/);
  });

  it('region from customProperties[REGION_NAME] → aws.region field', () => {
    const r = rewriteDql(
      'timeseries max(x), by:{ dt.entity.aws_lambda_function }\n| fieldsAdd region = entityAttr(dt.entity.aws_lambda_function, "customProperties")[REGION_NAME]',
      buildIndex([])
    );
    assert.match(r.rewritten, /region = getNodeField\(dt\.smartscape\.aws_lambda_function, "aws\.region"\)/);
    assert.doesNotMatch(r.rewritten, /customProperties/);
  });

  it('dedupes a duplicate column when two classic entities collapse to one node type', () => {
    const r = rewriteDql(
      'timeseries {avg(x)}, by:{ dt.entity.dynamo_db_table }\n| fields timeframe, dt.entity.dynamo_db_table, dt.entity.dynamo_db_table, appci',
      buildIndex([])
    );
    const matches = r.rewritten.match(/dt\.smartscape\.aws_dynamodb_table/g) ?? [];
    // one in the by-clause + exactly one left in the fields clause (dup removed)
    assert.equal(matches.length, 2);
  });
});

describe('rewriteDql — flags constructs needing manual migration', () => {
  it('flags classicEntitySelector', () => {
    const idx = buildIndex([cpuEntry]);
    const r = rewriteDql(
      'timeseries avg(builtin:cloud.aws.ec2.cpu.usage), filter:{ in(dt.entity.ec2_instance, classicEntitySelector("type(ec2_instance),tag(env:prod)")) }',
      idx
    );
    const w = r.warnings.find((w) => w.kind === 'classic-entity-selector');
    assert.ok(w);
    assert.match(w.reference ?? '', /mass-data-filtering/);
  });

  it('translates entityName(x) to getNodeName(x) for an AWS entity', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('fields name = entityName(dt.entity.ec2_instance)', idx);
    assert.match(r.rewritten, /getNodeName\(dt\.smartscape\.aws_ec2_instance\)/);
    assert.doesNotMatch(r.rewritten, /entityName/);
  });

  it('leaves entityName on a non-AWS entity (host) classic', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('fields name = entityName(dt.entity.host)', idx);
    assert.match(r.rewritten, /entityName\(dt\.entity\.host\)/);
    assert.doesNotMatch(r.rewritten, /getNodeName/);
  });

  it('translates entityAttr(x, "f") to getNodeField(x, "f") for a generic field', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'fields nm = entityAttr(dt.entity.aws_lambda_function, "detected_name")',
      idx
    );
    assert.match(
      r.rewritten,
      /getNodeField\(dt\.smartscape\.aws_lambda_function, "detected_name"\)/
    );
    assert.doesNotMatch(r.rewritten, /entityAttr/);
  });

  it('drops type: argument from entityName per skill rule (AWS entity)', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'fields name = entityName(dt.entity.ec2_instance, type:"dt.entity.ec2_instance")',
      idx
    );
    assert.match(r.rewritten, /getNodeName\(dt\.smartscape\.aws_ec2_instance\)/);
    assert.doesNotMatch(r.rewritten, /type:/);
  });

  it('translates simple <edge>[dt.entity.X] to references[<edge>.<x>] for AWS entities', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'fetch dt.entity.ec2_instance | fieldsAdd az = belongs_to[dt.entity.aws_availability_zone]',
      idx
    );
    // fetch restructure + bracket translation (edge may be validator-substituted)
    assert.match(r.rewritten, /smartscapeNodes AWS_EC2_INSTANCE/);
    assert.match(r.rewritten, /references\[\w+\.aws_availability_zone\]/);
  });

  it('relationship-bracket validator substitutes edge when classic name is wrong for source-target pair', () => {
    const idx = buildIndex([]);
    // EC2 instance -> aws_availability_zone is `runs_on` in Smartscape, not `belongs_to`.
    const r = rewriteDql(
      'fetch dt.entity.ec2_instance | fieldsAdd az = belongs_to[dt.entity.aws_availability_zone]',
      idx
    );
    assert.match(r.rewritten, /references\[runs_on\.aws_availability_zone\]/);
    assert.ok(
      r.warnings.some((w) => /substituting "runs_on"/i.test(w.text))
    );
  });

  it('flags hardcoded classic ID literals', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'filter:{ id == "EC2_INSTANCE-A1A38D1D1C747BC2" }',
      idx
    );
    assert.ok(r.warnings.some((w) => w.kind === 'classic-id-literal'));
  });
});

describe('rewriteDql — composite formulas', () => {
  it('flags composite-formula metrics with the formula spec and unverified note', () => {
    const idx = buildIndex([capacityEntry]);
    const r = rewriteDql(
      'timeseries util = avg(builtin:cloud.aws.dynamo.capacityUnits.read)',
      idx
    );
    // Original metric reference should NOT have been replaced.
    assert.match(r.rewritten, /builtin:cloud\.aws\.dynamo\.capacityUnits\.read/);
    const w = r.warnings.find((w) => w.kind === 'composite-formula-needed');
    assert.ok(w);
    assert.match(w.text, /consumed \/ provisioned/);
    assert.match(w.text, /UNVERIFIED/);
  });
});

describe('rewriteDql — fetch restructure (Situation 3)', () => {
  it('rewrites fetch dt.entity.X to smartscapeNodes <TYPE>', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('fetch dt.entity.ec2_instance | fields entity.name, id', idx);
    assert.match(r.rewritten, /smartscapeNodes AWS_EC2_INSTANCE/);
    assert.doesNotMatch(r.rewritten, /fetch dt\.entity/);
  });

  it('translates entity.name to bare name when fetch was restructured', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'fetch dt.entity.ec2_instance | fields entity.name, id',
      idx
    );
    assert.match(r.rewritten, /\bname\b/);
    assert.doesNotMatch(r.rewritten, /entity\.name/);
  });

  it('leaves entity.name alone when no fetch was restructured', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('timeseries avg(x), by:{entity.name}', idx);
    assert.match(r.rewritten, /entity\.name/);
  });

  it('leaves non-AWS fetch dt.entity.host_group untouched (non-aws-entity)', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('fetch dt.entity.host_group | fields id', idx);
    assert.match(r.rewritten, /fetch dt\.entity\.host_group/);
    assert.ok(r.warnings.some((w) => w.kind === 'non-aws-entity'));
  });

  it('translates fetch dt.entity.custom_device | filter entity.type == "cloud:aws:lambda" to smartscapeNodes AWS_LAMBDA_FUNCTION', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'fetch dt.entity.custom_device\n| filter entity.type == "cloud:aws:lambda"\n| fields id',
      idx
    );
    assert.match(r.rewritten, /smartscapeNodes AWS_LAMBDA_FUNCTION/);
    assert.doesNotMatch(r.rewritten, /custom_device/);
    assert.doesNotMatch(r.rewritten, /entity\.type\s*==\s*"cloud:aws:lambda"/);
  });

  it('flags custom_device fetch when the entity.type service has no node type', () => {
    const idx = buildIndex([]);
    // cloud:aws:elb (classic ELBv1) has no new-connection equivalent per the
    // DAC entities reference — a stable "genuinely unmapped" example.
    const r = rewriteDql(
      'fetch dt.entity.custom_device | filter entity.type == "cloud:aws:elb"',
      idx
    );
    // Unresolvable → left for the downstream not-planned warning.
    assert.match(r.rewritten, /custom_device/);
    assert.ok(r.warnings.some((w) => w.kind === 'unmapped-entity-type'));
  });

  it('leaves non-AWS cloud_application (Kubernetes) untouched', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'timeseries avg(x), by:{dt.entity.cloud_application}',
      idx
    );
    // K8s workload — out of AWS scope; left classic (no k8s_* swap, no ambiguous warning).
    assert.match(r.rewritten, /dt\.entity\.cloud_application/);
    assert.doesNotMatch(r.rewritten, /dt\.smartscape\.k8s/);
    assert.ok(r.warnings.some((w) => w.kind === 'non-aws-entity'));
  });

  it('leaves non-AWS kubernetes_cluster / cloud_application_instance / container_group_instance untouched', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'timeseries avg(x), by:{dt.entity.kubernetes_cluster, dt.entity.cloud_application_instance, dt.entity.container_group_instance}',
      idx
    );
    assert.match(r.rewritten, /dt\.entity\.kubernetes_cluster/);
    assert.match(r.rewritten, /dt\.entity\.cloud_application_instance/);
    assert.match(r.rewritten, /dt\.entity\.container_group_instance/);
    assert.doesNotMatch(r.rewritten, /dt\.smartscape\.(k8s|container)/);
    assert.ok(r.warnings.some((w) => w.kind === 'non-aws-entity'));
  });

  it('leaves an APM/process tile entirely classic (the CLS tile-106 case)', () => {
    // process_group_instance → PROCESS is non-AWS; converting it produced clean
    // DQL that failed at runtime (ENRICHMENT_FUNCTION_TABLE_SIZE). Leave it all.
    const idx = buildIndex([]);
    const q =
      'timeseries {cpu = avg(dt.process.cpu.usage)}, by:{dt.entity.process_group_instance}\n' +
      '| fieldsRename id = dt.entity.process_group_instance\n' +
      '| fieldsAdd Service = entityName(id, type:"dt.entity.process_group_instance")';
    const r = rewriteDql(q, idx);
    assert.match(r.rewritten, /by:\{dt\.entity\.process_group_instance\}/);
    assert.match(r.rewritten, /entityName\(id, type:"dt\.entity\.process_group_instance"\)/);
    assert.doesNotMatch(r.rewritten, /dt\.smartscape\.process/);
    assert.doesNotMatch(r.rewritten, /getNodeName/);
    assert.ok(r.warnings.some((w) => w.kind === 'non-aws-entity'));
    assert.ok(!r.warnings.some((w) => isBlockingWarning(w.kind)), 'non-AWS content must not be blocking');
  });

  it('renames classic AWS_ACCOUNT field awsAccountId to aws.account.id when fetch was restructured', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'fetch dt.entity.aws_credentials\n| fields account = entity.name, awsAccountId, id',
      idx
    );
    assert.match(r.rewritten, /smartscapeNodes AWS_ACCOUNT/);
    assert.match(r.rewritten, /aws\.account\.id/);
    assert.doesNotMatch(r.rewritten, /\bawsAccountId\b/);
  });

  it('renames classic AWS_RDS_DBINSTANCE field rdsEngine to `db.system` with backticks', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'fetch dt.entity.relational_database_service | fields rdsEngine | dedup rdsEngine',
      idx
    );
    assert.match(r.rewritten, /smartscapeNodes AWS_RDS_DBINSTANCE/);
    // Dotted Smartscape names must be backtick-quoted — otherwise DQL parses
    // `lookup.db.system` as nested member access.
    assert.match(r.rewritten, /`db\.system`/);
    assert.doesNotMatch(r.rewritten, /\brdsEngine\b/);
  });

  it('does not rename dashboard variable references like $rdsEngine, but warns', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'fetch dt.entity.relational_database_service | fields rdsEngine | filter in($rdsEngine, rdsEngine)',
      idx
    );
    // $rdsEngine left alone (variable refs keep their declared name).
    assert.match(r.rewritten, /\$rdsEngine/);
    // bare rdsEngine swapped.
    assert.match(r.rewritten, /`db\.system`/);
    // a warning surfaces about the variable name now diverging from the field.
    assert.ok(
      r.warnings.some((w) => /\$rdsEngine/.test(w.text) && /variable/i.test(w.text))
    );
  });

  it('renames lookup.<classic> accessor to lookup.<smartscape> when subquery exposed the field', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'fetch dt.entity.relational_database_service | lookup [fetch dt.entity.relational_database_service | fieldsAdd rdsEngine], sourceField:id, lookupField:id | fields engine = lookup.rdsEngine',
      idx
    );
    assert.match(r.rewritten, /lookup\.`db\.system`/);
    assert.doesNotMatch(r.rewritten, /lookup\.rdsEngine/);
  });

  it('leaves field identifiers alone when fetch was not restructured', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('timeseries avg(x) | fields awsAccountId, rdsEngine', idx);
    // No fetch dt.entity.X → no source type known → don't rename.
    assert.match(r.rewritten, /awsAccountId/);
    assert.match(r.rewritten, /rdsEngine/);
  });
});

describe('rewriteDql — extended prefix coverage', () => {
  it('rewrites ext:cloud.aws.<service>.<snake_case> keys', () => {
    const idx = buildIndex([
      {
        service: 'Lambda',
        classicMetricId: 'ext:cloud.aws.lambda.invocations_sum',
        newDtMetricKey: 'cloud.aws.lambda.Invocations.By.FunctionName',
        detectedRecipe: {
          classicAggregation: 'sum', newAggregation: 'sum', newAggregationMode: 'raw',
          scale: 1, verdict: 'exact-fit', pearsonR: 0.99, residualSmape: 0.01,
        } as any,
      },
    ]);
    const r = rewriteDql('timeseries sum(ext:cloud.aws.lambda.invocations_sum)', idx);
    assert.match(r.rewritten, /cloud\.aws\.lambda\.Invocations\.By\.FunctionName/);
    assert.doesNotMatch(r.rewritten, /ext:cloud\.aws/);
  });

  it('rewrites bare cloud.aws.<service>.<snake_case> classic keys', () => {
    const idx = buildIndex([
      {
        service: 'Lambda',
        classicMetricId: 'cloud.aws.lambda.concurrent_executions_sum',
        newDtMetricKey: 'cloud.aws.lambda.ConcurrentExecutions.By.FunctionName',
        detectedRecipe: {
          classicAggregation: 'sum', newAggregation: 'sum', newAggregationMode: 'raw',
          scale: 1, verdict: 'exact-fit', pearsonR: 0.99, residualSmape: 0.01,
        } as any,
      },
    ]);
    const r = rewriteDql('timeseries sum(cloud.aws.lambda.concurrent_executions_sum)', idx);
    assert.match(r.rewritten, /cloud\.aws\.lambda\.ConcurrentExecutions\.By\.FunctionName/);
  });

  it('leaves new-form cloud.aws.<Service>.<PascalCase>.By.<Dim> keys untouched', () => {
    const idx = buildIndex([]);
    const input = 'timeseries avg(cloud.aws.ec2.CPUUtilization.By.InstanceId)';
    const r = rewriteDql(input, idx);
    // New-form key is already correct — nothing to rewrite, no unknown-metric flag.
    assert.equal(r.rewritten, input);
    assert.ok(!r.warnings.some((w) => w.kind === 'unknown-metric'));
  });
});

describe('rewriteDql — relationship-bracket subquery scope', () => {
  it('leaves accessible_by[dt.entity.aws_credentials] alone when inside lookup [fetch dt.entity.custom_device …]', () => {
    const idx = buildIndex([]);
    const input =
      'timeseries avg(x), by:{dt.entity.custom_device}\n' +
      '| lookup [fetch dt.entity.custom_device\n' +
      '| fieldsAdd creds = accessible_by[dt.entity.aws_credentials][0]], sourceField:dt.entity.custom_device, lookupField:id';
    const r = rewriteDql(input, idx);
    // Bracket inside the lookup subquery should NOT have been rewritten
    // to `references[accessible_by.aws_account]` — the surrounding fetch is
    // dt.entity.custom_device (not-planned), so references[…] would error.
    assert.match(r.rewritten, /accessible_by\[dt\.entity\.aws_credentials\]/);
    assert.doesNotMatch(r.rewritten, /references\[accessible_by\.aws_account\]/);
    // …and a targeted warning explains why.
    assert.ok(
      r.warnings.some((w) => /not-planned-type.*subquery/i.test(w.text))
    );
  });

  it('still rewrites brackets that are NOT inside a non-smartscape lookup', () => {
    const idx = buildIndex([]);
    // EC2 instance → AWS_EC2_INSTANCE (smartscape). belongs_to inside its
    // OWN top-level fetch should be rewritten to references[…].
    const input =
      'fetch dt.entity.ec2_instance\n' +
      '| fieldsAdd zone = belongs_to[dt.entity.aws_availability_zone][0]';
    const r = rewriteDql(input, idx);
    assert.match(r.rewritten, /references\[runs_on\.aws_availability_zone\]|references\[belongs_to\.aws_availability_zone\]/);
  });

  it('leaves the whole query classic when a downstream step references a lookup-output prefix from a not-planned lookup', () => {
    // Reduced from AAP_JET_Dynamo_DB_Metrics dashboard tile (2026-05-14 compare:
    // 6/6 tiles errored with `FIELD_DOES_NOT_EXIST: device.references`). The
    // chain is: lookup over `custom_device` with prefix:"device." emits
    // classic relationship arrays as `device.accessible_by`; downstream
    // fieldsAdd reads `device.accessible_by[dt.entity.aws_credentials][0]`.
    // Pass 1.7's previous behavior translated that to `device.references[
    // accessible_by.aws_account]`, but `device.references` doesn't exist —
    // `references[…]` only works on entity records, not on prefixed lookup
    // output. Pass 2 also swaps the LHS `dt.entity.X` and inside-bracket
    // `dt.entity.X`, producing further invalid shapes downstream.
    //
    // The right behavior: when ANY `lookup [fetch dt.entity.<not-planned>]`
    // chain exists in the query, none of the rewriter passes can produce
    // valid DQL — leave the whole query classic and emit a clear warning.
    // Classic DQL still runs on the new platform.
    const idx = buildIndex([]);
    const input =
      'timeseries avg(x), by:{dt.entity.custom_device}\n' +
      '| lookup [fetch dt.entity.custom_device\n' +
      '| fieldsAdd dt.entity.aws_credentials = accessible_by[dt.entity.aws_credentials][0]], sourceField:dt.entity.custom_device, lookupField:id, prefix:"device."\n' +
      '| fieldsAdd dt.entity.aws_credentials = device.accessible_by[dt.entity.aws_credentials][0]\n' +
      '| lookup [fetch dt.entity.aws_credentials | fields name = entity.name, id], sourceField:dt.entity.aws_credentials, lookupField:id, prefix:"account."\n' +
      '| filter account.name == "STG-AirportOps"';
    const r = rewriteDql(input, idx);
    // None of the invalid shapes the old rewriter produced.
    assert.doesNotMatch(r.rewritten, /device\.references\[/);
    assert.doesNotMatch(r.rewritten, /\baccessible_by\[dt\.smartscape\./);
    assert.doesNotMatch(r.rewritten, /\bdt\.smartscape\.aws_account\s*=\s*device\./);
    // Whole query preserved verbatim — original DQL still runs on the new
    // platform, just without auto-translation.
    assert.equal(r.rewritten, input);
    assert.equal(r.transforms.length, 0);
    // One clear warning explaining why nothing was translated.
    assert.ok(
      r.warnings.some((w) => /not-planned-type.*subquery/i.test(w.text)),
      `expected a not-planned-type subquery warning; got: ${r.warnings.map((w) => w.text).join(' | ')}`
    );
  });
});

describe('rewriteDql — source-entity field migration (Pass 2.65)', () => {
  it('migrates dt.source_entity.type → dt.smartscape_source.type', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'timeseries avg(x), by:{dt.source_entity.type}',
      idx
    );
    assert.match(r.rewritten, /by:\{dt\.smartscape_source\.type\}/);
    assert.doesNotMatch(r.rewritten, /dt\.source_entity\.type/);
  });

  it('migrates bare dt.source_entity → dt.smartscape_source.id', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'timeseries avg(x), by:{grp = dt.source_entity, dt.source_entity.type}',
      idx
    );
    // Both forms migrate; the bare one becomes .id, the .type one becomes .type.
    assert.match(r.rewritten, /grp = dt\.smartscape_source\.id/);
    assert.match(r.rewritten, /dt\.smartscape_source\.type/);
    assert.doesNotMatch(r.rewritten, /dt\.source_entity/);
  });

  it('leaves queries without source-entity fields untouched', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('timeseries avg(x), by:{aws.region}', idx);
    assert.doesNotMatch(r.rewritten, /smartscape_source/);
  });
});

describe('rewriteDql — credential-lookup-chain (Pass 0.5)', () => {
  // DynamoDB latency mapping so Pass 1 swaps the metric key (mapped-no-recipe).
  const dynamoLatencyEntry: MappingEntry = {
    classicMetricId: 'cloud.aws.dynamodb.successful_request_latency_by_operation',
    newDtMetricKey: 'cloud.aws.dynamodb.SuccessfulRequestLatency.By.Operation.TableName',
  } as MappingEntry;
  const dynamoIdx = () => buildIndex([dynamoLatencyEntry]);

  // The canonical DynamoDB bailout idiom — 97 of 106 corpus panels match this.
  const canonical =
    'timeseries avg(cloud.aws.dynamodb.successful_request_latency_by_operation), by:{dt.entity.custom_device}\n' +
    ' | lookup [fetch dt.entity.custom_device\n' +
    ' | fieldsAdd dt.entity.aws_credentials = accessible_by[dt.entity.aws_credentials][0]], sourceField:dt.entity.custom_device, lookupField:id, prefix:"device."\n' +
    ' | fieldsAdd dt.entity.aws_credentials = device.accessible_by[dt.entity.aws_credentials][0]\n' +
    ' | lookup [fetch dt.entity.aws_credentials | fields name = entity.name, id], sourceField:dt.entity.aws_credentials, lookupField:id, prefix:"account."\n' +
    ' | filter account.name == "DEV-CustomerTechnology"\n' +
    ' | filter like(device.entity.name, "%bym%")\n' +
    ' | summarize Latency = avg(arrayAvg(`avg(cloud.aws.dynamodb.successful_request_latency_by_operation)`))';

  it('converts the canonical chain instead of bailing out', () => {
    const idx = dynamoIdx();
    const r = rewriteDql(canonical, idx);
    // No bailout: the not-planned warning must NOT be present.
    assert.ok(
      !r.warnings.some((w) => /Leaving the entire query in classic form/.test(w.text)),
      'should not bail out'
    );
    // Both lookups rewritten to smartscapeNodes form.
    assert.match(r.rewritten, /lookup \[smartscapeNodes AWS_DYNAMODB_TABLE \| fields name, id, aws\.account\.id\]/);
    assert.match(r.rewritten, /lookup \[smartscapeNodes AWS_ACCOUNT \| fields name, aws\.account\.id\]/);
    assert.match(r.rewritten, /sourceField:device\.aws\.account\.id, lookupField:aws\.account\.id/);
    // custom_device dim swapped everywhere (by-clause + sourceField).
    assert.doesNotMatch(r.rewritten, /dt\.entity\.custom_device/);
    assert.match(r.rewritten, /by:\{dt\.smartscape\.aws_dynamodb_table\}/);
    // device.entity.name → device.name
    assert.match(r.rewritten, /like\(device\.name, "%bym%"\)/);
    assert.doesNotMatch(r.rewritten, /device\.entity\.name/);
  });

  it('realigns the summarize backtick column ref to the swapped metric key', () => {
    const idx = dynamoIdx();
    const r = rewriteDql(canonical, idx);
    // The stale classic backtick ref must be gone; the new one present.
    assert.doesNotMatch(
      r.rewritten,
      /`avg\(cloud\.aws\.dynamodb\.successful_request_latency_by_operation\)`/
    );
    assert.match(
      r.rewritten,
      /arrayAvg\(`avg\(cloud\.aws\.dynamodb\.SuccessfulRequestLatency\.By\.Operation\.TableName\)`\)/
    );
  });

  it('emits the credential-collapse (multi-credential broadening) warning', () => {
    const idx = dynamoIdx();
    const r = rewriteDql(canonical, idx);
    assert.ok(
      r.warnings.some((w) => /multiple classic credentials/.test(w.text) && /BROADER/.test(w.text))
    );
  });

  it('leaves the chain (bails) when the metric service has no node-type mapping', () => {
    const idx = buildIndex([]);
    // cloud.aws.elb.* (classic ELBv1) has no new-connection equivalent per the
    // DAC entities reference — a stable "genuinely unmapped" example.
    const elb = canonical
      .replace(/dynamodb/g, 'elb')
      .replace(/successful_request_latency_by_operation/g, 'latency');
    const r = rewriteDql(elb, idx);
    // Not converted → still has the classic custom_device lookup → bails.
    assert.match(r.rewritten, /lookup \[fetch dt\.entity\.custom_device/);
    assert.ok(r.warnings.some((w) => /no Smartscape node type is mapped for it/.test(w.text)));
  });

  it('does not touch queries without the credential-lookup idiom', () => {
    const idx = buildIndex([]);
    const plain = 'timeseries avg(cloud.aws.ec2.cpu_usage), by:{dt.entity.ec2_instance}';
    const r = rewriteDql(plain, idx);
    assert.doesNotMatch(r.rewritten, /smartscapeNodes AWS_ACCOUNT/);
  });
});

describe('rewriteDql — by-clause non-carrier alignment', () => {
  it('warns (non-blocking) when a genuine non-carrier smartscape dim is used in by:{...}', () => {
    // AWS_APIGATEWAYV2_API is the one type we can't re-verify as a carrier
    // (no live data on the probe tenant), so it stays in the non-carrier set.
    const idx = buildIndex([
      {
        service: 'ApiGatewayV2',
        classicMetricId: 'dt.cloud.aws.apigatewayv2.count',
        newDtMetricKey: 'cloud.aws.apigatewayv2.Count.By.ApiId',
        detectedRecipe: {
          classicAggregation: 'avg', newAggregation: 'avg', newAggregationMode: 'raw',
          scale: 1, verdict: 'exact-fit', pearsonR: 0.99, residualSmape: 0.01,
        } as any,
      },
    ]);
    const input =
      'timeseries avg(dt.cloud.aws.apigatewayv2.count), by:{dt.smartscape.aws_apigatewayv2_api}';
    const r = rewriteDql(input, idx);
    const w = r.warnings.find((w) => /isn't carried/i.test(w.text));
    assert.ok(w, 'expected a non-carrier warning with concrete substitution');
    assert.equal(w!.kind, 'dim-not-carried', 'should use its own kind, not unmapped-entity-type');
    assert.ok(/dt\.smartscape\.aws_apigatewayv2_api/.test(w!.text));
    assert.ok(/ApiId/.test(w!.text), 'should suggest the CloudWatch dim from the .By.<Dim> suffix');
    // The DQL still runs (only the grouping degrades) — this is a verify-me
    // caveat, not a blocker, so it must NOT count against the conversion rate.
    assert.equal(isBlockingWarning('dim-not-carried'), false);
  });

  it('does NOT warn for ECS — re-verified as a carrier 2026-06-17 (was stale non-carrier)', () => {
    const idx = buildIndex([
      {
        service: 'ECS',
        classicMetricId: 'dt.cloud.aws.ecs.cpu.utilization',
        newDtMetricKey: 'cloud.aws.ecs.CPUUtilization.By.ClusterName.ServiceName',
        detectedRecipe: {
          classicAggregation: 'avg', newAggregation: 'avg', newAggregationMode: 'raw',
          scale: 1, verdict: 'exact-fit', pearsonR: 0.99, residualSmape: 0.01,
        } as any,
      },
    ]);
    const r = rewriteDql(
      'timeseries avg(dt.cloud.aws.ecs.cpu.utilization), by:{dt.smartscape.aws_ecs_cluster}',
      idx
    );
    assert.ok(
      !r.warnings.some((w) => /isn't carried/i.test(w.text)),
      'ECS now carries dt.smartscape.aws_ecs_cluster (287 distinct cluster buckets on nic55601)'
    );
  });

  it('does not warn for carrier smartscape dims (AWS_LAMBDA_FUNCTION)', () => {
    const idx = buildIndex([
      {
        service: 'Lambda',
        classicMetricId: 'dt.cloud.aws.lambda.invocations',
        newDtMetricKey: 'cloud.aws.lambda.Invocations.By.FunctionName',
        detectedRecipe: {
          classicAggregation: 'sum', newAggregation: 'sum', newAggregationMode: 'raw',
          scale: 1, verdict: 'exact-fit', pearsonR: 0.99, residualSmape: 0.01,
        } as any,
      },
    ]);
    const r = rewriteDql(
      'timeseries sum(dt.cloud.aws.lambda.invocations), by:{dt.entity.aws_lambda_function}',
      idx
    );
    assert.ok(
      !r.warnings.some((w) => /isn't carried/i.test(w.text)),
      'should not warn — AWS_LAMBDA_FUNCTION IS a carrier'
    );
  });
});

describe('rewriteDql — DAC fallback for keys missing from recipe mapping', () => {
  it('resolves an unmapped classic key via DAC and emits a metric-key swap warning', () => {
    const baseIdx = buildIndex([]);
    // Manually inject a DAC index so we don't depend on the JSON file path
    // (kept tiny for the test).
    const dac = new Map();
    const dacEntry = {
      cloudwatchNamespace: 'AWS/Lambda',
      cloudwatchMetricName: 'Invocations',
      cloudwatchDimensions: ['FunctionName'],
      secondGenMetricKey: 'ext:cloud.aws.lambda.invocationsSum',
      dacRecommendedMetricKey: 'cloud.aws.lambda.Invocations.By.FunctionName',
      dacAutodiscoveredMetricKey: 'cloud.aws.lambda.Invocations.By.FunctionName',
      builtInMetricKey: 'not-matched',
      endOfLife: false,
    };
    dac.set('ext:cloud.aws.lambda.invocationsSum', dacEntry);
    dac.set('cloud.aws.lambda.invocations_sum', dacEntry);
    const idx = { ...baseIdx, dac: { byClassicKey: dac, statisticByLiveBase: new Map() } };

    const r = rewriteDql('timeseries sum(cloud.aws.lambda.invocations_sum)', idx);
    assert.match(r.rewritten, /cloud\.aws\.lambda\.Invocations\.By\.FunctionName/);
    // DAC results are exposed as `mapped-no-recipe` warnings — we still want
    // the user to know aggregation/scale was NOT verified by our recipe path.
    assert.ok(r.warnings.some((w) => w.kind === 'mapped-no-recipe'));
  });

  it('emits an end-of-life-service warning when the DAC entry is EOL', () => {
    const baseIdx = buildIndex([]);
    const dac = new Map();
    dac.set('ext:cloud.aws.opsworks.cpuIdleSum', {
      cloudwatchNamespace: 'AWS/OpsWorks',
      cloudwatchMetricName: 'cpu_idle',
      cloudwatchDimensions: ['StackId'],
      secondGenMetricKey: 'ext:cloud.aws.opsworks.cpuIdleSum',
      dacRecommendedMetricKey: 'not-matched',
      dacAutodiscoveredMetricKey: 'cloud.aws.opsworks.CpuIdle.By.StackId',
      builtInMetricKey: 'not-matched',
      endOfLife: true,
    });
    const idx = { ...baseIdx, dac: { byClassicKey: dac, statisticByLiveBase: new Map() } };

    const r = rewriteDql('timeseries sum(ext:cloud.aws.opsworks.cpuIdleSum)', idx);
    // Pre-baked slug lookup already covers OpsWorks; either way an EOL warning fires.
    assert.ok(r.warnings.some((w) => w.kind === 'end-of-life-service'));
  });

  // The DAC encodes each new metric's CloudWatch statistic in secondGenMetricKey
  // (e.g. `…invocationsSum` → Sum). An additive Sum counter aggregated with avg()
  // is auto-corrected to sum(); a gauge the DAC also labels Sum (concurrency,
  // provisioned capacity, host counts) is left as-is and warned.
  function sumMetricIdx(classicKey: string, liveKey: string) {
    const dac = new Map();
    const dacEntry = {
      cloudwatchNamespace: 'AWS/Lambda', cloudwatchMetricName: 'X',
      cloudwatchDimensions: ['FunctionName'],
      secondGenMetricKey: 'ext:placeholderSum',
      dacRecommendedMetricKey: liveKey,
      dacAutodiscoveredMetricKey: liveKey,
      builtInMetricKey: 'not-matched', endOfLife: false,
    };
    dac.set(classicKey, dacEntry);
    const base = liveKey.replace(/\.By\..*$/, '').toLowerCase();
    const statisticByLiveBase = new Map([[base, 'Sum']]);
    return { ...buildIndex([]), dac: { byClassicKey: dac, statisticByLiveBase } };
  }
  const INV = ['dt.cloud.aws.lambda.invocations', 'cloud.aws.lambda.Invocations.By.FunctionName'] as const;

  it('auto-corrects avg()→sum() for an additive Sum counter (Lambda Invocations)', () => {
    const r = rewriteDql('timeseries avg(dt.cloud.aws.lambda.invocations)', sumMetricIdx(...INV));
    assert.match(r.rewritten, /sum\(`cloud\.aws\.lambda\.Invocations\.By\.FunctionName`\)/);
    assert.ok(r.transforms.some((t) => t.kind === 'aggregation-corrected'), 'expected an aggregation-corrected transform');
    assert.ok(!r.warnings.some((x) => x.kind === 'aggregation-mismatch'), 'flipped — should not also warn');
  });

  it('realigns a downstream column ref when the aggregation is auto-corrected', () => {
    const r = rewriteDql(
      'timeseries avg(dt.cloud.aws.lambda.invocations) | fields `avg(dt.cloud.aws.lambda.invocations)`',
      sumMetricIdx(...INV)
    );
    assert.ok(!/avg\(dt\.cloud\.aws\.lambda\.invocations\)/.test(r.rewritten), 'stale avg(classic) ref should be realigned');
    assert.match(r.rewritten, /sum\(cloud\.aws\.lambda\.Invocations\.By\.FunctionName\)/);
  });

  it('does NOT auto-correct or warn when the metric is already summed', () => {
    const r = rewriteDql('timeseries sum(dt.cloud.aws.lambda.invocations)', sumMetricIdx(...INV));
    assert.ok(!r.warnings.some((x) => x.kind === 'aggregation-mismatch'));
    assert.ok(!r.transforms.some((t) => t.kind === 'aggregation-corrected'));
  });

  it('warns (no flip) for a gauge-like Sum metric (ConcurrentExecutions)', () => {
    const idx = sumMetricIdx('dt.cloud.aws.lambda.conc_executions', 'cloud.aws.lambda.ConcurrentExecutions.By.FunctionName');
    const r = rewriteDql('timeseries avg(dt.cloud.aws.lambda.conc_executions)', idx);
    assert.ok(r.warnings.some((x) => x.kind === 'aggregation-mismatch'), 'gauge-like Sum metric should warn, not flip');
    assert.equal(isBlockingWarning('aggregation-mismatch'), false);
    assert.match(r.rewritten, /avg\(`cloud\.aws\.lambda\.ConcurrentExecutions\.By\.FunctionName`\)/);
    assert.ok(!r.transforms.some((t) => t.kind === 'aggregation-corrected'));
  });

  it('does NOT warn aggregation-mismatch for a non-Sum (Average) statistic', () => {
    const dac = new Map();
    const dacEntry = {
      cloudwatchNamespace: 'AWS/EC2', cloudwatchMetricName: 'CPUUtilization',
      cloudwatchDimensions: ['InstanceId'],
      secondGenMetricKey: 'ext:cloud.aws.ec2.cpuUtilizationAverage',
      dacRecommendedMetricKey: 'cloud.aws.ec2.CPUUtilization.By.InstanceId',
      dacAutodiscoveredMetricKey: 'cloud.aws.ec2.CPUUtilization.By.InstanceId',
      builtInMetricKey: 'not-matched', endOfLife: false,
    };
    dac.set('dt.cloud.aws.ec2.cpu.usage', dacEntry);
    const statisticByLiveBase = new Map([['cloud.aws.ec2.cpuutilization', 'Average']]);
    const idx = { ...buildIndex([]), dac: { byClassicKey: dac, statisticByLiveBase } };
    const r = rewriteDql('timeseries avg(dt.cloud.aws.ec2.cpu.usage)', idx);
    assert.ok(!r.warnings.some((x) => x.kind === 'aggregation-mismatch'));
  });
});

describe('rewriteDql — extra-mappings (manual + per-key) fallback', () => {
  it('resolves an abbreviated manual mapping (cloud.aws.alb.bytes) and applies the metric-key swap', () => {
    const baseIdx = buildIndex([]);
    const manualEntry = {
      classicKey: 'cloud.aws.alb.bytes',
      newKey: 'cloud.aws.applicationelb.ProcessedBytes.By.LoadBalancer',
      availability: 'autodiscovered' as const,
      source: 'manual' as const,
    };
    const idx = {
      ...baseIdx,
      extra: {
        byKey: new Map([['cloud.aws.alb.bytes', manualEntry]]),
        byLowerKey: new Map([['cloud.aws.alb.bytes', manualEntry]]),
      },
    };
    const r = rewriteDql('timeseries avg(cloud.aws.alb.bytes)', idx);
    assert.match(r.rewritten, /cloud\.aws\.applicationelb\.ProcessedBytes\.By\.LoadBalancer/);
    const note = r.warnings.find((w) => w.kind === 'mapped-no-recipe');
    assert.ok(note);
    assert.match(note!.text, /manual-metric-mappings/);
  });

  it('resolves a per-key lookup with case-insensitive match (CamelCase v2 key vs lowercased per-key store)', () => {
    const baseIdx = buildIndex([]);
    const perKeyEntry = {
      classicKey: 'ext:cloud.aws.lambda.invocationssum',
      newKey: 'cloud.aws.lambda.Invocations.By.FunctionName',
      availability: 'recommended' as const,
      source: 'per-key' as const,
    };
    const idx = {
      ...baseIdx,
      extra: {
        // Only the lowercased index has the key — exact-match miss simulates
        // a dashboard that preserved CamelCase from the v2 API era.
        byKey: new Map(),
        byLowerKey: new Map([['ext:cloud.aws.lambda.invocationssum', perKeyEntry]]),
      },
    };
    const r = rewriteDql('timeseries sum(ext:cloud.aws.lambda.InvocationsSum)', idx);
    assert.match(r.rewritten, /cloud\.aws\.lambda\.Invocations\.By\.FunctionName/);
    const note = r.warnings.find((w) => w.kind === 'mapped-no-recipe');
    assert.ok(note);
    assert.match(note!.text, /per-key-mappings/);
  });

  it('prefers the recipe table over extra-mappings when both have the key', () => {
    const idx = buildIndex([cpuEntry]);
    // Add an extra-mapping entry for the same key — recipe should still win.
    const extra = {
      byKey: new Map([
        [
          'builtin:cloud.aws.ec2.cpu.usage',
          {
            classicKey: 'builtin:cloud.aws.ec2.cpu.usage',
            newKey: 'cloud.aws.SHOULD_NOT_USE_THIS.By.Whatever',
            availability: 'recommended' as const,
            source: 'manual' as const,
          },
        ],
      ]),
      byLowerKey: new Map(),
    };
    const r = rewriteDql('timeseries avg(builtin:cloud.aws.ec2.cpu.usage)', { ...idx, extra });
    // Recipe target wins; extra-mapping ignored.
    assert.match(r.rewritten, /cloud\.aws\.ec2\.CPUUtilization\.By\.InstanceId/);
    assert.doesNotMatch(r.rewritten, /SHOULD_NOT_USE_THIS/);
  });
});

describe('rewriteDql — EOL service warnings', () => {
  it('emits an end-of-life-service warning when the metric maps to a retiring service', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('timeseries avg(dt.cloud.aws.opsworks.stacks)', idx);
    const eol = r.warnings.find((w) => w.kind === 'end-of-life-service');
    assert.ok(eol, 'expected an EOL warning');
    assert.match(eol!.text, /OpsWorks/);
    assert.match(eol!.text, /2024-05-26/);
  });

  it('does not emit EOL warnings for healthy services', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('timeseries avg(dt.cloud.aws.ec2.cpu.usage)', idx);
    assert.ok(!r.warnings.some((w) => w.kind === 'end-of-life-service'));
  });
});

describe('rewriteDql — additional custom_device sub-types', () => {
  it('rewrites fetch custom_device + entity.type == "cloud:aws:s3" to smartscapeNodes AWS_S3_BUCKET', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'fetch dt.entity.custom_device | filter entity.type == "cloud:aws:s3"',
      idx
    );
    assert.match(r.rewritten, /smartscapeNodes AWS_S3_BUCKET/);
    assert.doesNotMatch(r.rewritten, /custom_device/);
  });

  it('rewrites cloud:aws:eks:cluster to AWS_EKS_CLUSTER', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'fetch dt.entity.custom_device | filter entity.type == "cloud:aws:eks:cluster"',
      idx
    );
    assert.match(r.rewritten, /smartscapeNodes AWS_EKS_CLUSTER/);
  });

  it('rewrites cloud:aws:aurora to AWS_RDS_DBCLUSTER', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'fetch dt.entity.custom_device | filter entity.type == "cloud:aws:aurora"',
      idx
    );
    assert.match(r.rewritten, /smartscapeNodes AWS_RDS_DBCLUSTER/);
  });

  it('flags elastic_load_balancer as not-planned (Classic ELB has no new equivalent)', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('fetch dt.entity.elastic_load_balancer | fields id', idx);
    assert.match(r.rewritten, /fetch dt\.entity\.elastic_load_balancer/);
    assert.ok(
      r.warnings.some((w) => /no Smartscape replacement/i.test(w.text) || /not in the new connection/i.test(w.text))
    );
  });

  it('disambiguates by:{dt.entity.custom_device} via the metric service (no entity.type filter)', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'timeseries avg(cloud.aws.lambda.invocations_sum), by:{dt.entity.custom_device}',
      idx
    );
    // entity wall cleared: custom_device → the typed Smartscape dim
    assert.match(r.rewritten, /by:\{dt\.smartscape\.aws_lambda_function\}/);
    assert.doesNotMatch(r.rewritten, /dt\.entity\.custom_device/);
    assert.ok(!r.warnings.some((w) => w.kind === 'unmapped-entity-type'));
    // single-node, high-confidence → no verify-me warning, so the panel can go clean
    assert.ok(!r.warnings.some((w) => w.kind === 'custom-device-disambiguated'));
    assert.ok(r.transforms.some((t) => /custom_device disambiguated/.test(t.detail ?? '')));
  });

  it('warns and defaults to the populated grain for a multi-node service (rds)', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'timeseries avg(cloud.aws.rds.cpu_utilization), by:{dt.entity.custom_device}',
      idx
    );
    assert.match(r.rewritten, /dt\.smartscape\.aws_rds_dbinstance/);
    const w = r.warnings.find((x) => x.kind === 'custom-device-disambiguated');
    assert.ok(w && /multiple node types/.test(w.text));
  });

  it('flags the remaining credential/account traversal after disambiguating', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'timeseries avg(cloud.aws.lambda.invocations_sum), by:{dt.entity.custom_device}\n' +
        '| fieldsAdd cred = entityAttr(dt.entity.custom_device, "accessible_by")[dt.entity.aws_credentials][0]',
      idx
    );
    assert.match(r.rewritten, /dt\.smartscape\.aws_lambda_function/);
    const w = r.warnings.find((x) => x.kind === 'custom-device-disambiguated');
    assert.ok(w && /credential\/account relationship/.test(w.text));
  });

  it('leaves custom_device untouched (not-planned) when the service is unresolvable', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('fetch dt.entity.custom_device | fields id, entity.name', idx);
    assert.match(r.rewritten, /dt\.entity\.custom_device/);
    assert.ok(r.warnings.some((w) => w.kind === 'unmapped-entity-type'));
  });
});

describe('rewriteDql — metric-key rewrite resilience', () => {
  it('realigns backtick column references to the swapped timeseries output column', () => {
    const idx = buildIndex([cpuEntry]);
    const input =
      'timeseries avg(builtin:cloud.aws.ec2.cpu.usage)\n' +
      '| fieldsAdd ratio = `avg(builtin:cloud.aws.ec2.cpu.usage)` * 2';
    const r = rewriteDql(input, idx);
    // The agg-call form gets rewritten.
    assert.match(r.rewritten, /avg\(`cloud\.aws\.ec2\.CPUUtilization\.By\.InstanceId`\)/);
    // The backtick column ref is REALIGNED to the new column name (no inner
    // backticks → no nesting), so the query stays valid.
    assert.match(r.rewritten, /`avg\(cloud\.aws\.ec2\.CPUUtilization\.By\.InstanceId\)`/);
    assert.doesNotMatch(r.rewritten, /`avg\(`/); // no nested backticks
    assert.doesNotMatch(r.rewritten, /`avg\(builtin:cloud\.aws\.ec2\.cpu\.usage\)`/); // stale ref gone
    // The realignment is recorded as a transform; the stale-ref warning is no
    // longer emitted because the ref was fixed in place.
    assert.ok(
      r.transforms.some((t) => /realigned/.test(t.detail ?? ''))
    );
    assert.ok(
      !r.warnings.some((w) => /column reference/i.test(w.text) && /will\s+return null/i.test(w.text))
    );
  });

  it('preserves count() instead of swapping to recipe newAggregation', () => {
    const idx = buildIndex([cpuEntry]);
    const r = rewriteDql('timeseries count(builtin:cloud.aws.ec2.cpu.usage)', idx);
    // count() stays count(), not avg() — even though cpuEntry's newAgg is avg.
    assert.match(r.rewritten, /count\(`cloud\.aws\.ec2\.CPUUtilization\.By\.InstanceId`\)/);
    assert.doesNotMatch(r.rewritten, /avg\(`cloud\.aws\.ec2/);
  });
});

describe('rewriteDql — end-to-end', () => {
  it('translates classicEntitySelector inside in(dim, ...) into a Smartscape filter', () => {
    const idx = buildIndex([cpuEntry]);
    const input =
      'timeseries cpu = avg(builtin:cloud.aws.ec2.cpu.usage), ' +
      'filter:{ in(dt.entity.ec2_instance, classicEntitySelector("type(ec2_instance),tag([AWS]env:prod)")) }, ' +
      'by:{ dt.entity.ec2_instance }';
    const r = rewriteDql(input, idx);

    // Metric key swapped.
    assert.match(r.rewritten, /cloud\.aws\.ec2\.CPUUtilization\.By\.InstanceId/);
    // by-dim swapped.
    assert.match(r.rewritten, /by:\{ dt\.smartscape\.aws_ec2_instance \}/);
    // classicEntitySelector replaced by tag filter.
    assert.doesNotMatch(r.rewritten, /classicEntitySelector/);
    assert.match(
      r.rewritten,
      /getNodeField\(dt\.smartscape\.aws_ec2_instance, "tags:aws"\)\[env\] == "prod"/
    );

    // Transform recorded.
    const cs = r.transforms.find((t) => t.kind === 'classic-selector');
    assert.ok(cs);
  });

  it('falls back to flagging when selector contains untranslatable predicates', () => {
    const idx = buildIndex([cpuEntry]);
    const input =
      'timeseries avg(builtin:cloud.aws.ec2.cpu.usage), ' +
      'filter:{ in(dt.entity.ec2_instance, classicEntitySelector("entityId(\\"EC2_INSTANCE-ABC\\")")) }, ' +
      'by:{ dt.entity.ec2_instance }';
    const r = rewriteDql(input, idx);

    // entityId is non-translatable → no clause emitted → original kept and flagged.
    assert.match(r.rewritten, /classicEntitySelector/);
    assert.ok(r.warnings.some((w) => w.kind === 'classic-entity-selector'));
  });

  it('handles classicEntitySelector against an already-rewritten dt.smartscape dim', () => {
    const idx = buildIndex([cpuEntry]);
    const input =
      'filter:{ in(dt.smartscape.aws_ec2_instance, classicEntitySelector("awsRegion(\\"us-east-1\\")")) }';
    const r = rewriteDql(input, idx);
    assert.match(
      r.rewritten,
      /getNodeField\(dt\.smartscape\.aws_ec2_instance, "aws\.region"\) == "us-east-1"/
    );
  });
});

describe('rewriteDql — AWS tag value-extraction idiom (Pass 2.5 tags + 2.55)', () => {
  it('maps entityAttr(x, "tags") to the provider-namespaced getNodeField(x, "tags:aws")', () => {
    const idx = buildIndex([]);
    const r = rewriteDql(
      'fetch dt.smartscape.aws_lambda_function | fieldsAdd t = entityAttr(dt.smartscape.aws_lambda_function, "tags")',
      idx
    );
    assert.match(r.rewritten, /getNodeField\(dt\.smartscape\.aws_lambda_function, "tags:aws"\)/);
    assert.doesNotMatch(r.rewritten, /entityAttr/);
  });

  it('collapses the splitString(toString(tags), "[AWS]Key:") idiom to a record read tags[Key]', () => {
    const idx = buildIndex([]);
    const input = 'fieldsAdd appci = splitString(splitString(toString(tags), "[AWS]ApplicationCI:")[1], "\\"")[0]';
    const r = rewriteDql(input, idx);
    assert.match(r.rewritten, /appci = tags\[ApplicationCI\]/);
    assert.doesNotMatch(r.rewritten, /splitString/);
  });

  it('end-to-end: a custom_device tag-extraction panel becomes node + tags:aws record reads', () => {
    const idx = buildIndex([]);
    const input =
      'timeseries avg(cloud.aws.lambda.invocations_sum), by:{dt.entity.custom_device}\n' +
      '| fieldsAdd tags = entityAttr(dt.entity.custom_device, "tags")\n' +
      '| fieldsAdd appci = splitString(splitString(toString(tags), "[AWS]ApplicationCI:")[1], "\\"")[0]\n' +
      '| fieldsAdd subci = splitString(splitString(toString(tags), "[AWS]subapplicationci:")[1], "\\"")[0]';
    const r = rewriteDql(input, idx);
    // entity disambiguated, tags record sourced from tags:aws, values read by key
    assert.match(r.rewritten, /by:\{dt\.smartscape\.aws_lambda_function\}/);
    assert.match(r.rewritten, /tags = getNodeField\(dt\.smartscape\.aws_lambda_function, "tags:aws"\)/);
    assert.match(r.rewritten, /appci = tags\[ApplicationCI\]/);
    assert.match(r.rewritten, /subci = tags\[subapplicationci\]/);
    assert.doesNotMatch(r.rewritten, /splitString|entityAttr|toString\(tags\)/);
  });
});

describe('rewriteDql — tag value-extraction idiom variants (Pass 2.55)', () => {
  it('handles a bare "<Key>:" delimiter (no [AWS] prefix)', () => {
    const idx = buildIndex([]);
    const input = 'fieldsAdd loc = splitString(splitString(toString(tags), "location:")[1], "\\"")[0]';
    const r = rewriteDql(input, idx);
    assert.match(r.rewritten, /loc = tags\[location\]/);
    assert.doesNotMatch(r.rewritten, /splitString/);
  });

  it('handles an inline getNodeField(...) as the toString arg', () => {
    const idx = buildIndex([]);
    const input =
      'fieldsAdd reg = splitString(splitString(toString(getNodeField(dt.smartscape.aws_ec2_instance, "tags:aws")), "Region:")[1], "\\"")[0]';
    const r = rewriteDql(input, idx);
    assert.match(r.rewritten, /reg = getNodeField\(dt\.smartscape\.aws_ec2_instance, "tags:aws"\)\[Region\]/);
    assert.doesNotMatch(r.rewritten, /splitString/);
  });
});

describe('rewriteDql — credential→account-id lookup (Pass 0.7)', () => {
  const idiom =
    'fetch dt.entity.custom_device\n' +
    '| filter entity.type == "cloud:aws:eks:cluster"\n' +
    '| fieldsAdd  aws_credentials=accessible_by[dt.entity.aws_credentials][0],  instance.id =entity.name\n' +
    '| lookup [fetch dt.entity.aws_credentials | fieldsadd name = entity.name, id, awsAccountId ], sourceField:aws_credentials, lookupField:id, prefix:"aws.credentials." | fieldsRename aws.account_id =  aws.credentials.awsAccountId\n' +
    '| summarize  count=count(), by: aws.account_id';

  it('collapses the credential lookup to the resource aws.account.id field', () => {
    const r = rewriteDql(idiom, buildIndex([]));
    assert.doesNotMatch(r.rewritten, /accessible_by\[/, 'accessible_by traversal removed');
    assert.doesNotMatch(r.rewritten, /dt\.entity\.aws_credentials/, 'aws_credentials fetch/ref removed');
    assert.doesNotMatch(r.rewritten, /aws\.credentials\.awsAccountId/, 'prefixed cred field rewired');
    assert.match(r.rewritten, /aws\.account\.id/);
    assert.ok(r.warnings.some((w) => w.kind === 'credential-collapsed'));
    // The credential traversal is no longer a blocker.
    assert.ok(!r.warnings.some((w) => w.kind === 'entity-relationship-traversal'));
    assert.ok(!isBlockingWarning('credential-collapsed'));
  });

  it('does NOT half-rewrite when the lookup prefix carries more than awsAccountId', () => {
    // aws.credentials.name is also consumed downstream → unsafe to collapse;
    // the result-guard must leave the query intact (no partial rewrite).
    const variant = idiom.replace('by: aws.account_id', 'by: {aws.account_id}\n| fields aws.account_id, aws.credentials.name');
    const r = rewriteDql(variant, buildIndex([]));
    // The result-guard must prevent Pass 0.7's collapse (its distinctive warning
    // is absent); the credential traversal stays for the generic handling.
    assert.ok(!r.warnings.some((w) => /credential→account-id lookup/.test(w.text)), 'Pass 0.7 must not collapse an unsafe variant');
  });
});

describe('rewriteDql — credential/account fieldsAdd idiom (Pass 0.6)', () => {
  it('resolves the account name via the native aws.account.name dimension (no lookups)', () => {
    const idx = buildIndex([]);
    const input =
      'timeseries avg(cloud.aws.lambda.invocations_sum), by:{dt.entity.custom_device}\n' +
      '| fieldsAdd dt.entity.aws_credentials = entityAttr(dt.entity.custom_device, "accessible_by")[dt.entity.aws_credentials][0]\n' +
      '| fieldsAdd awsAccount = lower(entityName(dt.entity.aws_credentials))';
    const r = rewriteDql(input, idx);
    assert.doesNotMatch(r.rewritten, /accessible_by/);
    assert.doesNotMatch(r.rewritten, /entityName\(/);
    assert.doesNotMatch(r.rewritten, /lookup \[/); // native dim — no lookups
    assert.match(r.rewritten, /by:\{dt\.smartscape\.aws_lambda_function, aws\.account\.name\}/);
    assert.match(r.rewritten, /fieldsAdd awsAccount = lower\(aws\.account\.name\)/);
    // Still surfaces the credential-vs-account breadth caveat.
    assert.ok(r.warnings.some((w) => /BROADER than the classic single-credential/.test(w.text)));
  });

  it('preserves a non-lower account assignment (native dim)', () => {
    const idx = buildIndex([]);
    const input =
      'timeseries avg(cloud.aws.dynamodb.x), by:{dt.entity.custom_device}\n' +
      '| fieldsAdd dt.entity.aws_credentials = entityAttr(dt.entity.custom_device, "accessible_by")[dt.entity.aws_credentials][0]\n' +
      '| fieldsAdd acct = entityName(dt.entity.aws_credentials)';
    const r = rewriteDql(input, idx);
    assert.match(r.rewritten, /fieldsAdd acct = aws\.account\.name/);
    assert.match(r.rewritten, /by:\{dt\.smartscape\.aws_dynamodb_table, aws\.account\.name\}/);
  });

  it('falls back to the AWS_ACCOUNT join when the by-clause has no resource to split on', () => {
    const idx = buildIndex([]);
    // by-clause groups only the source id (no custom_device) → can't inject the dim.
    const input =
      'timeseries avg(cloud.aws.lambda.invocations_sum), by:{dt.source_entity}\n' +
      '| fieldsAdd dt.entity.aws_credentials = entityAttr(dt.entity.custom_device, "accessible_by")[dt.entity.aws_credentials][0]\n' +
      '| fieldsAdd awsAccount = lower(entityName(dt.entity.aws_credentials))';
    const r = rewriteDql(input, idx);
    assert.match(r.rewritten, /lookup \[smartscapeNodes AWS_ACCOUNT \| fields name, aws\.account\.id\]/);
    assert.match(r.rewritten, /fieldsAdd awsAccount = lower\(account\.name\)/);
  });
});

describe('rewriteDql — AWS Metric Streams keys (migration-blocked)', () => {
  it('flags a camelCase multi-dim Metric Streams key distinctly from unknown-metric', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('timeseries avg(cloud.aws.kafka.cpuUserByAccountIdBrokerIDClusterNameRegion)', idx);
    const w = r.warnings.find((x) => x.kind === 'metric-streams-blocked');
    assert.ok(w, 'expected a metric-streams-blocked warning');
    assert.match(w!.text, /Metric Streams/);
    assert.ok(!r.warnings.some((x) => x.kind === 'unknown-metric'));
    assert.match(r.rewritten, /cloud\.aws\.kafka\.cpuUserByAccountIdBrokerIDClusterNameRegion/); // left unchanged
  });

  it('does NOT flag a classic snake_case unknown key as Metric Streams', () => {
    const idx = buildIndex([]);
    const r = rewriteDql('timeseries avg(cloud.aws.foo.some_unmapped_metric_sum)', idx);
    assert.ok(r.warnings.some((x) => x.kind === 'unknown-metric'));
    assert.ok(!r.warnings.some((x) => x.kind === 'metric-streams-blocked'));
  });
});

describe('isBlockingWarning classification', () => {
  it('marks no-equivalent / manual-required kinds as blocking', () => {
    for (const k of ['unmapped-entity-type','unknown-metric','metric-streams-blocked','composite-formula-needed','classic-entity-selector','entity-relationship-traversal','classic-id-literal'] as const) {
      assert.equal(isBlockingWarning(k), true, k);
    }
  });
  it('marks verify-me caveats on converted output as non-blocking', () => {
    for (const k of ['mapped-no-recipe','recipe-aggregation-mismatch','verdict-not-exact','dim-variant-override','custom-device-disambiguated','credential-collapsed','end-of-life-service'] as const) {
      assert.equal(isBlockingWarning(k), false, k);
    }
  });
});
