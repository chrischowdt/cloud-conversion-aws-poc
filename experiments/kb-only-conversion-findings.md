# AWS Cloud-Integration Migration — Conversion Quality Experiment

**Tenant:** nic55601 (lower) · **Date:** 2026-09-18

## Purpose

We wanted to know how much of our conversion quality comes from the shipped Dynatrace
migration guidance, and how much comes from knowledge we've accumulated by testing
against a live tenant. So we took two already-migrated dashboards, went back to the
genuine pre-conversion originals, and re-converted them using **only** the product
knowledgebase — then compared three versions of each tile against live data.

## TL;DR

1. **The knowledgebase alone does not produce working dashboards for our harder cases.**
   One of the two test dashboards came out as **invalid DQL** (HTTP 400); the other came
   out parseable but returning **zero rows**.
2. **A published, reviewer-approved dashboard is currently broken in production.**
   `EQY-Metrics` has 48 tiles using a conversion pattern that returns no data. Verified
   live: classic returns data, the published version returns none.
3. **Classic and Smartscape hold *different names* for the same service.** Any filter
   matching on entity name does not port across, regardless of syntax. This is the
   subtlest failure we've found and it affects hand-written conversions.
4. Failures in this migration are overwhelmingly **silent** — the query parses, runs, and
   returns nothing. That is why review alone doesn't catch them.

---

## Method

| Version | Source |
|---|---|
| **CLASSIC** | the genuine pre-cutover dashboard, snapshotted immediately before promotion |
| **HAND-DONE** | our automated rewrite plus reviewer edits — i.e. what we actually published |
| **KB-ONLY** | re-converted from CLASSIC applying only rules cited in the product knowledgebase |

The KB-ONLY converter implements **only** transformations traceable to a knowledgebase
file, and logs the citation for each. It does not use our rewriter, our
empirically-derived lookup tables, or anything learned from probing the tenant. Where the
knowledgebase has no rule, the construct was **left untouched** and counted, rather than
guessed at — so the result measures the guidance, not the person applying it.

Test dashboards were chosen to exercise different rule sets:

- **EQY-Metrics** — 74 tiles, 99 `classicEntitySelector` uses, APM-service filtering
- **AAP : JET : Dynamo DB Metrics** — 54 tiles, 54 credential-lookup chains

Both KB-ONLY results are staged in the tenant as **`[KB-ONLY TEST — DO NOT USE] …`** so
they can be inspected. They are test artifacts and should not be promoted.

---

## Results

| | EQY-Metrics | AAP JET DynamoDB |
|---|---|---|
| Tiles compared | 74 | 27 |
| KB-ONLY output matched HAND-DONE | **15** | **0** |
| Constructs with no knowledgebase rule | 51 selector predicates, 11 metric keys | 54 entity refs, 33 metric keys, 27 relationships |
| KB-ONLY runs successfully? | parses, returns 0 rows | **HTTP 400 — invalid DQL** |

### What the knowledgebase *does* handle well

The mechanical renames are correct and complete: `fetch dt.entity.X` →
`smartscapeNodes <TYPE>`, `entity.name` → `name`, `awsAccountId` → `aws.account.id`, and
its metric-mapping tables resolve a good share of keys. If a dashboard is only doing
those things, the guidance is sufficient.

---

## Finding 1 — AAP JET: knowledgebase conversion is invalid DQL

The dashboard's 54 tiles all use the credential-lookup idiom
(`accessible_by[dt.entity.aws_credentials]`) to resolve an AWS account name.

Live result for tile 0:

```
KB-ONLY   →  DQL 400  FIELD_DOES_NOT_EXIST: "name"
HAND-DONE →  returns data (Latency 19.14)
```

Two gaps caused it:

- **No rewrite for `accessible_by[...]`.** The guidance names `traverse` / `references` /
  `smartscapeEdges` as the replacement concepts but gives no concrete transformation for
  this idiom. Applying the available rules mechanically yields a classic relationship
  projection containing a Smartscape dimension, which is invalid.
- **No way to disambiguate a bare `dt.entity.custom_device`.** The knowledgebase maps
  custom-device *sub-types* (`cloud:aws:dynamodb` → `AWS_DYNAMODB_TABLE`), but these
  queries carry no `entity.type` filter. Our converter resolves the type from the
  **metric service** in the query (`cloud.aws.dynamodb.*` → `AWS_DYNAMODB_TABLE`) — a
  technique that is not in the guidance.

This is arguably the *better* failure mode: it fails loudly.

---

## Finding 2 — EQY-Metrics is published and broken

This one is a production issue, independent of the experiment.

Tile 6, verified against the live tenant:

| Version | Rows returned |
|---|---|
| CLASSIC (original) | **1** |
| HAND-DONE (**currently published**) | **0** |
| KB-ONLY | **0** |

The published tile has **two independent defects**:

**a) `tags:aws` on a service is always null.**

```
getNodeField(dt.smartscape.service, "tags:aws")[applicationci] == "cuw"   →  0 rows
```

Smartscape `SERVICE` nodes carry **no AWS tag field at all** — `0 of 24,426` services
have a non-null `tags:aws`. The pattern was copied from the AWS-resource conversions,
where it is correct. On a service it can never match.

A working equivalent, verified at exact parity:

```
in("applicationci:cuw", entityAttr(dt.entity.service, "tags"))            →  1 row
```

**b) The name predicate uses `~` as if it were "contains".**

```
getNodeField(dt.smartscape.service, "name") ~ " United.Mobile.…"  →  0 rows
getNodeField(dt.smartscape.service, "name") ~ "United.Mobile.…"   →  1 row
```

`~` is a match, not a substring test, so the leading space in the transcribed string
matches nothing.

### Scope of (a)

Sweeping the reviewed copies for this pattern:

| | assets | tiles |
|---|---|---|
| Contain the pattern | 5 | — |
| **Published (live)** | **3** | **51** |

`EQY-Metrics` (48 tiles), `EDJ-Partner Management` (2), `FOP AWS EMR` (1).
`EBQ - Flight Inventory Dashboard - QA` has it but is still in review.

**Recommended action:** re-convert those three and re-publish. The tiles render without
error today, so nobody will report them.

---

## Finding 3 — classic and Smartscape names differ for the same service

While investigating (b) we found something more general. For one service:

```
CLASSIC entity name : "cuw-qa-mtrvl-1-blu-liveactivity - United.Mobile.Services.LiveActivity.Api"
SMARTSCAPE node name: "United.Mobile.Services.LiveActivity.Api"
```

Classic composes a prefix into the name; Smartscape does not. So **any filter matching on
entity name changes meaning when converted**, even with perfectly correct syntax. A
`contains("… - United.Mobile")` filter that worked classically will match nothing against
the Smartscape name, and vice versa.

This also explains why two syntactically reasonable conversions behave differently:

- Reading the **classic** name (`entityName(dt.entity.service)`) preserves the original
  matching behaviour, at the cost of keeping a classic dependency.
- Reading the **Smartscape** name (`getNodeField(dt.smartscape.service, "name")`) is the
  "more migrated" form but silently changes which entities match.

Worth checking anywhere name-based filtering is used. Note this is one verified example,
not a measured population — we have not yet quantified how many services differ.

---

## What each path gets you

| Path | AAP JET | EQY-Metrics |
|---|---|---|
| Knowledgebase only | invalid DQL | 0 rows |
| Automated rewrite + human review | **correct** | **0 rows (published)** |
| Automated rewrite, current version | **correct** | **correct** |

The pattern across all of this work: losses are not where the documentation is silent —
people notice those. They are where a documented-looking form **parses and returns
nothing**.

---

## Recommendations

1. **Fix the three published dashboards** carrying the service `tags:aws` pattern (51 tiles).
2. **Treat "returns zero rows" as a failure, not a pass.** Reviewing a converted
   dashboard by eye cannot distinguish an empty tile from a correct one. A row-count
   comparison against the classic query before publishing would have caught every issue
   in this report.
3. **Feed these back to the product team.** Specifically: no rewrite for the credential
   chain; no way to disambiguate a bare `custom_device`; no guidance that Smartscape
   `SERVICE` nodes lack tag fields; no mention that entity names differ between models.
   The cloud-integration guidance also has no `classicEntitySelector` coverage — that
   lives in a sibling skill, which is a discoverability problem rather than a gap.
4. **Do not promote the `[KB-ONLY TEST — DO NOT USE]` dashboards.** Delete them when the
   experiment has been reviewed.

---

## Limits of this experiment

- **Two dashboards**, chosen for difficulty. They are not a random sample, and the
  knowledgebase would score better on simpler assets — its mechanical rules are sound.
- The KB-ONLY conversion was produced by a script applying cited rules mechanically. A
  careful engineer following the same guidance would likely stop when a rule ran out
  rather than emit an invalid hybrid — so "invalid DQL" should be read as *"the guidance
  does not get you to a working query"*, not *"a person would ship this"*.
- The same author built both the KB-ONLY converter and the production rewriter, so
  perfect isolation isn't achievable. Mitigated by requiring a citation per rule; the
  live query results above do not depend on it.
- Comparisons are per-tile against live data at a point in time. Row counts on sparse AWS
  metrics can vary by window; the zero-vs-nonzero results here were stable and
  re-verified.
