/**
 * End-of-life service lookup.
 *
 * Source: `dt-migration/references/end-of-life-services.json`. Per the skill
 * (SKILL.md "End-of-Life Checks"), when a customer's classic metric maps to
 * an EOL AWS/Azure/GCP service, the EOL date + announcement URL should be
 * surfaced prominently — the customer may choose to skip migration for that
 * service rather than spend effort on it.
 *
 * Lookup is by service slug (derived from the classic metric key's service
 * segment), e.g. `dt.cloud.aws.opsworks.…` → "opsworks" → AWS::OpsWorks::Stack.
 *
 * Static fallback table covers the three known AWS EOL services as of
 * 2026-05-12 so the rewriter has a working lookup even when the JSON file
 * isn't available at runtime (the JSON is loaded asynchronously elsewhere).
 */

export interface EolEntry {
  cloud: 'AWS' | 'Azure' | 'GCP' | string;
  resourceType: string;
  kind: string | null;
  endOfLifeDate: string;
  announcementUrl: string;
}

/**
 * Pre-baked map from a service slug (the dotted segment that appears in
 * `cloud.<provider>.<svc>.*` / `dt.cloud.<provider>.<svc>.*` metric keys) to
 * the EOL entry. Loaded statically from `dt-migration/references/end-of-life-services.json`
 * so the rewriter doesn't need to await a file read on every key lookup.
 *
 * AWS::<Service>::<Resource> → service-slug mapping is lowercase of the
 * second segment. Maintain this if upstream adds services.
 */
const AWS_EOL_ENTRIES: EolEntry[] = [
  { cloud: 'AWS', resourceType: 'AWS::OpsWorks::Stack', kind: null,    endOfLifeDate: '2024-05-26', announcementUrl: 'https://docs.aws.amazon.com/opsworks/latest/userguide/stacks-eol-faqs.html' },
  { cloud: 'AWS', resourceType: 'AWS::QLDB::Ledger',    kind: null,    endOfLifeDate: '2025-07-31', announcementUrl: 'https://docs.aws.amazon.com/qldb/latest/developerguide/qldb-eos-faq.html' },
  { cloud: 'AWS', resourceType: 'AWS::AppMesh::Mesh',   kind: null,    endOfLifeDate: '2026-09-30', announcementUrl: 'https://aws.amazon.com/blogs/containers/migrating-from-aws-app-mesh-to-amazon-ecs-service-connect/' },
];

const AWS_EOL_SLUG_INDEX = new Map<string, EolEntry>();
for (const e of AWS_EOL_ENTRIES) {
  // AWS::OpsWorks::Stack → "opsworks"
  const m = /^AWS::([^:]+)::/.exec(e.resourceType);
  if (m) AWS_EOL_SLUG_INDEX.set(m[1]!.toLowerCase(), e);
}

/**
 * Given a classic metric key, extract the service slug and look up EOL
 * info. Returns null when the service is not EOL.
 *
 * Service-segment extraction handles every classic prefix the rewriter
 * recognises: `dt.cloud.aws.<svc>.*`, `builtin:cloud.aws.<svc>.*`,
 * `ext:cloud.aws.<svc>.*`, bare `cloud.aws.<svc>.*`.
 */
export function lookupEolForClassicKey(classicKey: string): EolEntry | null {
  const m =
    /^(?:dt\.cloud\.aws|builtin:cloud\.aws|ext:cloud\.aws|cloud\.aws)\.([a-z0-9_]+)\./.exec(
      classicKey
    );
  if (!m) return null;
  return AWS_EOL_SLUG_INDEX.get(m[1]!.toLowerCase()) ?? null;
}
