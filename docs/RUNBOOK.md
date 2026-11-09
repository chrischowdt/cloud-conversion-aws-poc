# Runbook — running a migration with `cct`

How the work is actually done, step by step. For *why* things are done this way, see [DECISIONS.md](DECISIONS.md). For how the code works, see [CLAUDE.md](../CLAUDE.md).

The shape of it: **the tool converts, people review, the tool publishes.** Nothing reaches a real asset until a reviewer has marked it *Ready To Publish* in the tracker, and every command that writes to an environment does nothing unless you add `--apply`.

---

## 1. One-time setup

```bash
cd tools
npm install
cp .env.example .env.local          # one env file per environment
```

Put `DT_BASE_URL` (`https://<env-id>.apps.dynatrace.com`) and `DT_TOKEN` (a platform token) in it. For a second environment, use a second file, e.g. `.env.prod.local`. All `.env.*` files are git-ignored. The token needs admin document scopes for anything that publishes (see `.env.example`).

Make the commands short. Everything below assumes these two shell functions:

```bash
cct()  { node --env-file-if-exists=.env.local      --experimental-strip-types --no-warnings=ExperimentalWarning src/cli.ts "$@"; }
cctp() { node --env-file-if-exists=.env.prod.local --experimental-strip-types --no-warnings=ExperimentalWarning src/cli.ts "$@"; }
```

Which environment you hit is decided only by the env file. Outputs land in `tools/out/<env-id>/`, so the two never mix.

**The tracker** is one Excel workbook per environment, kept somewhere the review team can open it (not in the repo). It has a `migration` sheet (dashboards and notebooks) and an `alerts` sheet (Davis anomaly detectors). Pass it with `--tracker "<path>"` on every command, or set `DT_TRACKER_PATH`. Reviewers own the `assignee`, `decision`, `reviewer` and `notes` columns (and, on the `alerts` sheet, `publish_override`); the tool owns the rest. Decisions are a fixed list: **Descope · Needs Review · In Progress · Ready To Publish · Published**. The tool writes *Published* after a publish. The one other value it writes is *Needs Review*, on the `alerts` sheet, after a rollback.

**The review group** is an access group the reviewers belong to. Review copies and alert notebooks are shared read-write with it. Look up its id once per environment and pass `--share-group <id>`, or set `DT_SHARE_GROUP_ID`.

## 2. Per-environment discovery (once, then refresh occasionally)

These are read-only. Several change how queries are rewritten, so run them before converting anything in a new environment:

```bash
cct discover-tags              # which AWS tags are enriched onto metrics
cct discover-metrics           # live metric keys and series counts (repairs dimension variants)
cct discover-users             # user id → email, for the tracker's owner column
cct discover-management-zones  # zone → tag filter
cct discover-entity-arns       # classic entity ids in queries → ARN (run after downloading)
```

## 3. Dashboards and notebooks

### 3a. Download and scan (read-only)

```bash
cct download-dashboards --used-within-days 90
cct download-notebooks  --used-within-days 90
cct scan-dashboards
cct scan-notebooks
```

Scope to recently-used assets; there is no point migrating what nobody opens. Downloads clear their folder first, so re-downloading gives a fresh copy.

### 3b. Build or refresh the tracker (read-only to the environment)

```bash
cct migrate-refresh --tracker "<path>"
```

Each AWS asset gets a lane:

- **fast:** converted cleanly and live parity matched.
- **review:** a person needs to look.
- **blocked:** nothing converted automatically; rebuild by hand.

Human columns and in-flight statuses are preserved.

> ⚠️ `migrate-refresh` also **removes rows it no longer sees in the scan**. Run it only right after a full, fresh download and scan. If you only want to add a few assets the team asked for, add those rows on their own rather than refreshing the whole sheet against stale scan data.

### 3c. Stage review copies

```bash
cct migrate-stage --tracker "<path>" --share-group <id> --ids <a,b,…>            # prepare: writes payloads, no changes
cct migrate-stage --tracker "<path>" --share-group <id> --ids <a,b,…> --apply    # create the copies
```

