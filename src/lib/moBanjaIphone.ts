/**
 * Smartphone down-payment programme — presentation copy only.
 *
 * EVERY smartphone amount held in Welile is a DOWN PAYMENT, never the full
 * phone price. Welile funds that down payment for good-standing agents and
 * recovers it, plus its charge, from the agent's wallet or commission. The
 * remaining balance of the phone price is owed to the supplier directly and is
 * paid on the supplier's own plan, outside the Welile platform.
 *
 * Mo Banja is the iPhone supplier: it sells on credit, requires a down payment
 * before release, and runs its own repayment plan. iPhone copy names Mo Banja
 * explicitly; other brands use supplier-neutral wording.
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
    'Pay Mo Banja on their own repayment plan — paid directly to Mo Banja, outside the Welile app.',
  ],
  lockNotice:
    'Mo Banja installs remote management software on every iPhone it releases. If repayment stops on either side, Mo Banja can lock the iPhone until you are up to date.',
  opsNote:
    'Welile funds the Mo Banja down payment only. The agent also repays Mo Banja on Mo Banja’s own plan outside this platform, so a clean Welile record does not mean the agent is current with Mo Banja.',
} as const;

export interface DownPaymentCopy {
  /** Supplier name when known, otherwise null. */
  partner: string | null;
  /** Heading for the explanatory block. */
  title: string;
  /** Full label for the amount Welile funds. */
  amountLabel: string;
  /** Compact label for tables and cards. */
  amountLabelShort: string;
  /** One-line explanation that the amount is not the full phone price. */
  amountNote: string;
  /** The two repayment legs the agent carries. */
  twoLegs: readonly string[];
  /** Supplier device-lock warning, when the supplier applies one. */
  lockNotice: string | null;
  /** Agent Ops caution about the supplier leg. */
  opsNote: string;
}

const GENERIC: DownPaymentCopy = {
  partner: null,
  title: 'Down payment — two payments',
  amountLabel: 'Down payment (Welile)',
  amountLabelShort: 'Down payment',
  amountNote:
    'This is the down payment Welile funds so the supplier releases the phone. It is not the full phone price — the balance is owed to the supplier directly, on the supplier’s own repayment plan.',
  twoLegs: [
    'Pay Welile daily — deducted from your wallet balance or your commission.',
    'Pay the supplier on their own repayment plan — paid directly to them, outside the Welile app.',
  ],
  lockNotice: null,
  opsNote:
    'Welile funds the down payment only. The agent also repays the supplier on the supplier’s own plan outside this platform, so a clean Welile record does not mean the agent is current with the supplier.',
};

const MO_BANJA_COPY: DownPaymentCopy = {
  partner: MO_BANJA.partner,
  title: `${MO_BANJA.partner} iPhone — two payments`,
  amountLabel: MO_BANJA.amountLabel,
  amountLabelShort: MO_BANJA.amountLabelShort,
  amountNote: MO_BANJA.amountNote,
  twoLegs: MO_BANJA.twoLegs,
  lockNotice: MO_BANJA.lockNotice,
  opsNote: MO_BANJA.opsNote,
};

/**
 * Down-payment copy for any phone. iPhones name Mo Banja; every other brand
 * uses supplier-neutral wording. Applies to all phones — the amount Welile
 * holds is always a down payment.
 */
export function downPaymentCopy(brand?: string | null, model?: string | null): DownPaymentCopy {
  return isMoBanjaIphone(brand, model) ? MO_BANJA_COPY : GENERIC;
}
