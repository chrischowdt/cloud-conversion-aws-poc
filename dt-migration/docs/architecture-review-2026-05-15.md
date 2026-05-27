# Architecture Review — `dt-migration-cloud` Skill

**Date:** 2026-05-15  
**Last updated:** 2026-05-18  
**Reviewer:** Senior Principal Architect (review pass)
**Scope:** End-to-end review of the `dt-migration-cloud` skill across the four phases (Discovery → Assessment → Guidance → Cutover), evaluated on three axes: **simplicity, reliability, consistency**.
**Constraint:** Must run reliably in two execution environments — local IDE (Python/bash) and Dynatrace Assist on the Dynatrace platform (today: DQL execution + file-read + settings/document/SLO read tools; no Python; no bash yet; TypeScript supported; a bash tool set is planned, and anything depending on it can be shipped now but must be marked **candidate** in the asset registry).

---

## TL;DR

The skill is **over-engineered for what it actually does**. Roughly half of the executable code (shell wrappers, the parallel `dtmigration/` Python package, the live-disambiguation script, the script that shells out N times to another script to rebuild an index) can be removed without any loss of capability, because:

1. **The model + first-class platform tools already cover Phase 1 and most of Phase 2.** Every DQL query in `discover-connections.sh` is already published verbatim in `references/discovery-queries.md`. DT Assist has native document/settings/SLO read tools that replace `scan-dependencies.sh`. The shell scripts duplicate knowledge that lives in markdown.
2. **The deterministic core is the JSON mapping database** (`dac-aws-to-2ndgen-metrics.json`, `dac-azure-to-2ndgen-metrics.json`, `end-of-life-services.json`, `manual-metric-mappings.json`). These are MD5-identical to the upstream helper repo and are the only thing that must remain code/data-driven (not model-inferred) for reliability. **Everything else around them is plumbing that the model can do.**
3. **Two parallel implementations** (`scripts/*.py` and `dtmigration/*.py`) cover overlapping responsibilities. This is the single largest reliability and consistency hazard in the skill today.
4. **Phase outputs are not contract-typed.** Each phase emits ad-hoc JSON files (run-manifest, detection, per-key-mappings, metric-disambiguation, ~10 raw scan files). Handover between phases works but is fragile and not auditable.
5. **GCP is structurally inconsistent** with AWS/Azure (different JSON shape, scripts hard-error). Once GCP mappings ship they must use the same shape.
6. **Reference markdown has drifted** from the helper-repo source of truth, while the large JSON mapping files have not. Keep the JSON authoritative and treat markdown as derived.

The recommended target architecture is **model-first with a thin deterministic core**: keep the JSON mappings, ship a single tiny lookup library (TypeScript for DT Assist parity; bash-tool candidate for IDE parity), delete the rest. Net effect: the skill becomes portable to DT Assist today and easier to maintain.

**Implementation status (as of last-updated date):**

| Step | Status | What was done |
|------|--------|---------------|
| Prep — define contracts | ✅ Done | `references/phase-output-contract.md`, `references/phase-output.schema.json`, `references/migration-plan-format.md` |
| Quick wins — delete wrappers | ✅ Done | `discover-connections.sh`, `scan-dependencies.sh`, `dtmigration/` deleted; `_DEFAULTS` removed; `metric-key-mapping.md` cross-reference added |
| Step 2 — pre-built index | ✅ Done | `scripts/build-per-key-mappings.py` added; `references/per-key-mappings.json` generated (5,709 entries); `--build-mappings` subprocess chain removed from `generate-migration-plan.py` |
| Step 3 — TypeScript port + Python deletion | ✅ Done | `scripts/migration-lookup.ts` (854 LoC, strict TypeScript, zero deps). Parity confirmed 149/149 checks against Python output across all asset types. All 6 Python scripts deleted. `scripts/` now contains only TypeScript. |
| Step 4 — GCP parity | ⏳ Pending | Awaiting GCP mapping database |
| Step 5 — authoritative source | ⏳ Pending | Communication to helper-repo owners |

