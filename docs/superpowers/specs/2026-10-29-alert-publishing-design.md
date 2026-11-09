# Publishing migrated alerts — design

_2026-10-29, updated 2026-11-09. Status: built; the decisions taken during the build are listed at the end. Build plan in docs/superpowers/plans/._

## Why

Migrated dashboards and notebooks already go live through a tracked, reversible pipeline: a reviewer marks an asset **Ready To Publish** in the team workbook, `migrate-promote` publishes it, `migrate-verify` confirms it landed, and `migrate-rollback` puts it back. Alerts (Davis anomaly detectors) stop halfway. `stage-detectors` lays each translated alert into a review notebook, reviewers fix the query there and record their decision on the workbook's `alerts` sheet, and then nothing publishes it. On the lower environment 344 alerts are marked Ready To Publish and waiting.

The same thing is needed for alerts, with the same properties as the dashboard pipeline: driven by the spreadsheet, prepare before apply, guarded against overwriting other people's edits, snapshotted, and reversible. Production must be able to move slowly, one review batch at a time.

An alert is riskier than a dashboard. A broken dashboard shows an empty tile. A broken alert never fires, or fires with a title full of unfilled placeholders, or reaches the incident tool attached to no entity, and nobody notices until an incident is missed.

## Goals

- Publish the reviewer-approved version of each alert **in place**: same detector, same settings object id, same links. Never a second detector (two armed copies would alert twice).
- Select what to publish from the `alerts` sheet: `decision` = Ready To Publish, within the **review batches** named on the command line.
- Update the alert's **event fields** so every field reads a column the approved query actually produces, and the entity binding names the query's Smartscape entity column.
- Snapshot before every write; roll back by alert or by batch.
- Record every step on the sheet: status, timestamps, and why an alert was skipped.
- Work the same way in Lower and Prod.

## Non-goals (for now)

- **No waiting on alerts to fire.** Many alerts never reach their triggering condition in any reasonable time, so neither verify nor anything else waits for, or counts, alert events.
- **No automated soak check of run failures.** After a batch is published, the migration team checks the detectors' run status by hand; the runbook gives them the query.
- **No new batching scheme.** Publishing uses the review batches that already exist (`batch-NN`, one review notebook each).
- **No threshold changes.** Every analyzer setting keeps the original alert's value, threshold included, even where the metric mapping would rescale it.
- **No firing-volume prediction.**
- Classic metric events (`builtin:anomaly-detection.metric-events`) are a different schema and are not in scope.

## Anti-goals (a failure even if it technically works)

- Overwriting a change an alert's owner made after the alert was staged.
- Publishing a query the reviewer did not approve, or an empty or commented-out one.
- An alert title or description that goes out with literal `{dims:…}` text in it.
- Changing anything a reviewer did not review: thresholds, sliding window, severity, enabled state, the user the alert runs as.
- A rollback that silently discards an edit made after publishing.
- Writing to Prod by accident (wrong env file).

## What exists today

| Piece | Where | Reusable for publishing |
|---|---|---|
| Rewrite of a detector value (query, event template, threshold) | `lib/detector-rewrite.ts` `rewriteDetector` | event-template remapping, binding rewrite; the threshold rescale must NOT be applied |
| Which entity column a query emits | `lib/detector-binding.ts` `emittedEntityColumn` | yes |
| Review notebooks, read-back markers | `lib/detector-notebook.ts` `parseReviewQuery`, `DETECTOR_MARKER_RE` | yes; `parseReviewCard` has a bug (below) |
| Manifest of review batches → notebook ids → alert ids | `migration/detector-review/manifest.json` | yes; the authority for which batch an alert is in |
| Card-level restage with base payloads | `stage-detectors --restage`, `lib/detector-restage.ts` | the base payload `<batch>.json` records the classic query each card was staged from |
| `alerts` sheet, tool vs human columns | `lib/tracker-xlsx.ts` (`ALERTS_SHEET`, `upsertRows` refuses the wrong sheet) | yes; needs one new column |
| Settings read/write with optimistic locking and server-side dry run | `dynatrace/settings.ts` `getObject` / `putObject({updateToken}, {validateOnly})` | yes |
| Prior live writes to detectors, with snapshot + rollback + env guard | `oneoff/fix-metric-key-split.ts` (applied to the lower environment) | the pattern: `--allow-env`, first-snapshot-wins, re-read before write, drift skip |
| Dashboard publish/verify/rollback | `commands/migrate-{promote,verify,rollback}.ts` | the shape and the sheet conventions |

