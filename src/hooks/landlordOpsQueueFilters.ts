/**
 * The filter that defines each Landlord Ops queue, in one place.
 *
 * These exist because a badge and the queue it points at were computed
 * separately and disagreed: the LC1 badge counted every unverified chairperson
 * (~11.8k) while the LC1 inbox opened on agent-raised requests only, and the
 * "New today" sub-labels counted *all* rows created today regardless of status,
 * so a card could read "0 awaiting sign-off / New today: 5".
 *
 * Anything that counts or lists one of these queues must apply the filter from
 * here, so the headline, the badge, the "new today" subset and the panel behind
 * the link are always describing the same population.
 */

/** What a `head: true, count: 'exact'` query resolves to. */
export interface QueueCountResult {
  count: number | null;
  error: { message: string } | null;
}

/**
 * The subset of the PostgREST builder these filters use. It stays `PromiseLike`
 * so a filtered builder can still be awaited for its count, and every method
 * returns `this` so the concrete builder type survives the chain.
 */
export interface QueueFilterable extends PromiseLike<QueueCountResult> {
  eq(column: string, value: unknown): this;
  neq(column: string, value: unknown): this;
  in(column: string, values: readonly unknown[]): this;
  not(column: string, operator: string, value: unknown): this;
  or(filters: string): this;
  gte(column: string, value: unknown): this;
}

/** Houses on the verification desk: unverified, not dead, past the Service Centre. */
export function housesAwaitingVerification<T extends QueueFilterable>(q: T): T {
  return q
    .eq('verified', false)
    .not('status', 'in', '(rejected,delisted)')
    .in('service_center_status', ['not_required', 'passed']);
}

/** Landlords needing verification, excluding those still with a Service Centre manager. */
export function landlordsAwaitingVerification<T extends QueueFilterable>(q: T): T {
  return q.neq('service_center_status', 'pending').or('verified.is.null,verified.eq.false');
}

/**
 * LC1 chairpersons that actually need a decision now: pending *and* with an open
 * agent request, because those block a rent application. This mirrors
 * `Lc1VerificationInboxPanel`'s `agent_requested` bucket — the tab that opens
 * when the sidebar link is followed. The broader `status = 'pending'` set is a
 * registry backlog, not a work queue, and counting it made the badge disagree
 * with the panel by four orders of magnitude.
 */
export function lc1AwaitingVerification<T extends QueueFilterable>(q: T): T {
  return q
    .neq('service_center_status', 'pending')
    .eq('status', 'pending')
    .eq('agent_request_open', true);
}

/** Rent requests parked at the stage Landlord Ops signs off. */
export function rentRequestsAwaitingLandlordOps<T extends QueueFilterable>(q: T): T {
  return q.eq('status', 'tenant_ops_approved');
}

/** Landlord payouts awaiting operational review (CFO sign-off is a later status). */
export function payoutsAwaitingLandlordOps<T extends QueueFilterable>(q: T): T {
  return q.eq('status', 'pending_landlord_ops');
}