---

## 1. Constraints and execution targets

| Capability                              | Local IDE | DT Assist (today) | DT Assist (planned bash tool) |
|------------------------------------------|-----------|--------------------|-------------------------------|
| Run DQL                                  | via `dtctl` | native             | native                        |
| Read files bundled in the skill          | yes        | yes                | yes                           |
| Read documents / settings / SLOs         | via `dtctl` | native tool        | native tool                   |
| Execute Python                           | yes        | **no**             | **no**                        |
| Execute bash                             | yes        | **no**             | yes (candidate-gated)         |
| Execute TypeScript                       | n/a in CLI | yes (DT Apps)      | yes                           |
| Hold a 50 k-row JSON in memory & index it | yes        | yes (file read + model) | yes                           |

The single most important consequence: **anything that today is implemented in Python is non-portable to DT Assist**. The portability gap is the right lens for every "do we really need this script?" question below.

---

## 2. Per-phase findings

### 2.1 Phase 1 — Discovery & Classification

**What existed** *(resolved — see implementation status in TL;DR)*
- ~~`scripts/discover-connections.sh` (138 lines)~~ — **deleted**
- `references/discovery-queries.md` (190 lines) — DQL queries with classification logic; now the single authoritative source for Phase 1.

**Finding — simplicity (severe over-engineering)**
The shell script adds *no information* that is not already in the markdown. It is a convenience wrapper for the local IDE workflow only. In DT Assist there is no shell to run it in, and the model can — and should — read the queries from `discovery-queries.md` and execute them via the DQL tool one at a time, collecting results into a single assessment report.

**Finding — reliability**
- The script invokes `dtctl query` and parses the JSON record count with an inline `python3 -c '...'`. That makes it depend on a Python interpreter just to print a number. This is brittle (Python presence, JSON shape assumptions) and silently masks query failures by writing `[]` and proceeding.
- The script swallows stderr into `.stderr` files but the downstream phases never read those files; failures are visible only to a human running the bash script.

**Finding — consistency**
- The queries hardcode `from:now()-12h`. The same window is repeated in the markdown. There is no single knob.
- GCP query coverage in the script matches the markdown (good). But the script's `case` for provider names is positional / brittle.

**Recommendation**
- **Delete `discover-connections.sh`.** Document Phase 1 as: "the model reads `references/discovery-queries.md`, runs each query via the DQL tool, and appends results to the consolidated assessment report." This works identically in IDE (DQL via `dtctl`) and DT Assist (native DQL tool).
- If a one-command experience is desired for the IDE, make `discovery-queries.md` machine-readable (front-matter `id`, `provider`, `dql` blocks). The skill harness can iterate; no shell needed.

---

### 2.2 Phase 2 — Dependency Assessment

**What existed / current state**
- ~~`scripts/scan-dependencies.sh` (17 lines)~~ — **deleted**
- ~~`dtmigration/` Python package (~680 LoC)~~ — **deleted** (no external callers)
- `scripts/detect-classic-patterns.py` (1025 lines) — regex-based pattern detection; `_DEFAULTS` fallback removed, now requires `classic-detection-patterns.json` (**QW-4 done**)
- `references/classic-detection-patterns.md` + `.json` — detection rules; JSON is now the sole source of truth
- `scripts/disambiguate-metrics.py` (221 lines) — live DQL probes; still Python-only (pending TS port)

**Finding — simplicity**
- **`scan-dependencies.sh` is a 17-line wrapper that adds nothing.** It exists only so a user does not have to type `python3 -m`. Delete it.
- **The `dtmigration/` package duplicates platform tooling.** In DT Assist there are first-class document, settings, and SLO read tools; in the IDE there is `dtctl`. Re-implementing the fetch layer in Python:
  - Is non-portable to DT Assist (no Python).
  - Forks a parallel codebase next to `scripts/*.py` for the same responsibilities (auth handling, output shaping).
  - Forces shell-based callers to depend on Python.