## What a dry run found (lower environment, 344 Ready To Publish alerts, read-only)

The value a publish would write was assembled for every alert, run, and sent to the Settings API with `validateOnly=true`, which runs the server's full validation and persists nothing.

- **342 pass server validation.** The 2 that fail have their query commented out in the notebook (both still marked Ready).
- The reviewer's query was read back from the notebook for all 344, by the marker line.
- **The sheet is the only reliable decision.** 140 of the notebooks' verdict cards still say "Needs Review" while the sheet says Ready.
- **21 alerts were edited by their owners after staging**, 3 of them already migrated by the owner. The reviewed query was written against the old version.
- **33 approved queries split by no entity**, so they would reach the incident tool attached to nothing. They were reviewed before entity binding was added to staging. See the open question.
- **2 queries produce more than 10,000 series.** Davis stops monitoring new series past 10,000 per detector, without error.
- 1 query fails at 24h ("subquery read too much data"); 47 return no data in 24h, normal for sparse alerts.
- 19 of the 344 alerts are disabled. Publishing must keep them disabled.
- **182 of the 342 have an event field that points at a column the approved query doesn't produce.**
- **Davis fills `{dims:X}` and `{X}` from any column the query emits**, by-clause or a later `fieldsAdd` (measured on events from the last 30 days). A placeholder naming a column the query doesn't emit is sent out as literal text. Classic entity names (`{dims:dt.entity.custom_device.name}`) were filled automatically. There is no evidence that a Smartscape name placeholder is filled when the query doesn't emit that column.
- **Bug:** `parseReviewCard` builds its id regex from the string `'([^\s`]+)'`, where `\s` is just `s`, so the id stops at the first letter "s". It returned a wrong id for all 344 cards.

## Decisions made

1. **Batches are the existing review batches.** The command takes `--batches batch-03,batch-04` and publishes only Ready alerts in those batches. A new tool-owned column, `review_batch`, shows each alert's batch on the sheet. Today the batch is buried in `reasons` as "review batch batch-NN". It is filled from the manifest, which stays the authority.
2. **Thresholds and every other analyzer setting stay as the original alert has them.** Only the query input changes in `analyzer.input`.
3. **Event fields are updated** to read the Smartscape dimension or field the approved query emits, by the rules below.
4. **Verify checks the configuration only.** It re-reads each published alert and confirms its stored value is what was published. It never waits for events.
5. **Run-failure checks after a soak are manual.** The migration team uses a query documented in the runbook.
6. **Prod works exactly like Lower:** its own review notebooks, decisions on the Prod workbook's `alerts` sheet, and the same commands.
7. **An approved query that emits no entity goes back for review**, unless a reviewer has overridden that for the alert on the sheet. Some unbound or per-resource alerts are legitimate (decided 2026-11-06); see "Alerts with no entity" below.

## The design

### Commands

Three commands, the alert counterparts of the dashboard ones. Each reads and writes only the `alerts` sheet. Each defaults to **prepare** (no tenant writes); `--apply` performs the writes.

**`migrate-promote-detectors --batches <list> [--ids a,b] [--limit N] [--apply] [--force] [--allow-env <env-id>]`**

