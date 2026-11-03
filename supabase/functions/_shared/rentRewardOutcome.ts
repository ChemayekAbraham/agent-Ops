// Outcome of post_rent_facilitation_reward (migration 20261024170000), as process-supporter-roi acts on it.
// The database posts a reward in one transaction: if it did not post, nothing was recorded and the next run retries
// the same payment number. Pure function — no I/O — so it can be unit-tested.

export type RentRewardAction = 'posted' | 'skip' | 'defer' | 'error';

export interface RentRewardOutcome {
  action: RentRewardAction;
  reason: string;
}

interface RpcError { code?: string; message?: string }

export function classifyRentRewardPost(data: unknown, error: RpcError | null | undefined): RentRewardOutcome {
  if (error) {
    const msg = String(error.message ?? '');
    // Reinvest target held by the CFO or no longer an active portfolio of the supporter: the reward waits.
    // It is NOT paid to the wallet instead — that would change the partner's chosen treatment.
    if (msg.includes('PORTFOLIO_ON_HOLD')) return { action: 'defer', reason: 'reinvest_portfolio_on_hold' };
    if (msg.includes('RENT_REWARD_REINVEST_TARGET_UNAVAILABLE')) return { action: 'defer', reason: 'reinvest_portfolio_unavailable' };
    return { action: 'error', reason: msg || 'post_rent_facilitation_reward failed' };
  }
  const status = (data as { status?: string } | null)?.status;
  switch (status) {
    case 'posted': return { action: 'posted', reason: 'posted' };
    case 'already_posted': return { action: 'skip', reason: 'already_posted' };
    case 'not_due': return { action: 'skip', reason: 'not_due' };
    case 'not_eligible': return { action: 'skip', reason: 'not_eligible' };
    // A row from the old flow with the schedule not advanced: never posted over automatically; see
    // rent_reward_posting_gaps() for the CFO.
    case 'recorded_without_schedule': return { action: 'skip', reason: 'recorded_without_schedule_needs_review' };
    default: return { action: 'error', reason: `unexpected result: ${JSON.stringify(data)}` };
  }
}