- **`detect-classic-patterns.py` is the gray zone.** Pattern detection across thousands of dashboard widgets *does* benefit from compiled regexes and deterministic execution; it is more than the model should be asked to do by hand at scale. But Python is the wrong host — it cannot run on DT Assist.

**Finding — reliability**
- **Two sources of truth for detection rules.** `classic-detection-patterns.json` is loaded at runtime, but the script also defines `_DEFAULTS` as a hardcoded fallback. If they diverge, behavior depends on which file path the script resolves at runtime — silent drift.
- **Importlib hacks.** `generate-assessment.py` and `generate-migration-plan.py` import the hyphenated files (`detect-classic-patterns.py`, `lookup-mapping.py`) via `importlib.util.spec_from_file_location`. This works, but couples module loading to filesystem layout and resists refactors.
- **Disambiguation uses `ThreadPoolExecutor(10)`** issuing live DQL probes against the tenant. This is the right approach (live verification is more reliable than static heuristics), but should be opt-in and clearly noted — it produces tenant load and is rate-sensitive.

**Finding — consistency**
- The scan asset list (dashboards / notebooks / alerts / SLOs / classic-dashboards) appears in **three** places: the SKILL.md prerequisites table, `dtmigration/scan.py`, and implicitly in `detect-classic-patterns.py` via the input filenames. Add a new asset type and you must update three.
- Output filenames are convention-based (`scan-dashboards.json`, etc.) — no schema, no manifest, no version field.

**Recommendation**
1. **Delete `scan-dependencies.sh` and the `dtmigration/` package.** In DT Assist, the model uses native read tools; in the IDE the model uses `dtctl` (the existing `dynatrace-control` skill already wraps it). Document the canonical fetch commands per-environment in markdown, then iterate.
2. **Keep detection deterministic, but reshape it.** Two options, pick one based on the timeline:
   - **Short-term:** Promote `classic-detection-patterns.json` to the *only* source of truth. Remove the `_DEFAULTS` block from `detect-classic-patterns.py`. Document the detection algorithm in markdown step-by-step so the model can execute it directly on small inputs (≤200 widgets). For larger inputs, the IDE still invokes the Python script — but mark this path "IDE-only" and tag the script as a **candidate** for the future bash tool runtime in the asset registry.
   - **Medium-term:** Port detection to a small TypeScript library that DT Assist can call. This is the only path that gives both environments the same deterministic detector. Inputs: arrays of strings (metric keys, entity types). Outputs: classification + disambiguation hints. ~300 LoC, no platform calls.
3. **Make disambiguation explicit.** Treat `disambiguate-metrics.py` as a Phase 2.5 optional step. Either port to TS or mark candidate; either way the underlying probe queries belong in `references/disambiguation.md` so a human (or the model) can rerun without a script.
4. **Single asset registry.** One YAML/JSON file enumerating "scan asset types"; SKILL.md, the (remaining) script, and the report generator all read from it.

---

### 2.3 Phase 3 — Migration Guidance & Remediation

**Current state**
- ~~`scripts/lookup-mapping.py`~~ — **deleted**. Canonical logic is `scripts/migration-lookup.ts`.
- ~~`scripts/generate-assessment.py`~~ — **deleted**.
- ~~`scripts/generate-migration-plan.py`~~ — **deleted**.
- ~~`scripts/build-per-key-mappings.py`~~ — **deleted**. Index is pre-built and shipped; regenerate manually from the DAC JSON files if they change (see `references/metric-key-mapping.md`).
- `scripts/migration-lookup.ts` — **the deterministic core**. Pure TS, zero deps, runs in DT Assist and Node.
- `references/per-key-mappings.json` — pre-built, 5,709 entries (4,001 AWS + 2,571 Azure + 116 manual overlay).
- `references/dac-aws-to-2ndgen-metrics.json` (~53 k entries), `dac-azure-to-2ndgen-metrics.json` (~46 k entries) — **Authoritative.** Owned by this repo.
- `references/manual-metric-mappings.json` — overlay; sole data source for abbreviated classic keys.
- `references/end-of-life-services.json` — authoritative, owned here.
- `references/dac-gcp-to-2ndgen-metrics.json` — different shape, 10 entries (known gap; Step 4).