1. **Select:** rows with `decision` = Ready To Publish whose alert is in one of the `--batches`, not already published (`status` promoted/verified, or `decision` Published). The review manifest decides the batch (an alert staged in several belongs to the last published one); the sheet's `review_batch` column is not read for this. `--batches` is required; there is no "publish everything Ready" mode. `--ids` narrows further and `--limit` caps the run.
2. **Env guard:** with `--apply`, `--allow-env` must name the environment the token is connected to, or the command refuses. Same rule as the one-off detector fix.
3. **Read the approved query live** from the batch's review notebook, by its marker line, never from a file pulled earlier. Reviewers keep working after a pull.
4. **Read the alert live** (`getObject`, with its `updateToken`).
5. **Build the value:** the live value, with only the query input replaced by the approved query and the event fields updated (rules below). Everything else is byte-identical to live.
6. **Gates.** Any failure skips the alert, records why in `reasons`, and the run continues. First, before any gate: an alert whose live query and event fields equal its published record (`published/<id>.json`, what the server stored) or its pending record is **recorded at once**, never rebuilt from today's notebook; if the tile has been edited since, `reasons` says "the review tile has changed since this alert was published; re-stage it if the change should go out".
   - **rolled back since the row was saved:** an applied rollback left `rolled-back/<id>.json` and the row's status is not `rolled-back`, so the row is a stale save from before the rollback.
   - **the tile:** found by its marker line, and naming only this alert; a tile whose markers name several alerts is an error for each of them.
   - **drift:** the live query is not the classic query the card was staged from. An alert is unchanged when its live query equals the staged query from ANY known source: the batch's base payload `<batch>.json`, the archived payload `migration/detector-review-archive/<batch>.json`, or the card's reference block in the live review tile. One base payload, batch-01's, was overwritten by a later prepare run, so the other sources are needed. With none of them known, the alert is skipped as "staged version unknown". In the dry run the base payload and the tile covered all 344.
     - A drifted alert is skipped. Its `reasons` say either "owner changed the alert after review" or, when the live query has no classic references left, "owner already migrated it".
     - An alert whose live query already equals the approved query (or the query an earlier apply of ours published) is not drift. It is **recorded only when nothing would change**: the live value already has the query and event fields a publish would write, so the sheet gets the row and the tenant gets no write. Otherwise it is published as an **event-field-only update**: the query stays, the event fields change.
     - The decision is left as it is. The migration team settles each case.
     - `--force` with `--ids` publishes one anyway, once a reviewer has confirmed the approved query covers the owner's change. _(my call)_
     - Measured on the lower environment, 21 alerts drift: 18 owner edits, plus 3 alerts we patched on 1 October that their owners later migrated. None is explained by our own fix alone, so no prior-state allow-list is needed.
   - **empty query:** nothing but comments and whitespace.
   - blocking output lint (`lib/output-lint.ts`).
   - the query errors when run on the tenant, over a window the alert itself uses: the last 2 hours, not 24h.
   - the query produces more than 10,000 series. The count is the **2-hour run of the final query**, the one that would be published, which is the scale Davis evaluates at. It is not a 7-day count: a 7-day count overstates what one evaluation sees. The no-entity check (`resolveBinding`, see "Alerts with no entity") still uses 7 days, as staging does.
   - **the entity column is not in the output:** when the columns come from a query run, the entity column the binding names must be among them (a later `fields` can drop it).
   - **an event field still points at a column the query doesn't emit** after the rules below, or, under *Publish without entity*, is left empty once the entity placeholders are removed.
   - **the final query errors when run.** After any entity, name-column or alias edit (rules below), the query that would go out is run once over 2 hours before it can be published, so a column added only for an event field can't break the alert.
   - the server's `validateOnly` write fails.
7. **Prepare output:** per alert, the payload that would be written, a readable diff (query and each event field, before → after), and every gate result. Per run, a summary by batch.
   - **Prepare writes nothing to the workbook, only the report.** The workbook is a file reviewers keep open, rewritten whole on each save, and a stale save has already reverted the tool's rows once. _(my call, same as the dashboard promote)_
   - The migration team reads the report to see which alerts are blocked and why.
   - An apply run records a skipped alert's reason in `reasons`.
8. **Apply, per alert:**
   1. Re-read the alert and skip it if ANY part of it changed since planning, not only its query: writing the planned value would undo a threshold, enabled-state or event-field change made in between.
   2. Snapshot the live value to `migration/detector-promote/pre/<objectId>.json`. An existing snapshot is kept while its query and event fields equal the live alert's (a retry after a failed write); otherwise it is moved aside to `pre/<objectId>.<stamp>.json` and a fresh one taken, so a rollback after a re-publish never restores an out-of-date one.
   3. Write `published/<objectId>.pending.json` (what is about to be sent), then PUT with the `updateToken` of that re-read. No write is made without the re-read's update token. A write is never re-sent: a 5xx (or no answer) is settled by one re-read, which shows whether it landed. Any HTTP 401/403 stops further writes.
   4. Re-read and confirm the stored query and event fields equal the payload; every other path the server changed is a note in `reasons`, not a failure. The pending record becomes `published/<objectId>.json`, with the re-read value as `storedValue`.
   5. Update the sheet row: `status` promoted, `decision` Published, `promoted_at`, `review_batch`, `reasons`.

   A failed sheet write never undoes a publish; the command prints the whole command that records the alerts (`--tracker`, `--batches`, `--ids`, `--apply`, `--allow-env`) and exits non-zero. This is the same rule the dashboards follow.

