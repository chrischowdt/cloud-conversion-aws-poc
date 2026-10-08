# cloud-conversion

> [!WARNING]
> **Experimental work in progress.** This is a personal engineering project, published as-is so others can learn from it.
> It is **not** an official Dynatrace product, it is **not** supported, and its interfaces, data files and conclusions change without notice.
> Some of the tooling can **write to a Dynatrace environment** using an admin token. Read the code before you point it at anything you care about, and start in a test environment.

Tooling to help move Dynatrace assets — **dashboards, notebooks and Davis anomaly detectors** — from the **classic AWS cloud integration** to the **new AWS integration on Smartscape and Grail**.

## The problem

The two integrations describe the same AWS resources differently:

| | Classic integration | New integration |
|---|---|---|
| Metric keys | `builtin:cloud.aws.<service>.<metric>` / `ext:cloud.aws.…` | `cloud.aws.<service>.<Metric>.By.<Dimension>` |
| Entities | `dt.entity.<type>` (incl. generic `custom_device`) | Smartscape nodes, `dt.smartscape.<type>` |
| Entity ids | classic ids (`CUSTOM_DEVICE-…`) | a different id space |
| Tags | an array of `"Key:value"` strings | a record (`tags[Key]`) |
| Relationships | `belongs_to[…]`, `runs[…]` | Smartscape edges (`references[…]`) |

A query written for the classic integration doesn't fail when the classic integration goes away. It silently returns nothing. Every dashboard tile, notebook section and alert that references the classic model has to be translated, and most environments have far too many to do by hand.

## What it does

A Node 22 + TypeScript CLI, `cct`, in [`tools/`](tools/):

- **Discover**: inventory which classic metric keys, entities and tags an environment actually uses, and what the new integration collects there.
- **Map**: build a classic → new metric-key table (from Dynatrace's published mappings, plus per-pair aggregation/scale "recipes" checked against live data).
- **Rewrite**: a multi-pass DQL rewriter. It swaps metric keys, converts entities to Smartscape nodes, translates `classicEntitySelector(...)`, re-pins classic entity ids to the resource's ARN, and fixes the tag idioms. It also rewrites the *structured* side of a dashboard tile, which the dashboard editor reads alongside the query.
- **Scan and compare**: run the rewriter across every downloaded asset and report what converts cleanly, what needs review and what can't be converted. Optionally run the original and rewritten queries side by side to compare results.
- **Lint**: refuse output shapes that are *proven* to return no data (an empty tile looks exactly like a quiet one, so reviewers miss them).
- **Stage → review → publish**: publish migrated *copies* for human review, tracked in a spreadsheet, then cut them over:
  - Dashboards are updated in place, behind a drift guard and with a snapshot for rollback.
  - Notebooks are published as a **new** notebook with the original owner and sharing, and the original gets only a pointer tile. A notebook stores the results of its past runs, so overwriting it would destroy them.

**Taking this over or running it yourself?** Start with the [runbook](docs/RUNBOOK.md): how the migration is actually run, from setup to batches to publishing. Then read [the decisions behind it](docs/DECISIONS.md). See [`CLAUDE.md`](CLAUDE.md) for the architecture (rewriter passes, lookup tiers, lookup tables) and [`tools/README.md`](tools/README.md) for the commands.

## Status

Honest summary, as of late 2026:

- **AWS only.** Azure and GCP aren't covered. Non-AWS entities in a query are deliberately left alone.
- **Partial conversion is normal.** Many assets convert cleanly. Many need a person to finish them, and some need a manual rebuild. The tooling's job is to sort them into those three groups and do the mechanical part, not to promise full automation.
- **Mapping coverage has gaps.** Some classic metrics have no counterpart in the new integration, or no published mapping. They're reported, not guessed.
- **Empirical in places.** Several rules (which dimensions are carried on metric series, field renames, tag behaviour) were measured on real environments and can change as the new integration evolves. Re-check them on your own environment.
- **Classic metric events** (selector-based alerts) aren't translated. DQL-based Davis anomaly detectors are.
- Tests: `npm test` in `tools/` (Node's built-in runner). There is no CI.

## Safety model

If you run it, know this:

- **Nothing writes by default.** Every command that changes an environment runs in *prepare* mode first, writing the payload to disk for inspection. Only `--apply` performs the write.
- Writes go through the Dynatrace **Document API** and **Settings API** with *your* token. Cutover, ownership and sharing operations need an **admin platform token** (`document:documents:admin` and related scopes), which can modify documents owned by anyone. Treat it accordingly.
- Snapshots are taken before every cutover, and `migrate-rollback` reverses one.
- Share and ownership changes are sent with notifications **off**.

## Quick start

```bash
cd tools
npm install
cp .env.example .env.local     # set DT_BASE_URL=https://<env-id>.apps.dynatrace.com and DT_TOKEN
npm run typecheck && npm test

# Read-only from here on:
node --env-file-if-exists=.env.local --experimental-strip-types --no-warnings=ExperimentalWarning \
  src/cli.ts download-dashboards
node --env-file-if-exists=.env.local --experimental-strip-types --no-warnings=ExperimentalWarning \
  src/cli.ts scan-dashboards
node --experimental-strip-types --no-warnings=ExperimentalWarning \
  src/cli.ts rewrite-dql --query 'timeseries avg(builtin:cloud.aws.ec2.cpu.usage), by:{dt.entity.ec2_instance}'
```

Pass flags by invoking `node … src/cli.ts <command>` directly (npm strips unknown `--flags`). Outputs go under `tools/out/<env-id>/`, which is git-ignored.

## Repository layout

| Path | What |
|---|---|
| [`tools/`](tools/) | The `cct` CLI: rewriter, lookup tables, Dynatrace API clients, commands, tests |
| [`mappings/`](mappings/) | Generated classic → new metric mapping with recipes |
| [`experiments/`](experiments/) | Dated write-ups of conversion-quality experiments |
| [`CLAUDE.md`](CLAUDE.md) | Architecture reference (also used as context for AI-assisted development) |
| `RESEARCH.md`, `GAP_ANALYSIS.md`, `INTEGRATION.md`, `STATUS.md` | Background and dated notes, not maintained docs |

## How it was built

Much of the code was written with AI assistance ([Claude Code](https://claude.com/claude-code)), with a human directing, reviewing and testing against real environments. `CLAUDE.md` is the project context that workflow uses.

## Feedback

Issues and discussion are welcome. Expect slow responses, and no guarantee that anything gets fixed or merged.

## License

No license has been chosen yet. Until one is added, no rights to reuse the code are granted beyond viewing it on GitHub.
