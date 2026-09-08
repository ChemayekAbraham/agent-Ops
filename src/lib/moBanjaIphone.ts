/**
 * Mo Banja iPhone programme — presentation copy only.
 *
 * Mo Banja sells iPhones on credit and requires a down payment of at least 40%
 * of the phone price. Welile funds that down payment for good-standing agents
 * and recovers it, plus its charge, from the agent's wallet or commission.
 *
 * Every iPhone amount held in Welile is the Mo Banja DOWN PAYMENT, never the
 * full phone price (we do not hold the full price). The remaining balance is
 * owed to Mo Banja directly and is paid weekly, outside the Welile platform.
 *
 * This module carries no money logic — pricing, deductions and ledger postings
 * are unchanged.
 */

/** True when a catalogue brand/model belongs to the Mo Banja iPhone programme. */
export function isMoBanjaIphone(brand?: string | null, model?: string | null): boolean {
  const b = (brand || '').trim().toLowerCase();
  const m = (model || '').trim().toLowerCase();
  return b === 'apple' || b.startsWith('iphone') || m.startsWith('iphone');
}

export const MO_BANJA = {
  partner: 'Mo Banja',
  /** Label for the amount Welile funds. */
  amountLabel: 'Down payment (Mo Banja)',
  amountLabelShort: 'Down payment',
  amountNote:
    'This is the minimum down payment Mo Banja requires before it releases the iPhone. It is not the full phone price — the balance is owed to Mo Banja directly.',
  twoLegs: [
    'Pay Welile daily — deducted from your wallet balance or your commission.',
    'Pay Mo Banja weekly — paid directly to Mo Banja, outside the Welile app.',
  ],
  lockNotice:
    'Mo Banja installs remote management software on every iPhone it releases. If repayment stops on either side, Mo Banja can lock the iPhone until you are up to date.',
  opsNote:
    'Welile funds the Mo Banja down payment only. The agent also pays Mo Banja weekly outside this platform, so a clean Welile record does not mean the agent is current with Mo Banja.',
} as const;
