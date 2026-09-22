/**
 * output-lint — refuse to publish DQL shapes we have PROVEN return nothing.
 *
 * WHY THIS EXISTS. The rewriter was correct on both dashboards in the 2026-09-18
 * conversion experiment; the breakage arrived afterwards, from edits made during
 * review. Two of the three published dashboards carrying a proven-empty pattern
 * were approved by a human and promoted, because the tiles render without error
 * — an empty chart looks exactly like a quiet one.
 *
 * So this is not a second rewriter. It is a gate over whatever content is about
 * to be published, whoever wrote it. Every rule below cites the measurement that
 * justifies it, because a lint that cannot say WHY gets overridden.
 *
 * Kept pure (no fetch, no fs) so promote, a scan, or an App can all run it.
 */

export type LintSeverity = 'blocking' | 'advisory';

export interface LintRule {
  id: string;
  severity: LintSeverity;
  /** What is wrong, and the measurement that proves it. */
  message: string;
  /** Matches the offending text in a single query. */
  test: (query: string) => boolean;
  /** The form that does work, when there is one. */
  fix?: string;
}

/** Strip `//` reference comments — we lint what RUNS, not the annotation. */
export function liveQuery(q: string): string {
  return (
    q
      .split(/\r?\n/)
      .filter((l) => !/^\s*\/\//.test(l))
      .join('\n')
      // Also drop /* … */ blocks: reviewers park an old version of a query in
      // one, and flagging code the engine never runs trains people to ignore
      // the lint.
      .replace(/\/\*[\s\S]*?\*\//g, '')
  );
}

export const LINT_RULES: LintRule[] = [
  {
    id: 'service-tags-null',
    severity: 'blocking',
    message:
      'Reads an AWS tag field off a Smartscape SERVICE node. Verified on nic55601: 0 of 24,426 ' +
      'SERVICE nodes have a non-null `tags:aws`, so this can never match. The pattern is correct ' +
      'for AWS resources and was copied onto a service.',
    fix: 'in("<key>:<value>", entityAttr(dt.entity.service, "tags"))  — verified at exact parity (150 = 150)',
    test: (q) => /getNodeField\(\s*dt\.smartscape\.service\s*,\s*"tags(:aws)?"\s*\)/.test(q),
  },
  {
    id: 'classic-selector-smartscape-dim',
    severity: 'blocking',
    message:
      'Passes a Smartscape dimension to classicEntitySelector(). The selector resolves classic ' +
      'entity ids, so the two never intersect — verified live: 0 rows where the all-classic form ' +
      'returned data. This is the shape a partial conversion produces.',
    fix: 'Either keep the whole predicate classic, or convert it fully (entityAttr/entityName on the classic dim).',
    test: (q) => /in\(\s*`?dt\.smartscape\.[\w:]+`?\s*,\s*classicEntitySelector\(/.test(q),
  },
  {
    id: 'classic-relationship-smartscape-dim',
    severity: 'blocking',
    message:
      'A relationship projection mixing the two models. On a classic `fetch` it is fatal — verified ' +
      'live: DQL 400 FIELD_DOES_NOT_EXIST. On a `smartscapeNodes` query it parses but the field is ' +
      'always null: can_access[dt.smartscape.…] and references[can_access.…] both returned 0 non-null ' +
      'across all 996 AWS_ACCOUNT nodes.',
    fix: 'Collapse the chain to the resource node’s own field (e.g. aws.account.id), or keep it classic.',
    test: (q) =>
      /\b(accessible_by|belongs_to|runs|instance_of|clustered_by|can_access)\s*\[\s*`?dt\.smartscape\./.test(q),
  },
  {
    id: 'record-passed-to-string-function',
    severity: 'blocking',
    message:
      'A string function is given `tags` from a Smartscape node. The column exists but is a RECORD, ' +
      'so the call returns no rows without erroring. Measured on AWS_ECS_CLUSTER: classic 6 rows, ' +
      'unwrapped 0, toString(tags) 12.',
    fix: 'Wrap it: toString(tags)',
    test: (q) =>
      /\bsmartscapeNodes\b/.test(q) &&
      /\b(matchesPhrase|matchesValue|contains|startsWith|endsWith)\(\s*tags\s*[,)]/.test(q),
  },
  {
    id: 'emr-ec2-namespace',
    severity: 'blocking',
    message:
      'Uses the `cloud.aws.emr_ec2.*` namespace. Verified on nic55601: 0 series, while the same ' +
      'metric under `cloud.aws.elasticmapreduce.*` returns data (16 series grouped by cluster). ' +
      'The DAC lists emr_ec2 but the new connection never emits it.',
    fix: 'Use cloud.aws.elasticmapreduce.<Metric>.By.<Dim>',
    test: (q) => /cloud\.aws\.emr_ec2\./.test(q),
  },
  {
    id: 'match-operator-padded-literal',
    severity: 'blocking',
    message:
      'The `~` match operator is given a literal with leading or trailing whitespace. `~` matches, ' +
      'it does not test substrings, so the padding makes it match nothing. Verified: the padded ' +
      'form returned 0 rows and the trimmed form 1.',
    fix: 'Trim the literal, or use contains(<field>, "<text>") if a substring test was intended.',
    test: (q) => /~\s*"(?:\s+[^"]*|[^"]*\s+)"/.test(q),
  },
  {
    id: 'smartscape-name-semantics',
    severity: 'advisory',
    message:
      'Filters on a Smartscape node NAME. Classic and Smartscape hold different names for the same ' +
      'service — observed: "cuw-qa-mtrvl-1-blu-liveactivity - United.Mobile.Services.LiveActivity.Api" ' +
      'classically vs "United.Mobile.Services.LiveActivity.Api" in Smartscape. The filter may still ' +
      'run and silently select a different set.',
    fix: 'Confirm the match still selects the intended entities, or read the classic name via entityName(dt.entity.<type>).',
    test: (q) =>
      /(?:contains|startsWith|endsWith|matchesPhrase)\(\s*getNodeField\(\s*dt\.smartscape\.[\w:]+\s*,\s*"name"\s*\)/.test(q) ||
      /getNodeField\(\s*dt\.smartscape\.[\w:]+\s*,\s*"name"\s*\)\s*(?:~|==)/.test(q),
  },
  {
    id: 'metric-streams-left-unconverted',
    severity: 'advisory',
    message:
      'An AWS Metric Streams key (camelCase metric with concatenated dimensions). Most of these have ' +
      'a polled equivalent already flowing — 47 of 63 on nic55601, 27 of 45 on sfz80352 — so leaving ' +
      'it classic may be unnecessary.',
    fix: 'Re-run the rewriter; it swaps the key and renames the dimensions to the polled spelling.',
    test: (q) => /(?:dt\.)?cloud\.aws\.[a-z0-9_]+\.[a-z][A-Za-z0-9]*By[A-Z][A-Za-z0-9]*/.test(q),
  },
];

export interface LintFinding {
  ruleId: string;
  severity: LintSeverity;
  message: string;
  fix?: string;
  /** Where the query lives in the asset (tile path / section key). */
  location: string;
  excerpt: string;
}

/** Lint one query. */
export function lintQuery(query: string, location = ''): LintFinding[] {
  const live = liveQuery(query);
  const out: LintFinding[] = [];
  for (const r of LINT_RULES) {
    if (!r.test(live)) continue;
    out.push({
      ruleId: r.id,
      severity: r.severity,
      message: r.message,
      fix: r.fix,
      location,
      excerpt: live.replace(/\s+/g, ' ').trim().slice(0, 160),
    });
  }
  return out;
}

/** Walk an asset's content and lint every DQL string in it. */
export function lintAsset(content: unknown): LintFinding[] {
  const out: LintFinding[] = [];
  const walk = (x: any, path: string) => {
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) {
      if ((k === 'query' || k === 'value') && typeof v === 'string' && v.trim()) {
        out.push(...lintQuery(v, path || k));
      } else if (v && typeof v === 'object') {
        walk(v, path ? `${path}/${(v as any).key ?? k}` : String((v as any).key ?? k));
      }
    }
  };
  walk(content, '');
  return out;
}

export function summarize(findings: LintFinding[]): { blocking: number; advisory: number; byRule: Record<string, number> } {
  const byRule: Record<string, number> = {};
  let blocking = 0;
  let advisory = 0;
  for (const f of findings) {
    byRule[f.ruleId] = (byRule[f.ruleId] ?? 0) + 1;
    if (f.severity === 'blocking') blocking++;
    else advisory++;
  }
  return { blocking, advisory, byRule };
}
