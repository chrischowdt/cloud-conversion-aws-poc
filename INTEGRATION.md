# Integration: cloud-conversion mapping × dt-migration skill

This project produces a **metric-key mapping with conversion recipes**. The Dynatrace R&D `dt-migration` skill in [`dt-migration/`](dt-migration/) produces **entity-reference migration** rules. Together they cover end-to-end migration of classic Dynatrace AWS dashboards and alerts to the new (Smartscape) world.

Neither piece handles a real query alone.

## What each side covers

| Concern | This project | dt-migration skill |
|---|---|---|
| Metric key translation | ✓ ([`mappings/aws_mapping.with_recipes.json`](mappings/aws_mapping.with_recipes.json)) | — |
| Per-pair aggregation/scale recipe | ✓ (`detectedRecipe` field per row) | — |
| Composite formulas (e.g. `consumed/provisioned*100`) | ✓ ([`mappings/manual_recipes.json`](mappings/manual_recipes.json), unverified) | — |
| `dt.entity.*` → `dt.smartscape.*` signal dimension swap | — | ✓ ([`dt-migration/references/dql-function-migration.md`](dt-migration/references/dql-function-migration.md)) |
| `entityName()`, `entityAttr()`, `classicEntitySelector()` | — | ✓ |
| `belongs_to[...]`, `runs[...]`, `instance_of[...]` → `traverse` | — | ✓ |
| Mass-data filter rewriting (`fieldsSnapshot` workflow) | — | ✓ ([`dt-migration/references/mass-data-filtering-strategy.md`](dt-migration/references/mass-data-filtering-strategy.md)) |
| Edge availability / relationship validation | — | ✓ ([`dt-migration/references/relationship-mappings.md`](dt-migration/references/relationship-mappings.md)) |
| Special cases: host group, process group, container group | — | ✓ |

## End-to-end example

A classic Dynatrace dashboard tile:

```dql
timeseries cpu = avg(builtin:cloud.aws.ec2.cpu.usage),
  filter:{ in(dt.entity.ec2_instance,
    classicEntitySelector("type(ec2_instance),tag([Environment]env:prod)")) },
  by:{ dt.entity.ec2_instance }
```

Migration steps:

### Step 1 — replace the metric key (this project)

Look up `builtin:cloud.aws.ec2.cpu.usage` in [`mappings/aws_mapping.with_recipes.json`](mappings/aws_mapping.with_recipes.json):

```json
{
  "classicMetricId": "builtin:cloud.aws.ec2.cpu.usage",
  "newDtMetricKey": "cloud.aws.ec2.CPUUtilization.By.InstanceId",
  "detectedRecipe": {
    "classicAggregation": "avg",
    "newAggregation": "avg",
    "newAggregationMode": "raw",
    "scale": 1.0006,
    "verdict": "exact-fit",
    "pearsonR": 0.992,
    "source": "detect-per-resource"
  }
}
```

Apply: replace the metric key, keep `avg()`, no scaling needed (scale ≈ 1.0).

### Step 2 — migrate the entity reference (dt-migration skill)

From [`dt-migration/references/type-mappings.md`](dt-migration/references/type-mappings.md):

```
dt.entity.ec2_instance  →  dt.smartscape.aws_ec2_instance  (AWS_EC2_INSTANCE)
```

Apply everywhere the dimension appears: `by:`, `filter:`, `fieldsAdd`, etc.

### Step 3 — migrate the entity selector (dt-migration skill)

`classicEntitySelector("type(ec2_instance),tag([Environment]env:prod)")` is a Situation-1 mass-data filter. Following [`dt-migration/references/mass-data-filtering-strategy.md`](dt-migration/references/mass-data-filtering-strategy.md):

- Resolve conditions: `tag([Environment]env:prod)` → tag context `Environment`, key `env`, value `prod`
- The `tags:environment` field is on the `AWS_EC2_INSTANCE` Smartscape node
- Use Check 2: `getNodeField(dt.smartscape.aws_ec2_instance, "tags:environment")[env] == "prod"`

### Final migrated query

```dql
timeseries cpu = avg(cloud.aws.ec2.CPUUtilization.By.InstanceId),
  filter:{ getNodeField(dt.smartscape.aws_ec2_instance, "tags:environment")[env] == "prod" },
  by:{ dt.smartscape.aws_ec2_instance }
```

Both rules had to fire. Without the skill, we'd have a metric query with broken entity references. Without our mapping, we'd have a working filter pointing at a metric key the new tenant doesn't recognize.

## Suggested architecture for a downstream rewriter

