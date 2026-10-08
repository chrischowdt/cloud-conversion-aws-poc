# Decisions — and why

The rules this migration runs by. Most came from something going wrong once. If you want to change one, read the reason first.

## How queries are translated

- **Translate directly; don't rework.** Convert only what the new data model forces, and leave the author's structure alone, even when the query is poorly written. That keeps the diff reviewable, and keeps the tool out of the business of guessing intent. Improvements are the reviewer's call, not the tool's.
- **AWS only.** Non-AWS entities (services, hosts, Kubernetes, Azure) are left exactly as they are. Converting them over-reached and broke working queries.
- **Proven, not plausible.** A translation rule is added only after running the classic and translated forms side by side on a real environment and comparing rows. The measurement goes in the code comment and the test.
- **Output proven to return nothing is blocked** (`lib/output-lint.ts`). The typical failure isn't an error. It's a query that runs and returns nothing, which on a dashboard looks like a quiet tile and on an alert looks like no incidents.
- **Tag keys use the casing resources actually carry** (`ApplicationCI`, `env`, `Environment`, `Name`). Teams whose tags don't follow the standard fix their tags; the tool doesn't case-fold.
- **Region comes from the resource's `aws.region` field,** not from the classic `location` tag, which isn't present everywhere.
- **Classic entity ids don't exist on the new side.** A query pinned to one resource by id is re-pinned by its **ARN**, which every classic entity, new metric series and new entity carries.

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
