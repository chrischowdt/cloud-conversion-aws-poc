/**
 * Restaging alert review notebooks card by card.
 *
 * A review notebook holds three sections per alert: the markdown card
 * (`md-<id>`), the query (`dql-<id>`) and the reviewer's verdict (`review-<id>`).
 * Reviewers fix queries in place and record verdicts there or in the tracker,
 * so re-rendering a whole notebook to bring a rewriter fix would discard their
 * work. Instead each card is compared with the BASE, the payload the tool last
 * wrote for it, and replaced only when all three sections are still exactly
 * that and the tracker records nothing for the alert. Running a query does not
 * count as touching it (only the query text and markdown are compared), but
 * the stale stored result goes with the old query.
 *
 * The base moves forward only for the cards that were replaced, so a card a
 * reviewer edited keeps differing from it and is never overwritten later.
 * Pure: the command does the tenant I/O.
 */

type Section = { id: string; type: string; markdown?: string; state?: { input?: { value?: string } } & Record<string, unknown> } & Record<string, unknown>;
type Notebook = { sections: Section[] } & Record<string, unknown>;

export type CardAction =
  | 'restage' //   untouched, and the new rendering differs: replaced
  | 'current' //   untouched, already what the tool renders today
  | 'edited' //    a reviewer changed the card, query or verdict in the notebook
  | 'reviewed' //  the tracker records a decision, reviewer or notes for it
  | 'missing' //   a section is missing from the live notebook or the base
  | 'unresolved'; // the alert no longer renders (bucket, or no query)

export interface CardPlan {
  objectId: string;
  action: CardAction;
}

const text = (s: Section | undefined): string =>
  s?.type === 'dql' ? String(s.state?.input?.value ?? '') : String(s?.markdown ?? '');

/**
 * @param fresh   objectId → today's md and dql sections for that alert
 * @param ids     the alerts in this notebook, in order
 * @param reviewed alerts whose tracker row carries a decision, reviewer or notes
 */
export function planRestage<N extends Notebook>(
  live: N,
  base: Notebook,
  fresh: Map<string, Section[]>,
  ids: string[],
  reviewed: Set<string>,
): { next: N; nextBase: Notebook; plans: CardPlan[] } {
  const next = structuredClone(live);
  const nextBase = structuredClone(base);
  const at = (nb: Notebook, id: string) => nb.sections.findIndex((s) => s.id === id);
  const plans: CardPlan[] = [];
  for (const id of ids) {
    const card = [`md-${id}`, `dql-${id}`, `review-${id}`];
    const plan = (action: CardAction) => plans.push({ objectId: id, action });
    if (reviewed.has(id)) { plan('reviewed'); continue; }
    if (card.some((c) => at(live, c) < 0 || at(base, c) < 0)) { plan('missing'); continue; }
    if (card.some((c) => text(live.sections[at(live, c)]) !== text(base.sections[at(base, c)]))) { plan('edited'); continue; }
    const rendered = fresh.get(id);
    if (!rendered) { plan('unresolved'); continue; }
    if (rendered.every((s) => text(s) === text(live.sections[at(live, s.id)]))) { plan('current'); continue; }
    for (const s of rendered) {
      next.sections[at(next, s.id)] = structuredClone(s);
      nextBase.sections[at(nextBase, s.id)] = structuredClone(s);
    }
    plan('restage');
  }
  return { next, nextBase, plans };
}