Each copy is a new document named `[MIGRATION REVIEW] <original name>`, shared with the review group. Each converted tile keeps the original classic query as a `//` comment for the reviewer. The original is not touched.

**Reviewers** open the copy, run the tiles, fix what's wrong, and set `decision` = *Ready To Publish* (or *Descope*), with a note.

### 3d. Publish what reviewers approved

```bash
cct migrate-promote --tracker "<path>"            # prepare: shows what would happen, lint and drift results
cct migrate-promote --tracker "<path>" --apply
```

- **Dashboards** are updated **in place** (same id and URL, owner unchanged), from the reviewer's **live** copy. A snapshot of the previous content is kept for rollback.
- **Notebooks are never overwritten,** because a notebook stores the results of its past runs. The reviewed copy is published as a **new** notebook:
  - it keeps the original title;
  - it gets the original owner and the original's exact sharing;
  - it carries a notice tile linking back.

  The original gets only a pointer tile at the top. Labels mark the pair: `aws-new-integration` on the new notebook, `aws-classic-superseded` on the original.
- **Guards:**
  - **Lint** blocks output proven to return no data.
  - **Drift** blocks an asset whose original has been edited since it was staged.
- **Override flags:**
  - `--ignore-lint` when a reviewer has confirmed the tile works.
  - `--force` only after you have looked at the drift. For dashboards, a format-only change such as variable `version`/`name` fields added by the dashboard app is safe to force; a real edit by the owner is not.
  - `--republish` for notebooks already published.

Then check, and undo if needed:

```bash
cct migrate-verify   --tracker "<path>"
cct migrate-rollback --tracker "<path>" --ids <id> --apply
```

### 3e. When an owner edited the original during review

Restage that one asset from the owner's current version, and send it back to review:

1. Refresh its downloaded file from the live original. There's no single-asset command for this yet: re-run the download, or overwrite `tools/out/<env-id>/dashboards/new/<id>__*.json` with the live content.
2. Run `cct migrate-stage --restage --ids <id> --apply`.
3. Set its `decision` back to *Needs Review*, so the next publish doesn't pick it up unreviewed.

Restaging replaces the review copy, including the reviewer's edits, so tell the reviewer.

## 4. Alerts (Davis anomaly detectors)

Alerts are never published as a second copy: two armed copies would alert twice. Instead, converted queries go into **review notebooks**, which are inert, in batches.

```bash
cct download-anomaly-detectors                                   # refresh first; owners edit alerts too
cct discover-metrics                                             # metric inventory (~7 min); picks metric variants
cct discover-entity-arns                                         # new alerts may pin new classic ids
cct stage-detectors --tracker "<path>" --batch-size 25 --limit 100 --share-group <id>            # prepare
cct stage-detectors --tracker "<path>" --batch-size 25 --limit 100 --share-group <id> --apply    # create
```

That creates `[MIGRATION REVIEW] AWS alerts — batch-NN` notebooks (25 alerts each, 4 batches here), numbered after the last existing batch. Alerts already in a batch are skipped, and the `alerts` sheet records each alert as `staged` with its notebook and its `review_batch` (`batch-NN`). For rows staged before that column existed, `cct refresh-alert-tracker` backfills `review_batch` from the manifest. Each alert is a markdown card (what changed, threshold, warnings) plus a DQL tile. Reviewers fix the tile in place and record their decision and notes in the `alerts` sheet.

- **Entity binding:** an alert whose query has no entity in its split would reach the incident tool with no entity. The prepare step adds `dt.smartscape_source.id` to the split, after a read-only 7-day check of the series count:
  - **unchanged:** the grain is the same; nothing to check;
  - **larger, or no data to check:** the alert now fires per resource, and the card asks the reviewer to check the threshold;
  - **past 10,000 series,** Davis's per-detector limit, or a query shape it can't edit safely: left unbound, with a note on the card.

  `--no-bind-entities` skips it.