**`migrate-verify-detectors [--batches] [--ids]`.** For each promoted row: re-read the alert and compare its query and event fields with the published record (what the server stored, when the record has it). Equal → `status` verified, `verified_at`. Different → flagged in `reasons` (someone edited it since, or the write didn't stick). No events, no waiting. An alert the tool **recorded but did not publish** (it already had the approved query and event fields, so there is no published record to compare with) is reported as "no published record", and its status is left alone.

**`migrate-rollback-detectors (--ids a,b | --batches <list>) [--apply] [--force]`.** For each promoted or verified row: re-read the alert. If its query and event fields still equal what was published, restore the snapshot's **query input and event fields only**, written onto the CURRENT live value with the current `updateToken`. Everything else stays as it is live, so an owner's later change to the threshold or enabled state survives the rollback. If the query or event fields were edited after publishing, refuse unless `--force`, and say what changed. An alert with **no snapshot** (the tool recorded it, never published it) cannot be rolled back. `--force` needs `--ids`: it discards an edit, so it names the alerts. Sheet: `status` rolled-back; `decision` set to Needs Review (my call), so the next publish run doesn't pick the alert up again until a person re-approves it. Each applied rollback also leaves `migration/detector-promote/rolled-back/<objectId>.json`, which makes a publish run skip the alert while its row's status is not `rolled-back`, so a stale workbook save cannot re-publish it.

### Event field rules

The event template is a list of properties (`event.name`, `event.description`, custom ones). Values contain placeholders `{dims:X}` or `{X}`. Davis fills each from a column of the query result. After publishing, every placeholder must be one of:

- **a Davis built-in**, left alone: `threshold`, `severity`, `alert_condition`, `violating_samples`, `dealerting_samples`, `sliding_window`, `metricname`, `metric_value`, `baseline`, `dims`. Builder: confirm the list against the Davis event-template documentation.
- **a column the approved query emits:** a `by:{}` dimension, or a column a later `fieldsAdd` / `fields` produces. Left alone.

Placeholders that are neither are remapped:

| In the original | Becomes |
|---|---|
| the classic binding property `dt.source_entity` | removed. The binding is `dt.smartscape_source.id` = `{<entity column>}`, where the entity column is what `emittedEntityColumn` returns for the approved query (an alias `dt.smartscape_source.id = dt.smartscape.X` emits `dt.smartscape_source.id`). |
| a classic entity id (`dt.entity.custom_device`, `dt.entity.<aws type>`, `dt.source_entity`) in a field | the entity column |
| a classic entity name (`dt.entity.<type>.name`, `dt.source_entity.name`) | `<entity column>.name`, and if the query doesn't emit that column, `\| fieldsAdd <entity column>.name = getNodeName(<entity column>)` is appended to the query. A name lookup after the `timeseries` doesn't change the series and was measured to fill placeholders. |
| a classic dimension the new metric spells differently (`cluster_name` ↔ `` `Cluster Name` ``, `broker_id` ↔ `` `Broker ID` ``) | the emitted column it matches, compared ignoring case, spaces, underscores and backticks |

**A placeholder that resolves to a column whose name contains whitespace** (`` `Cluster Name` ``, `` `Broker ID` ``) is rewritten to an underscore alias, and the alias column is appended to the query: `` | fieldsAdd Cluster_Name = `Cluster Name` ``. Davis filling a placeholder from a spaced column name is unverified, while columns added by a later `fieldsAdd` are measured to fill, so the publish does not depend on the unverified case.

Anything still unresolved blocks the alert, naming the field and the missing column. The fix is to make the approved query emit that column, in the notebook, where reviewers already work. On the lower environment these rules map every field on 261 of the 342 alerts. 28 still have a field to fix, usually a classic dimension the reviewer's query no longer splits by. For the other 53 the query returned no data, so their columns are unknown; the builder must get their column set another way, e.g. a longer window or the result type metadata.

### Alerts with no entity

When the approved query emits no entity column, the publish runs the same read-only 7-day check that staging uses (`resolveBinding`, `lib/detector-binding.ts`). This is the one place a 7-day count is used; the series-cap gate counts the 2-hour run of the final query.

| Check result | Lower count | Without an override | `publish_override` = Publish per resource | `publish_override` = Publish without entity |
|---|---|---|---|---|
| count unchanged | 16 | add `dt.smartscape_source.id` to the split, publish | same | publish without an entity |
| one alert becomes many | 9 | **skip, back for review** | add it, publish per resource | publish without an entity |
| no data to check | 4 | add it, publish (as staging does) | same | publish without an entity |
| over 10,000 series | — | skip, back for review | skip (Davis would not monitor it) | publish without an entity |
| query shape can't be edited safely | 2 | skip, back for review | skip (the entity can't be added) | publish without an entity |