```
                  ┌──────────────────────────────┐
                  │  Customer's classic DQL      │
                  └──────────────┬───────────────┘
                                 ▼
   ┌─────────────────────────────────────────────────────┐
   │  Parser: identify metric keys, entity dims, classic │
   │  selectors, relationship traversals                 │
   └────────┬───────────────────────────────────┬────────┘
            ▼                                   ▼
  ┌────────────────────┐            ┌──────────────────────┐
  │ this project's     │            │ dt-migration skill   │
  │ mapping lookup     │            │ rules (per-construct)│
  │                    │            │                      │
  │ - new key          │            │ - dim swap           │
  │ - aggregation      │            │ - selector → filter  │
  │ - scale factor     │            │ - relation → traverse│
  │ - mode (raw/sec)   │            │ - id → toSmartscapeId│
  └─────────┬──────────┘            └──────────┬───────────┘
            ▼                                  ▼
   ┌─────────────────────────────────────────────────────┐
   │  Reassembler: emit migrated DQL with both transforms│
   │  applied + verification probe                        │
   └─────────────────────────────────────────────────────┘
```

The reassembler is out of scope for this project but the inputs are now ready for it.

## Where each piece lives

```
cloud-conversion/
├── INTEGRATION.md                           ← this file
├── mappings/
│   ├── aws_mapping.with_recipes.json        ← the metric+recipe table
│   ├── manual_recipes.json                  ← manual composite formulas
│   └── no_fit_punchlist.json                ← items needing manual research
├── dt-migration/                            ← R&D team's skill
│   ├── SKILL.md                             ← migration framework + decision tree
│   └── references/
│       ├── mass-data-filtering-strategy.md  ← Situations 1 & 2 strategy
│       ├── type-mappings.md                 ← entity type lookup table
│       ├── relationship-mappings.md         ← valid Smartscape edges
│       ├── dql-function-migration.md        ← per-function migration patterns
│       └── examples.md                      ← before/after pairs
├── reference/                               ← cloud-migration-helper team's data
│   ├── docs/dac-aws-to-2ndgen-metrics.json  ← upstream metric key catalog
│   └── ui/app/utils/                        ← App-side lookup utilities
└── tools/                                   ← our recipe-generation pipeline
    └── src/commands/                        ← detect, detect-per-resource, merge-recipes
```

## Where the project still has gaps

Even with both pieces wired, these aren't covered:

- **Custom Dynatrace formulas** (e.g. DynamoDB `capacityUnits` percentage) — manual seeds in [`mappings/manual_recipes.json`](mappings/manual_recipes.json) are unverified; the formula doesn't reconcile empirically against classic values
- **Management zones** — skill explicitly notes these are *not migratable* (access-control, no Smartscape equivalent)
- **Custom devices / custom device groups** — no Smartscape mapping planned
- **Container groups / process groups / host groups** — not standalone entities; see skill's special-cases reference for how to flatten these

Anything in the punchlist with `unknown-mismatch` or `composite-formula` likely needs human attention.

## Recipe schema reference

Each row in `aws_mapping.with_recipes.json` may carry:

```typescript
detectedRecipe?: {
  classicAggregation: 'avg' | 'sum' | 'max' | 'min';
  newAggregation: 'avg' | 'sum' | 'max' | 'min';
  newAggregationMode: 'raw' | 'per_second';   // divide by interval seconds when 'per_second'
  scale: number | null;                       // multiply new value by this to match classic
  verdict: 'exact-fit' | 'good-fit' | 'scale-only' | 'shape-only' | 'no-fit' | 'no-data';
  pearsonR: number | null;                    // shape correlation, 0-1
  residualSmape: number | null;               // residual after scaling, 0-2 (0 = perfect)
  detectedAt: string;
  detectedFromWindow: string;
  source: 'detect-per-resource' | 'detect-all' | 'manual';
  perResourceQualifying?: number;             // resources where this recipe matched
  perResourceTested?: number;
};

compositeFormula?: {
  formula: string;                            // e.g. "(consumed / provisioned) * 100"
  components: Array<{
    role: string;                             // "consumed" / "provisioned" / etc.
    newDtMetricKey: string;
    newAggregation: string;
    newAggregationMode?: 'raw' | 'per_second';
  }>;
  verified: boolean;                          // whether the formula has been empirically validated
  source: 'manual' | 'detect';
};
```

A consumer should:
1. Look up `classicMetricId` in `serviceMappings[].builtinMetricMappings[]`
2. If `compositeFormula` present and verified, use that and skip 3-4
3. Otherwise use `newDtMetricKey` + `detectedRecipe` to build the new query
4. Run the dt-migration skill rules on the rest of the query (entity dims, selectors, traversals)
