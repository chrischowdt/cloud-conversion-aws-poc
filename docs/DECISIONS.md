# Decisions — and why

The rules this migration runs by. Most came from something going wrong once. If you want to change one, read the reason first.

## How queries are translated

- **Translate directly; don't rework.** Convert only what the new data model forces, and leave the author's structure alone, even when the query is poorly written. That keeps the diff reviewable, and keeps the tool out of the business of guessing intent. Improvements are the reviewer's call, not the tool's.
- **AWS only.** Non-AWS entities (services, hosts, Kubernetes, Azure) are left exactly as they are. Converting them over-reached and broke working queries.
- **Proven, not plausible.** A translation rule is added only after running the classic and translated forms side by side on a real environment and comparing rows. The measurement goes in the code comment and the test.
- **Output proven to return nothing is blocked** (`lib/output-lint.ts`). The typical failure isn't an error. It's a query that runs and returns nothing, which on a dashboard looks like a quiet tile and on an alert looks like no incidents.
- **Tag keys use the casing resources actually carry** (`ApplicationCI`, `env`, `Environment`, `Name`). Teams whose tags don't follow the standard fix their tags; the tool doesn't case-fold.
- **Region comes from the resource's `aws.region` field,** not from the classic `location` tag, which isn't present everywhere.
- **Management zones are decoded from their name.** Zones don't exist on the new AWS resources. Zone names follow the convention `<APP> : <name> : <ENV>`, which matched the zones' own rules for every zone checked (one exception in over 3,000), so the name translates directly to tag filters:
  - the app becomes `ApplicationCI` and the last part becomes `env`;
  - a phrase with only the app (e.g. `"ABC"`) means every environment;
  - in a metric query the target is the enriched `aws.tags.*` dimensions; elsewhere, the resource's own tags.

  Names outside the convention fall back to the downloaded zone rules. If neither works, the filter stays blocked.
- **Classic entity ids don't exist on the new side.** A query pinned to one resource by id is re-pinned by its **ARN**, which every classic entity, new metric series and new entity carries.
- **An alert must attach to an entity, or it reaches the incident tool with none, and Dynatrace can't correlate it.** Many classic AWS alerts split by the resource's own dimensions (cluster name, queue name), so their translation has no entity column. The stager adds the series' own entity, `dt.smartscape_source.id`, to the split.
  - It checks the series count with and without it. Adding a dimension can only split groups, so an unchanged count means the alert's grain is unchanged.
  - **If the count grows,** the classic alert combined several resources into one series. The entity is added anyway, so the alert now fires per resource, and the card asks the reviewer to check the threshold. Reviewers chose per resource every time this came up, and an entity on every alert is the goal.
  - It is left out only when the split would pass Davis's limit of 10,000 series per detector (beyond it, new series are silently not monitored), or when the query's shape can't be edited safely.
  - Every new AWS series of a resource service carries `dt.smartscape_source.id`, at the metric's own grain (an RDS cluster metric points at the cluster), so no entity type has to be guessed.
  - **The event property must name a column the query emits:** `{dt.smartscape_source.id}` with that dimension in the split. The same property without it bound no events at all. Watch for the alias form `by:{dt.smartscape_source.id = dt.smartscape.X}`: the column it emits is `dt.smartscape_source.id`, so a `{dt.smartscape.X}` property binds nothing.
- **Use the metric variant that covers the resources.** A metric often exists in several dimension variants, and the mapping names one of them. If a sibling the query can use unchanged covers at least twice as many resources on the environment, the translation uses the sibling and the card says so. Cluster vs instance variants are never swapped this way; that's a grain decision.
- **Inside a metric query, filter on the metric's own dimensions.** Reading an entity's name there (`getNodeName(...)` in a `timeseries` filter) looks up every entity of the type and fails on longer timeframes. The series already carry the resource name as a dimension, measured equal to the entity name for each type it's used for. After the `timeseries`, only the columns in its split exist, so tag filters there read the entity's tags instead.
- **Inventories must be complete.** `fetch metric.series` stops at 100,000 series without saying so. `discover-metrics` splits by key prefix until every part is under the cap, because a key missing from a truncated inventory looks "not collected" and steers the translation to the wrong metric variant.

## How assets are published

- **Nothing is published until a person marks it Ready To Publish.** The reviewer's decision outranks the tool's confidence: a "blocked" asset a reviewer approves still goes; a "clean" one they descope doesn't.
- **Reviewer judgement overrides lint.** If the reviewer confirmed it returns data, publish with `--ignore-lint`. Drift is still always checked first.
- **Dashboards are updated in place,** keeping the same id, URL and owner, so links, bookmarks and the owner don't change.
- **Notebooks are never overwritten.** A notebook keeps the results of its past runs, and overwriting would destroy them.
  - The reviewed copy becomes a **new** notebook, with the original's **title**, **owner** and **exact sharing**.
  - The original gets one change: a pointer tile.
  - The title is kept rather than suffixed, because future upgrades would stack suffixes.
- **Labels, not the tracker, say whether a notebook was already published.** A stale save of the shared workbook once silently reverted the tool's rows. The labels live on the documents themselves.
- **Owners aren't emailed.** Every share and ownership transfer is sent with notifications off, to avoid spamming people.
- **Grant access before revoking it.** When changing sharing, add the new access before removing the old, so nobody is ever left without access mid-change.
- **Read the reviewer's copy live, not a pulled file.** Reviewers keep working after a pull; publishing a snapshot silently reverts their latest fixes.
- **Never restage over a reviewer's edits.** To bring a rewriter fix to copies already out for review, replace only the tiles nobody has touched since staging.
- **Drift is a stop sign.** If an original changed after staging, find out *what* changed before forcing:
  - the dashboard app's own format upgrade is fine to force;
  - an owner's real edit means restage, or publish knowing their edit is lost (for notebooks, the original keeps it).
- **Alerts are reviewed in inert notebooks,** never published as a second live alert, which would alert twice.

## How the work is tracked

- **One workbook per environment, in a place the team can open it.** In it, dashboards and notebooks go on one sheet and alerts on another, because the two have different lifecycles but reviewers want one file. The tool refuses to write a row to the wrong sheet.
- **The tool owns its columns; people own theirs.** The tool writes only *Published* into `decision`.
