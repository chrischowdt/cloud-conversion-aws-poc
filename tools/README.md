# cloud-conversion tools

Node 22 + TypeScript tooling for the classic→new Dynatrace cloud-integration migration. The modules here are written so they can be lifted into the Dynatrace App (`cloud-migration-helper`) directly — the DQL client and stats utilities have no third-party dependencies and use only Web `fetch`.

## Setup

```bash
cd tools
npm install
cp .env.example .env.local
# edit .env.local — fill in DT_BASE_URL and DT_TOKEN
```

Node 22.7+ is required. `.ts` runs without a build step (`--experimental-strip-types`), and the npm scripts auto-load `.env.local` (`--env-file-if-exists`). `.env.local` is gitignored.

### Credentials

Both tenant-touching commands hit the **Grail Storage Query API** (`/platform/storage/query/v1/...`), which lives on the AppEngine host:

- `DT_BASE_URL` — `https://<env-id>.apps.dynatrace.com` (NOT `live.dynatrace.com` — that won't serve `/platform/...`)
- `DT_TOKEN` — Platform Token with at least `storage:metrics:read`

Flags (`--base-url`, `--token`) override env if you want to target a different tenant in one shot.

## Commands

### `build-mapping`

Transform the DAC reference JSON into a unified mapping consumed by the App's lookup utilities. Also diffs against the local Python scrape.

```bash
npm run build-mapping
```

Outputs to `tools/out/`:
- `aws_mapping.unified.json` (4168 rows, 113 namespaces)
- `azure_mapping.unified.json`
- `aws_mapping.schema_diff.json`
- `eol_services.json`

### `discover` — enumerate cloud metric keys via DQL

```bash
npm run discover
```

Runs:

```dql
fetch metric.series, from: now-7d, to: now
| filter startsWith(metric.key, "builtin:cloud.aws.")
       or startsWith(metric.key, "builtin:aws.")
       or startsWith(metric.key, "cloud.aws.")
       or startsWith(metric.key, "ext:cloud.aws.")
| summarize pointCount = count(), by: { metric.key }
| sort `metric.key` asc
```

Outputs `tools/out/reconcile_report.aws.{json,md}` with:
- per-source coverage of the two candidate classic-builtIn schemas
- verdict (`dac-reference-wins` / `python-scrape-wins` / `mixed-or-tied`)
- tenant-only keys neither source recorded

### `equivalence` — verify metric pairs return the same data

For each `(classic builtin, new DAC)` pair, issues two `timeseries` DQL queries (one per side, parallel) and compares with Pearson r + sMAPE + mean ratio.

```bash
npm run equivalence -- --mapping out/aws_mapping.unified.json --limit 25 --skip-missing
```

Useful flags:
- `--service "AWS/EC2"` — only test pairs whose namespace starts with that
- `--from now-7d --to now` — wider window
- `--aggregation sum` — for cumulative metrics
- `--interval 1h` — DQL bucket size
- `--skip-missing` — drop pairs with no data on either side

Outputs `tools/out/equivalence_report.{json,md}` with per-pair verdict bucketed into `identical | scaled | correlated | different | no-data`.

### `dql` — run a raw DQL query

For iteration. Paste any DQL, see records.

```bash
npm run dql -- --query "fetch metric.series, from:-1h | summarize by:{metric.key} | limit 50"
# or
npm run dql -- --file query.dql --from now-24h --to now
```

Writes the full result to `tools/out/dql_<timestamp>.json` and prints the first 10 records.

### Dashboard pipeline + discovery

The user-facing migration loop and its tenant-probing helpers. See CLAUDE.md
("CLI surface") for the authoritative, fully-flagged list — summary here:

- `download-dashboards` — dump every dashboard (new + classic) as JSON.
- `scan-dashboards` — run the rewriter over the corpus, filter to AWS, emit a coverage report (offline).
- `rewrite-dashboard --in <file>` — produce `.rewritten.json`, `.rewrite-report.md`, and an upload-ready `.upload.json`.
- `compare-dashboard --in <file>` — run original vs rewritten queries against the tenant and classify parity.
- `discover-fields` / `discover-tags` / `discover-metrics` — probe the tenant for Smartscape field schemas, which AWS tags the new connection enriches (`enriched-tags.json`), and the live new-connection metric inventory (`live-metrics.json`).

`discover-metrics` feeds **dim-variant validation**: when the DAC maps a classic
key to a `.By.<Dim>` variant that has no series on the tenant, the lookup chain
swaps in a populated sibling (default: target needs ≥2 series; tune with
`--min-override-series`). Opt-in — nothing changes unless `live-metrics.json` exists.

> Invoke commands that take `--flags` via `node … src/cli.ts <cmd> --flag value`,
> not `npm run cli -- …` (npm strips unknown flags). See CLAUDE.md.

## Module layout

```
src/
├── cli.ts                       CLI entrypoint
├── commands/
│   ├── build-mapping.ts         Reference JSON → unified mapping
│   ├── discover.ts              DQL-driven schema reconciler
│   ├── equivalence.ts           Per-pair value comparison via DQL
│   └── dql.ts                   Raw DQL runner
├── dynatrace/
│   └── dql.ts                   Grail Storage Query client (Bearer auth)
└── lib/
    ├── dql-parser.ts            timeseries record → TimeSeriesPoint[]
    ├── markdown.ts              Tiny md table helpers
    ├── paths.ts                 Repo-relative path constants
    ├── stats.ts                 Series summary + aligned comparison
    └── types.ts                 DacAws/Azure rows, UnifiedMapping
```

## Reusing in the Dynatrace App

`src/dynatrace/dql.ts`, `src/lib/dql-parser.ts`, `src/lib/stats.ts`, and `src/lib/types.ts` have no third-party dependencies. The App can import them directly; replace the constructor's `baseUrl`/`token` with whatever the App uses for auth.