**Finding — simplicity**
- **`generate-migration-plan.py --build-mappings` shells out N times to another Python script.** For each unique metric key, it spawns a subprocess. This is *the* clearest over-engineering symptom: a Python program invoking a Python program through the shell. It works because `lookup-mapping.py` is also a CLI, but the cost is correctness (fork overhead, error handling brittleness, partial JSON parsing) and performance (seconds to minutes on a real tenant).
- **The per-key index should be precomputed once at skill build time** (or on first use) and shipped as `per-key-mappings.json`, not regenerated by fork-and-pipe on every run.

**Finding — reliability**
- The 5-step fallback chain is the actual deterministic asset of Phase 3. It is well-isolated in `lookup-mapping.py` and matches the rules in `references/metric-key-mapping.md`. **This is the part of the skill worth keeping deterministic.**
- Two sources of truth again: `manual-metric-mappings.json` is read by `lookup-mapping.py` *and* the same manual mappings appear in `references/metric-key-mapping.md` as inline tables. Risk of drift.
- `lookup-mapping.py` exits with an error on GCP. This is honest (GCP mappings are not built yet), but it propagates upward: `generate-assessment.py` and `generate-migration-plan.py` then have to special-case GCP-or-error.

**Finding — consistency**
- The fallback chain logic is *implemented* in Python and *described* in `references/metric-key-mapping.md`. If a step changes, both must change. The markdown is intended to be the spec; treat it that way.
- The "Mode A" plan format is only documented inside `generate-migration-plan.py` (template strings). The plan structure should be a markdown reference doc that both the script and the model can target.

**Recommendation**
1. **Pre-build the per-key index at skill build time.** Generate `per-key-mappings.json` as part of the skill release pipeline (whatever publishes the skill); ship it. Drop the `--build-mappings` mode entirely. The runtime cost goes from N subprocess calls to one JSON load.
2. **Port the lookup chain to TypeScript** (≈200 LoC). This unblocks DT Assist *and* gives the IDE a path that does not require Python. Keep `lookup-mapping.py` as a thin wrapper around the same JSON inputs for the IDE-without-Node case — or drop it once the TS port lands.
3. **Until #2 ships, mark `lookup-mapping.py` and the assessment/plan generators as `runtime: ide-only, candidate-for-bash-tool` in the asset registry.** This is the user-stated policy for not-yet-portable assets.
4. **Promote `references/metric-key-mapping.md` to "the spec".** Remove inline fallback-chain comments from the Python source that paraphrase it; cite the markdown by section instead. Keep the manual-mapping overlay JSON as the only data source; remove the duplicate table from markdown (link to the JSON and one example).
5. **Define the plan output format in `references/migration-plan-format.md`.** Both the model (DT Assist path) and the script (IDE path) produce the same shape.

---

### 2.4 Phase 4 — Cutover & Validation

**What exists today**
- `references/cutover-guide.md` (287 lines) — setup, validation, removal procedure. Largely markdown-only.
- No dedicated scripts for cutover today (validation queries are documented inline).

**Finding**
Phase 4 is **already shaped the way the rest of the skill should be**: knowledge in markdown, queries documented, no shell wrappers, runs identically in IDE and DT Assist. It is the implicit reference architecture for the other phases.

**Recommendation**
- Make Phase 4's structure the template for Phases 1–3: queries live in markdown, the model is the executor, code only enters where determinism at scale demands it (Phase 2 detection, Phase 3 lookup).

---

## 3. Cross-cutting concerns

### 3.1 Two parallel Python codebases ✅ Fully resolved

~~`scripts/*.py` and `dtmigration/*.py` overlap.~~ Both deleted. `scripts/migration-lookup.ts` is the only executable code in the skill.

### 3.2 Authoritative source and documentation drift

