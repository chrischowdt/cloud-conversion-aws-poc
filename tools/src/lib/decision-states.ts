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
