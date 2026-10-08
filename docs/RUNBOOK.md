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

**The tracker** is one Excel workbook per environment, kept somewhere the review team can open it (not in the repo). It has a `migration` sheet (dashboards and notebooks) and an `alerts` sheet (Davis anomaly detectors). Pass it with `--tracker "<path>"` on every command, or set `DT_TRACKER_PATH`. Reviewers own the `assignee`, `decision`, `reviewer` and `notes` columns; the tool owns the rest. Decisions are a fixed list: **Descope · Needs Review · In Progress · Ready To Publish · Published**. The tool only ever writes *Published*.

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
cct stage-detectors --tracker "<path>" --batch-size 25 --limit 100 --share-group <id>            # prepare
cct stage-detectors --tracker "<path>" --batch-size 25 --limit 100 --share-group <id> --apply    # create
```

That creates `[MIGRATION REVIEW] AWS alerts — batch-NN` notebooks (25 alerts each, 4 batches here), numbered after the last existing batch. Alerts already in a batch are skipped, and the `alerts` sheet records each alert as `staged` with its notebook. Each alert is a markdown card (what changed, threshold, warnings) plus a DQL tile. Reviewers fix the tile in place and record their decision and notes in the `alerts` sheet.

- `--group-by-team` batches by the team prefix in the alert title instead.
- `--restage` re-renders existing batches in place. It overwrites the tiles, so only use it on batches nobody has started.

> ⚠️ **Publishing approved alerts is not built yet.** `stage-detectors` mentions `migrate-pull-detectors` / `migrate-promote-detectors`; those commands do not exist. Approved alerts currently stay at *Ready To Publish* in the tracker.

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