`product-ai-knowledgebase` (this repo) is the authoritative source. The helper repo (`cloud-migration-helper`) is downstream.

The large JSON mapping files (`dac-aws-…`, `dac-azure-…`, `end-of-life-services.json`, `manual-metric-mappings.json`) are MD5-identical between the two repos today — that consistency must be preserved going forward by changing the skill copies first and letting the helper repo follow.

The markdown reference docs in the helper repo (`aws-classic.md`, `azure-classic.md`, `gcp-classic.md`, `aws-new.md`, `azure-new.md`, `gcp-new.md`, `dashboard-scanning.md`) differ from the skill versions. Because the skill is authoritative, those differences are either deliberate skill-specific framing or **drift in the helper repo that the helper repo owners need to reconcile**, not drift the skill needs to absorb. The helper repo also has a `dql-patterns.md` that the skill does not — re-evaluate whether its content belongs in the skill on its own merits, not because the helper repo has it.

**Recommendation:** publish the skill's `references/` (JSON + markdown) as the authoritative artifact. Helper-repo owners pull from here. No submodule or build-time import is needed in this direction.

### 3.3 GCP structural inconsistency

`dac-gcp-to-2ndgen-metrics.json` has a different shape (prefix-based with `status: confirmed|partial|no-mapping`) and only 10 entries. The scripts hard-error on GCP. This is acceptable as a known gap, but:

- When GCP mappings are built, they **must** adopt the same row-per-classic-key shape as AWS/Azure.
- Until then, document GCP as "Phase 3 falls back to heuristic markdown rules" rather than "Phase 3 errors out".

### 3.4 Phase handover is implicit

Phases share state through filenames in `./assessment/`. There is a `run-manifest.json` but no formal schema, no version field, no validation when a downstream phase loads upstream output.

**Recommendation:** adopt the phase-output contract defined in §6.1 — one growing markdown document with a structured front-matter manifest and a JSON schema for the machine-readable portions. Both the transitional Python and the target TypeScript library emit this shape; the DT Assist model appends to it directly.

### 3.5 Duplicate sources of truth — full inventory

| Knowledge                  | Source 1                              | Source 2                                | Hazard |
|----------------------------|---------------------------------------|------------------------------------------|--------|
| Detection rules            | `classic-detection-patterns.json`     | ~~`_DEFAULTS` in `detect-classic-patterns.py`~~ | ✅ Resolved — `_DEFAULTS` removed |
| Manual key overrides       | `manual-metric-mappings.json`         | tables in `metric-key-mapping.md`        | Medium — markdown now has explicit cross-reference; duplication noted for cleanup |
| Scan asset types           | SKILL.md table                        | ~~`dtmigration/scan.py`~~ + ~~script filenames~~ | ✅ Resolved — all Python deleted |
| Fallback chain logic       | `references/metric-key-mapping.md`    | ~~`lookup-mapping.py`~~                  | ✅ Resolved — `lookup-mapping.py` deleted; sole impl is `scripts/migration-lookup.ts` |
| Discovery DQL              | ~~`discover-connections.sh`~~         | `references/discovery-queries.md`        | ✅ Resolved — script deleted |

---

## 4. Recommended target architecture

```
dt-migration-cloud/
├─ SKILL.md                              ← phases described as model workflows
├─ references/
│  ├─ discovery-queries.md               ← Phase 1 (model executes)
│  ├─ classic-detection-patterns.json    ← Phase 2 (single source of truth)
│  ├─ classic-detection-patterns.md      ← human description, links to JSON
│  ├─ disambiguation.md                  ← live-probe queries, model executes
│  ├─ metric-key-mapping.md              ← fallback-chain spec
│  ├─ entity-type-mapping.md
│  ├─ migration-plan-format.md           ← output contract for Phase 3
│  ├─ cutover-guide.md                   ← Phase 4 (already correct)
│  ├─ dac-aws-to-2ndgen-metrics.json     ← authoritative, synced from helper
│  ├─ dac-azure-to-2ndgen-metrics.json   ← authoritative, synced from helper
│  ├─ dac-gcp-to-2ndgen-metrics.json     ← TODO: re-shape when built
│  ├─ end-of-life-services.json          ← authoritative, synced from helper
│  ├─ manual-metric-mappings.json        ← overlay
│  └─ per-key-mappings.json              ← pre-built at skill release time
├─ scripts/                                  ← single deterministic core
│  └─ migration-lookup.ts                ← detection + lookup, ~500 LoC
└─ docs/
   └─ architecture-review-2026-05-15.md  ← this file
```