**The override** is a new **human** column on the alerts sheet, `publish_override`, a dropdown in the style of `decision` with two values. _(my call: you asked for a way to override; the sheet is where reviewers already record decisions.)_ An empty cell means no override.

- **Publish per resource:** the reviewer accepts that the alert will fire once per resource and has checked the threshold for that.
- **Publish without entity:** the alert is legitimately not about one resource (account- or environment-wide), so it goes out with no binding property. Any classic entity placeholder in its event text is removed rather than mapped. The prepare diff shows the exact before → after text.

Rules:
- The override is honoured only on a row whose `decision` is Ready To Publish and whose `reviewer` is filled in, so every override has a name on it. _(my call)_
- It only lifts the no-entity gate. Every other gate (drift, empty query, lint, errors, the 10,000-series cap, unmapped event fields, server validation) still applies.
- The tool never writes `publish_override`.
- The report lists every alert published under an override, and which one.

"Back for review" means skipped, with the reason in `reasons` ("emits no entity; one alert would become N; set publish_override to publish anyway") and in the report. The tool doesn't change the decision.

### Sheet changes

- New **human** column `publish_override` (dropdown: Publish per resource / Publish without entity), kept across every tool write like the other human columns; see above.
- New **tool** column `review_batch` (`batch-NN`), written by `stage-detectors` going forward. `stage-detectors --record-only --apply` fills it only on rows it records for the first time; **`refresh-alert-tracker` is what backfills rows already on the sheet**, from the manifest. Never by a prepare run. _(my call)_ Selection reads the batch from the manifest, so publishing doesn't depend on the backfill having run.
- Statuses on the alerts sheet: staged → promoted → verified, or rolled-back. A skipped alert keeps its status and gets its reason in `reasons`.
- `decision` remains human-owned. The tool writes only `Published` (after a publish) and `Needs Review` (after a rollback).

### Other fixes this needs

- `parseReviewCard`: build the id regex from a regex literal (or `String.raw`) so ids containing "s" parse. Add a test with a real id.
- `refresh-alert-tracker` must not rewind `promoted` / `verified` / `rolled-back` (it already leaves in-flight statuses alone; add the new ones).

### Runbook additions

- The publish loop for one batch: prepare → read the report → apply → verify, and how to roll back a batch.
- The manual soak check for the migration team, run some hours after a batch goes live. It lists the batch's detectors whose run status went to ERROR or WARNING since publishing:
  ```
  fetch dt.system.events, from:-24h
  | filter event.kind == "ANOMALY_DETECTOR_STATUS_EVENT"
  | filter in(dt.settings.object_id, array(<ids of the batch>))
  | summarize n = count(), by:{dt.settings.object_id, davis.anomaly_detector.status, davis.anomaly_detector.message}
  ```
  Some errors are platform-wide and transient. In a week on the lower environment, 1,001 detectors had at least one 10-second query timeout and 1,386 had at least one "couldn't schedule", so compare against how the alert behaved before publishing.

### Prod

Same commands. Before the first Prod apply:
- the Prod token needs settings write. Check it with a prepare run, whose `validateOnly` calls persist nothing;
- Prod has its own review notebooks and decisions;
- `--allow-env` must name the Prod environment.

Moving slowly is a matter of `--batches` with one batch per run, plus `--limit`.

## Left to the builder