- **Before applying,** run a few prepared queries yourself. An empty result where the classic query has data is usually a metric that isn't collected in that account (add it to the AWS connection), not a translation mistake.
- `--group-by-team` batches by the team prefix in the alert title instead.
- `--restage` brings tool fixes to batches already out for review, in place (same notebook, link and sharing). It replaces only alerts nobody has touched: the card, query and verdict tiles must still be exactly as the tool last wrote them, and the alert's tracker row must have no decision, reviewer or notes. Everything else is kept as the reviewer left it. Prepare first; `--batches batch-14,batch-15` limits it. Snapshots go to `migration/detector-review/pre-restage/`.

### 4a. Publish a reviewed batch

Once reviewers have set `decision` = *Ready To Publish* on the `alerts` sheet, `migrate-promote-detectors` publishes those alerts **in place**: the same detector, the same settings object. It never creates a second one. Only the **query** and the **event fields** change. The threshold, sliding window, severity, enabled state and the user the alert runs as stay exactly as the original alert has them, and a disabled alert stays disabled.

Publish **one review batch at a time**. `--batches` is required; there is no "publish everything Ready" mode. The approved query is read live from the batch's review notebook, so reviewers can keep fixing tiles up to the moment you run it; there is no pull step. (`stage-detectors` prints a closing hint that mentions a `migrate-pull-detectors` command. It does not exist, and nothing needs it.)

Run it from the machine that staged the batch: it reads `migration/detector-review/manifest.json` and the batch's base payload from `tools/out/<env-id>/`.

**The loop for one batch:**

```bash
# 1. Prepare. Reads everything, runs every gate, writes no tenant change and nothing to the workbook.
cct migrate-promote-detectors --tracker "<path>" --batches batch-03

# 2. Read tools/out/<env-id>/migration/detector-promote/prepare/<stamp>/report.md  (see below)

# 3. Apply. --allow-env must name the environment your env file points at, or it refuses.
cct migrate-promote-detectors --tracker "<path>" --batches batch-03 --apply --allow-env <env-id>

# 4. Verify. Re-reads each published alert; never waits for it to fire.
cct migrate-verify-detectors --tracker "<path>" --batches batch-03
```

For a first run on an environment, add `--limit 5`, or name alerts with `--ids <a,b>`, then check the result in the Dynatrace UI before running the whole batch. For Prod, use `cctp` and the Prod workbook: same commands, same loop. The Prod token needs settings write; a prepare run proves it (its server validation persists nothing).

**Reading `report.md`.** It has a summary by batch, every skipped alert grouped by reason, the alerts going out under a `publish_override`, and then each alert with its query before and after and each event field before and after. An alert ends up as one of:

- **Ready:** passed every gate, and server validation (`validateOnly`) accepted the value.
- **Already published, recorded only:** the live alert already has the query and event fields a publish would write (someone applied it by hand, or an earlier run's sheet write failed). The apply records it on the sheet without writing to the alert.
- **Skipped:** one reason is given. The alert keeps its status and decision. An apply run writes the reason into the sheet's `reasons` column; a prepare run does not touch the sheet.

The usual reasons, and what to do about each:

| Reason in the report | What it means | What to do |
|---|---|---|
| drift: owner changed the alert after review | The live query is not the classic query the card was staged from, so the owner edited it after review. | Find out what changed. If the approved query covers it, publish that one alert with `--force --ids <id>`. If not, send it back to review. |
| drift: owner already migrated it | The live query changed and has no classic references left. | Usually nothing to publish. A reviewer sets *Descope*. |
| drift: staged version unknown | None of the base payload, the archived payload and the review tile still holds the classic query, so an owner edit can't be ruled out. | Check by hand, then `--force --ids <id>` if it's safe. |
| empty query | The tile has only comments and whitespace. | The reviewer fixes the tile. |
| blocking lint | A lint rule proves the query returns nothing. | Fix the query in the notebook. |
| the query fails on the tenant | The approved query, or the final one with its added columns, errors over the last 2 hours. | Fix it in the notebook. The message is in the report. |
| no entity: would fire per resource, back for review | The query emits no entity. Adding one splits the alert into one per resource. | Decide whether that is right and the threshold still makes sense; if so, set `publish_override` (below). Otherwise make the query emit one entity. |
| no entity: the query shape cannot take one, the binding check failed, or over the series cap once the entity is added | An entity can't be added automatically. | Make the query emit an entity itself, or, for an alert that is genuinely not about one resource, set `publish_override` to *Publish without entity*. |
| over the series cap | The final query produces more than 10,000 series over the last 2 hours. Davis stops monitoring new series past that, without an error. | Split by less, in the notebook. |
| event field names a column the query does not emit | An alert title or description reads a column the approved query doesn't produce, so it would go out with literal `{dims:…}` text. | Make the query emit that column, in the notebook. |
| server validation failed | The Settings API rejected the value; the message is in the report. | Read it, fix the query or tell the tool's owners. |
| drift: changed since planned | (Apply only.) The alert changed between planning and writing. Nothing was written. | Re-run; it plans that alert again. |

After a skip is fixed (the reviewer edits the tile, or the owner settles the change), run the same command again for the batch. Alerts already published are not selected again.

**Things to know.**

- **Event fields.** The tool points each field at a column the approved query emits, and sets the binding property `dt.smartscape_source.id` to the query's entity column. A placeholder that reads a column whose name has a space (`Cluster Name`) gets an underscore alias column added to the end of the query (`| fieldsAdd Cluster_Name = \`Cluster Name\``), because Davis filling spaced names hasn't been verified. The report shows every change.
- **Apply plans again from fresh reads.** It does not use the files an earlier prepare left. A prepare is a preview: anything that changed since is picked up, or skipped, by the apply.
- **Apply writes one alert at a time.** For each it re-reads the alert and skips it if anything in it changed since planning; saves the value it had to `migration/detector-promote/pre/<objectId>.json` (the first snapshot ever taken is kept); writes with the update token of that re-read; and re-reads to confirm. A server error on the write is settled by one re-read, never by sending it again. The first HTTP 401 or 403 stops the run; alerts already published are recorded.
- **Where the files go.** `tools/out/<env-id>/migration/detector-promote/`: `prepare/<stamp>/` and `apply/<stamp>/` (each with `report.md`, `plan.json` and `payloads/<objectId>.json`), `pre/` (snapshots) and `published/` (what each publish wrote; verify and rollback read it).
- **What the sheet gets.** An apply sets published alerts to `status` = promoted, `decision` = *Published*, with `promoted_at`. If the workbook is locked, the publish still happened: the command says so and names the ids; close the workbook and re-run the same command with `--ids <those ids>` added to record them. They are found already published and recorded without being written again.

**Verify.** `migrate-verify-detectors` (it reads the tenant and writes the sheet; there is no `--apply`) re-reads each promoted alert and compares its query and event fields with what was published. Equal sets `status` = verified and `verified_at`. Different puts the difference in `reasons` and leaves the status; someone edited the alert since, or the write didn't stick. An alert the tool only recorded has no published record to compare with: it reports "no published record" and leaves the status. Verify checks configuration only. Many alerts never reach their condition in any reasonable time, so nothing here waits for, or counts, alert events.

### 4b. `publish_override`: when a reviewer says an alert has no single entity

An alert whose approved query emits no entity would reach the incident tool attached to nothing. The tool adds the series' own entity itself when that leaves the alert as it was (the same 7-day series count as at staging, unchanged or no data to compare). Otherwise the alert is **skipped and goes back for review**. The `publish_override` column on the `alerts` sheet is how a reviewer releases it. It is a dropdown:

- **Publish per resource:** the alert will fire once per resource instead of once for the combined series. Choose it only after checking the threshold still makes sense per resource.
- **Publish without entity:** the alert is not about one resource (it is account- or environment-wide), so it goes out with no binding property. Any classic entity placeholder in its text is removed. The prepare report shows the exact before and after text.

Rules:

- It is honoured only on a row whose `decision` is *Ready To Publish* **and** whose `reviewer` is filled in, so every override has a name on it. Anything else, including a typo, is ignored and the report says why.
- It lifts the no-entity gate and nothing else. Drift, empty query, lint, query errors, the 10,000-series cap, unmapped event fields and server validation all still apply. *Publish per resource* cannot add an entity the tool couldn't add (past the series cap, an unsafe query shape); only *Publish without entity* releases those.
- Leave it blank otherwise. If the query already emits an entity, an override is not needed and the report says so.
- The tool never writes the column. The report lists every alert published under an override.

### 4c. Roll back

```bash
cct migrate-rollback-detectors --tracker "<path>" --ids <id>                                       # prepare
cct migrate-rollback-detectors --tracker "<path>" --ids <id> --apply --allow-env <env-id>          # one alert
cct migrate-rollback-detectors --tracker "<path>" --batches batch-03 --apply --allow-env <env-id> # a whole batch
```

Either `--ids` or `--batches` is required; a rollback never takes every published alert.

- **It puts back only what the publish wrote:** the query and the event fields, from the snapshot in `pre/`, onto the alert's **current** value. If the owner has changed the threshold or turned the alert off since, that stays.
- **It refuses an alert whose query or event fields were edited after publishing,** and says which differ, because restoring would discard that edit. Once a person has looked, `--force --ids <id>` restores it anyway. `--force` needs `--ids`. The value from just before the rollback is saved under the run's `before/<id>.json`.
- **An alert with no snapshot** (the tool recorded it but never published it) can't be rolled back. Do it by hand.
- **Sheet:** `status` = rolled-back, and `decision` is set back to *Needs Review*, so the next publish run leaves the alert alone until a person approves it again.
- Prepare writes the plan and payloads to `migration/detector-rollback/prepare/<stamp>/`; apply writes to `migration/detector-rollback/apply/<stamp>/`.

### 4d. Soak check, by hand

Some hours after a batch goes live, list the batch's detectors whose run status went to ERROR or WARNING since publishing. Take the ids from the batch's rows on the `alerts` sheet (filter `review_batch`), or from the apply `report.md`:

```
fetch dt.system.events, from:-24h
| filter event.kind == "ANOMALY_DETECTOR_STATUS_EVENT"
| filter in(dt.settings.object_id, array(<ids of the batch>))
| summarize n = count(), by:{dt.settings.object_id, davis.anomaly_detector.status, davis.anomaly_detector.message}
```

Some errors are platform-wide and transient. In a week on the lower environment, 1,001 detectors had at least one 10-second query timeout and 1,386 had at least one "couldn't schedule", so compare against how the alert behaved before publishing. An alert that was already erroring before it was published is not a publish problem.

## 5. Improving the rewriter from what reviewers find

This is where most of the quality comes from. After a batch has been reviewed:

1. **Compare** each approved query with what the current rewriter produces for the same original.
2. **Run both** against the environment. Text differences overstate the problem, because reviewers reword things; row counts settle it.
3. **Sort the differences into three kinds:**
   - **Rewriter mistake:** fix it, with a test that cites the measurement.
   - **Configuration:** the metric isn't collected on the new connection; add it to the AWS connection.
   - **Reviewer rework or improvement:** fine; nothing to change in the tool.
4. **Carry the fix to review copies already out,** but only to tiles no reviewer has touched: compare each tile with what was staged and leave edited tiles alone.

Before trusting any new translation rule, run the classic and translated forms side by side and compare the rows.

## 6. Rules of thumb

- **Prepare first, read the output, then `--apply`.** Every write command supports this.
- **Verify by re-reading the environment,** not by trusting the command's own success message.
- **Owners are not emailed.** Shares and ownership transfers are sent with notifications off.
- **Never commit credentials,** or anything from `tools/out/`, which holds customer data.
- **Workbook locked?** If the tracker is open in Excel or OneDrive, writes fail with `EBUSY`. Publishing still happens; re-run the same command later to record it.
