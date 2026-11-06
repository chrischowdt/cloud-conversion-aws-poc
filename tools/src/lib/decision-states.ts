/**
 * decision-states — the migration team's shared review vocabulary.
 *
 * Extracted so BOTH the spreadsheet tracker and the in-product review notebooks
 * speak exactly the same language. A reviewer marking a query in a notebook and
 * a reviewer setting a row in the tracker are doing the same thing, and a second
 * near-miss vocabulary ("Converted OK" vs "Ready To Publish") would mean every
 * roll-up needs a translation table nobody can keep straight.
 *
 * Lives in its own module because `tracker-xlsx.ts` pulls in exceljs, and the
 * notebook builder is deliberately dependency-free so it can be lifted into the
 * Dynatrace App.
 */

/**
 * The `decision` vocabulary (tracker column V). Reviewers pick from the first
 * four; the automation sets `Published` itself after a successful cutover.
 */
export const DECISION_STATES = [
  'Descope', // exclude from any automated conversion
  'Needs Review', // has a conversion blocker
  'In Progress', // someone is actively reviewing
  'Ready To Publish', // automation may cut the review copy over the original
  'Published', // set BY the automation after cutover
] as const;
export type DecisionState = (typeof DECISION_STATES)[number];

/** The states a human is meant to choose from (everything the tool doesn't own). */
export const REVIEWER_CHOICES = DECISION_STATES.filter((s) => s !== 'Published');

/**
 * What a freshly generated review item starts as. "Needs Review" rather than a
 * separate "Not Reviewed": it is already the tracker's word for "not ready", and
 * the only state that authorizes any action is `Ready To Publish` — which nobody
 * reaches by accident.
 */
export const DEFAULT_DECISION: DecisionState = 'Needs Review';

/** The decision value that authorizes the automation to publish. */
export const READY_TO_PUBLISH = 'Ready To Publish';
/** The decision value the automation writes back after a successful cutover. */
export const PUBLISHED = 'Published';

/** True when a (raw, any-case) decision cell means "ready to publish". */
export function isReadyToPublish(decision: string | undefined): boolean {
  return (decision ?? '').trim().toLowerCase() === READY_TO_PUBLISH.toLowerCase();
}
/** True when a (raw, any-case) decision cell means "already published". */
export function isPublished(decision: string | undefined): boolean {
  return (decision ?? '').trim().toLowerCase() === PUBLISHED.toLowerCase();
}

/**
 * Resolve free-typed text onto the vocabulary, tolerating the ways people
 * actually write (case, bold/backtick markers, trailing punctuation). Returns
 * `undefined` for anything unrecognized — callers must surface that verbatim
 * rather than snapping it to the nearest state, so a typo can never become an
 * approval.
 */
export function canonicalDecision(raw: string | undefined): DecisionState | undefined {
  const cleaned = (raw ?? '').replace(/[*_`]/g, '').trim().replace(/[.,;]+$/, '');
  return DECISION_STATES.find((s) => s.toLowerCase() === cleaned.toLowerCase());
}

/**
 * The `publish_override` vocabulary (alerts sheet; the dropdown on the cell
 * offers exactly these two words). It only lifts the "emits no entity" gate on
 * publishing an alert:
 *   per-resource   — the reviewer accepts that the alert fires once per resource
 *   without-entity — the alert is not about one resource; it goes out unbound
 * Blank means "no override": the tool decides from its own checks.
 */
export const PUBLISH_OVERRIDES = ['Publish per resource', 'Publish without entity'] as const;
export type PublishOverride = 'per-resource' | 'without-entity';

// A Map, not an object literal: a typed `constructor` or `toString` must not
// resolve to an inherited property.
const PUBLISH_OVERRIDE_BY_TEXT = new Map<string, PublishOverride>([
  ['publish per resource', 'per-resource'],
  ['publish without entity', 'without-entity'],
]);

/**
 * Read a raw `publish_override` cell (case, surrounding space and trailing
 * `.,;` tolerated). `undefined` = nothing chosen; `'invalid'` = something typed
 * that is not on the list. Callers must not treat `'invalid'` as an override and
 * must not guess the nearest word: an override authorizes a publish the tool
 * would not make by itself, so a typo must never become one.
 */
export function parsePublishOverride(cell: string | undefined): PublishOverride | 'invalid' | undefined {
  const cleaned = (cell ?? '').trim().toLowerCase().replace(/[.,;]+$/, '');
  if (!cleaned) return undefined;
  return PUBLISH_OVERRIDE_BY_TEXT.get(cleaned) ?? 'invalid';
}
