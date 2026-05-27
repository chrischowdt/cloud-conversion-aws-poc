/**
 * Classic-field-name → Smartscape-field-name mappings, per Smartscape node
 * type. Used by the rewriter when a `fetch dt.entity.X` was restructured to
 * `smartscapeNodes <TYPE>`: bare field references that worked in the classic
 * world (`awsAccountId`, `rdsEngine`, …) need renaming to the Smartscape
 * field name on the same node.
 *
 * Source of truth: ground-truth tenant queries (`smartscapeNodes <TYPE> |
 * limit 5` → discoverable field set) combined with the classic field names
 * actually used by dashboards in the wild (mined from the dashboard scan).
 * Add new entries here as comparison runs surface missing ones.
 *
 * NOTE: entries here translate BARE identifiers (e.g. `awsAccountId`) in
 * post-fetch pipeline clauses. They do not handle quoted strings, the
 * `entityAttr(x, "field")` form (which the rewriter already converts via
 * getNodeField), or fields nested inside `aws.object`.
 */

export interface FieldMapping {
  classicField: string;
  smartscapeField: string;
  /** Free-form note: ground-truth source, caveats. */
  notes?: string;
}

export const ENTITY_FIELD_MAPPINGS_BY_NODE_TYPE: Record<string, FieldMapping[]> = {
  AWS_ACCOUNT: [
    { classicField: 'awsAccountId', smartscapeField: 'aws.account.id', notes: 'Verified on tenant 2026-05-12.' },
  ],
  AWS_RDS_DBINSTANCE: [
    {
      classicField: 'rdsEngine',
      smartscapeField: 'db.system',
      notes:
        'Smartscape has db.system carrying values like "aurora-mysql"; classic rdsEngine carried the same. ' +
        'Verify on tenant before relying — engine-name encoding may differ slightly.',
    },
  ],
  // Add more entries as comparison runs reveal them. The shape is per-node-type
  // because the same classic field name could rename differently depending on
  // which entity type it lives on.
};

/**
 * Look up the Smartscape field name for a classic field on a given node type.
 * Returns null when no mapping is known (the caller should leave the
 * identifier alone or warn).
 */
export function smartscapeFieldFor(
  smartscapeNodeType: string,
  classicField: string
): FieldMapping | null {
  const table = ENTITY_FIELD_MAPPINGS_BY_NODE_TYPE[smartscapeNodeType];
  if (!table) return null;
  return table.find((m) => m.classicField === classicField) ?? null;
}