- Command and file names beyond those above; where the payload and report files go under `migration/`.
- The evaluation window used for the "query runs" gate (built as 2 hours), and how column sets are found for queries that return no data (built as: the 7-day run, else the 2-hour run, else the columns the query text names).
- Whether the three commands share a module (expected: a pure `lib/detector-publish.ts` holding selection, value assembly, event-field rules and drift, unit-tested, with the commands doing I/O).
- Report format (markdown alongside JSON, like the scans).
- Concurrency (the one-off used 4).

## Testing

- Unit tests for the pure parts: selection, value assembly (only the query input and event fields change), each event-field rule, drift detection, the `parseReviewCard` fix.
- A prepare run over every Ready alert on the lower environment. The gate counts should reproduce the dry run above.
- A first apply on a handful of lower alerts, then verify, then rollback of one of them, re-read each time.

## Open questions

None. The no-entity case was decided on 2026-11-06 (decision 7).

## Changes during the build (2026-11-09)

Decisions taken while building the three commands. Each is also stated above, where its topic lives.

1. **`review_batch` backfill.** `stage-detectors --record-only --apply` fills `review_batch` only on rows it records for the first time. `refresh-alert-tracker` is what backfills rows already on the sheet.
2. **The series cap is counted at alert scale.** The gate counts the 2-hour run of the final query, not a 7-day count. The no-entity check (`resolveBinding`) still uses 7 days, as staging does.
3. **Drift has three sources.** An alert is unchanged when its live query equals the staged query from any known source: the batch's base payload, `migration/detector-review-archive/<batch>.json`, or the reference block in the live review tile.
4. **Already approved.** An alert whose live query already equals the approved (or previously published) query is recorded only when nothing would change; otherwise it is published as an event-field-only update.
5. **Spaced column names get an alias.** A placeholder that resolves to a column whose name contains whitespace gets an underscore alias column (`` | fieldsAdd Cluster_Name = `Cluster Name` ``), because Davis filling spaced names is unverified, while columns added by a later `fieldsAdd` are measured to fill.
6. **The final query is run.** The query that would be published, after any entity, name-column or alias edit, is run once over 2 hours before it can be published.
7. **Apply is conservative.** Apply re-reads the alert and skips it if ANY part changed since planning. A 5xx on the write is settled by one re-read and never re-sent. No write is made without the re-read's update token. Any 401/403 stops further writes.
8. **Rollback restores two parts.** It restores only the query input and event fields from the snapshot, onto the CURRENT live value, so later owner changes elsewhere (threshold, enabled) survive. An alert with no snapshot (recorded, not published by the tool) cannot be rolled back. `--force` requires `--ids`.
9. **Verify and recorded alerts.** Verify reports "no published record" for an alert the tool recorded but did not publish, and leaves its status alone.

Decisions from the final review (2026-11-09), before the first live apply:

10. **One tile, one alert.** A tile counts as an alert's only when its marker is that alert's; a tile whose markers name several alerts (one card pasted into another) is an error for every alert it names.
11. **Snapshots are refreshed when out of date.** An existing snapshot is kept only while the live query and event fields still equal it (a retry); otherwise it is moved aside to `pre/<id>.<stamp>.json` and retaken, so publish → rollback → owner edit → re-publish → rollback keeps the owner's edit.
12. **Already published is recorded at once.** An alert whose live value still has its published record's query and event fields is recorded before any gate, never rebuilt from today's notebook; a tile changed since gets a note to re-stage it.
13. **The entity column must reach the output.** With columns read from a run, a query whose output lacks its entity column is skipped ("keep it in the final fields").
14. **What the server stored.** The published record keeps the re-read value (`storedValue`); verify, the rollback guard and the drift check compare with it. Every other path the server changed on a write is a note, not a failure.
15. **Rolled-back record.** An applied rollback leaves `rolled-back/<id>.json`; promote skips such an alert unless the row's status is `rolled-back`, and moves the record aside when it publishes the alert again.
16. **Pending record.** `published/<id>.pending.json` is written just before the PUT and becomes the published record after the re-read, so a crash in between reads as already published, not as owner drift.
17. **No empty event text.** Under *Publish without entity*, an alert whose `event.name` (or any field) would be empty once the entity placeholders are removed is skipped.
18. **A failed sheet write exits non-zero** and prints the whole command that records the alerts.