**Gone:** `scripts/*.sh`, `dtmigration/`, `generate-*.py`, `disambiguate-metrics.py`, `lookup-mapping.py`, `detect-classic-patterns.py`.

**New:** `scripts/migration-lookup.ts` — a small TypeScript library that exposes `detect(input): Finding[]` and `lookup(key, provider): Mapping | null`. Pure functions over JSON inputs. Runs in DT Assist apps. Runs in Node for IDE users. No shell, no Python.

Because Node is assumed in the local IDE (decision §6.1), there is no Node-less fallback to maintain. The TS library is the single deterministic core for both targets.

---

## 5. Migration plan (current → target)

A pragmatic, non-breaking sequence:

1. ✅ **Quick wins (no behavior change).** *Done.*
   - ~~Delete `scan-dependencies.sh`~~ — deleted.
   - ~~Delete `discover-connections.sh`~~; SKILL.md Phase 1 updated to point at `discovery-queries.md` — done.
   - ~~Remove `_DEFAULTS` from `detect-classic-patterns.py`~~ — done; JSON is sole source of truth.
   - Added cross-reference in `metric-key-mapping.md` pointing to `manual-metric-mappings.json` as authoritative overlay.
   - New contract/spec docs created: `references/phase-output-contract.md`, `references/phase-output.schema.json`, `references/migration-plan-format.md`.

2. ✅ **Delete `dtmigration/` + replace `--build-mappings` subprocess chain.** *Done.*
   - ~~`dtmigration/`~~ deleted; ~~`scan-dependencies.sh`~~ deleted.
   - `scripts/build-per-key-mappings.py` added — single in-process pass, no subprocess calls.
   - `references/per-key-mappings.json` pre-built and shipped (5,709 entries).
   - `generate-migration-plan.py` stripped of all subprocess/build logic; loads pre-built index directly.

3. ✅ **TypeScript port + Python deletion.** *Done.*
   - `scripts/migration-lookup.ts` (854 LoC, strict TypeScript, zero deps). Exports: `loadDetectionPatterns`, `detectClassicMetrics`, `extractClassicMetricKeys`, `detectClassicEntities`, `detectClassicEntitySelectors`, `scanAsset`, all 7 asset-type scanners, `detectAll()`, `lookupMetricKey`.
   - `lookupMetricKey` implements the 4-step normalization chain. Extended with a `dt.cloud.*` → `builtin:cloud.*` step (Grail format) that was absent from the Python per-index path.
   - Parity confirmed: 149/149 checks matched Python output across all asset types, all providers, all blocker paths.
   - All 6 Python scripts deleted. `scripts/` contains only TypeScript.

4. ⏳ **GCP parity.**
   - When GCP mappings are built, emit the AWS/Azure row shape. Remove all `if gcp: error` branches.

5. ⏳ **Publish skill as authoritative source.**
   - Decision §6.2: this repo is upstream. Communicate the direction to helper-repo owners and stop treating helper-repo divergence as drift the skill must absorb.

---

## 6. Resolved decisions

The five open questions have been answered by the team. The decisions below are now load-bearing assumptions for the rest of this review:

1. **Node is assumed available in the local IDE.** → The TypeScript library is the single deterministic core for both targets. **No Python fallback is required**; the IDE Python path is a transitional convenience, not a long-term contract. The migration plan in §5 can drop step 3's "Python for IDE-without-Node" caveat: once `scripts/migration-lookup.ts` lands, all Python in the skill can be deleted.
2. **`product-ai-knowledgebase` is the authoritative source, not the helper repo.** → The skill *owns* the JSON references; the helper repo is downstream. This inverts the sync direction described earlier in §3.2 and §5 step 5. Concretely: the skill's `references/dac-*.json`, `end-of-life-services.json`, and `manual-metric-mappings.json` are the master copies, and any changes happen here first. The helper repo (and any other consumer) should pull from this skill, not vice versa. No submodule or import-at-build-time is needed in this direction; we just need to remove any wording that frames the helper repo as upstream.
3. **A consolidated phase-output contract will be defined.** → A new reference doc, `references/phase-output-contract.md` (plus a `references/phase-output.schema.json`), specifies the single document model that all four phases append to. Sketch below in §6.1.
4. **Disambiguation is default-on.** → `disambiguate-metrics.py` (and its TS successor) runs as part of Phase 2 by default. The tenant-load concern is accepted as the cost of correctness. The current `ThreadPoolExecutor(10)` concurrency is reasonable; if it becomes a problem, throttle, do not opt out. Document this expectation in SKILL.md so users are not surprised by the probe traffic.
5. **No external callers of `dtmigration/`.** → The package can be deleted with the same release that ships the TS library. No deprecation window, no release-note carve-out, no compatibility shim. Step 2 of §5 collapses: there is no "pick one of `scripts/` or `dtmigration/`" — both go.

### 6.1 Phase-output contract (sketch for §6 / decision 3)

The contract is one growing markdown document per migration run, with a structured front-matter manifest and one section per phase. The model in DT Assist appends sections as it progresses; the TS library in the IDE emits the same structure programmatically. Resuming mid-run means reading the file, finding the latest completed phase, and continuing.

```yaml
# Front-matter (machine-readable manifest)
---
run_id: 2026-05-15T14-23-07Z-acme-prod
tenant: acme-prod.live.dynatrace.com
providers: [aws, azure, gcp]
phases_completed: [discovery, assessment]
phases_in_progress: [guidance]
skill_version: <semver>
contract_version: 1
---
```

```markdown
## Phase 1 — Discovery
- inputs: (queries from references/discovery-queries.md)
- findings:
  - { provider: aws, classic_connections: 12, new_connections: 3, hybrid: true }
  - { provider: azure, classic_connections: 4, new_connections: 0, hybrid: false }
- next_steps: [run Phase 2 for aws and azure]

## Phase 2 — Assessment
- inputs: [scan-dashboards.json, scan-notebooks.json, scan-alerts.json, scan-slos.json]
- findings: [...detection rows keyed by asset id + classic key...]
- disambiguation: [...live-probe results...]
- next_steps: [...]

## Phase 3 — Guidance
- mappings_resolved: N
- mappings_unresolved: M (with reasons)
- migration_plan: (Mode A markdown body)
- next_steps: [...]

## Phase 4 — Cutover
- validation_queries_run: [...]
- residual_classic_traffic: [...]
- sign_off: pending | approved | rolled-back
```

Minimum required JSON schema (separate file, `references/phase-output.schema.json`) validates the front-matter manifest and each phase's `findings` array shape. Markdown bodies stay human-readable. Both Python (transitional) and TS (target) and the DT Assist model converge on this shape — that is the consistency requirement.

---

## 7. What the review did **not** recommend changing

- The **JSON mapping databases** (`dac-aws-…`, `dac-azure-…`, `end-of-life-services.json`, `manual-metric-mappings.json`). These are the load-bearing reliability asset. Keep them.
- The **fallback-chain rules** themselves. The 5-step chain matches the documented spec and has correct precedence (exact > selector-stripped > prefix-normalized > suffix-stripped > service-segment). Only its *implementation host* should change.
- **Phase 4 (cutover)**. Already in the recommended shape.
- The **classification logic** in `discovery-queries.md`. It is the right approach (DQL-driven classification of classic vs new vs hybrid).

---

*End of review.*
