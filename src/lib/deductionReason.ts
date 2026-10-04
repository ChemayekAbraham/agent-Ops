/**
 * Plain-language explanation for why money LEFT a user's wallet (cash_out).
 *
 * Financial Ops and agents see a clear, jargon-free sentence instead of a raw
 * ledger category like "wallet_transfer" plus a technical description such as
 * "CFO Debit [Email charge → Withdrawable (auto)]: Auto-debit (score 60% …)".
 *
 * Returns:
 *   - title:  short headline ("Outgoing mobile-money payment")
 *   - reason: full plain-language sentence explaining the deduction
 *   - phone / tid: extracted reference details when present (nullable)
 */

import { format } from 'date-fns';

export interface DeductionLike {
  category: string | null;
  description: string | null;
  source_table?: string | null;
  amount?: number | null;
  transaction_date?: string | null;
}

export interface PlainDeduction {
  title: string;
  reason: string;
  phone: string | null;
  tid: string | null;
}

function extractPhone(desc: string): string | null {
  const m = desc.match(/phone\s+(\d{9,15})/i) || desc.match(/(2567\d{8})/) || desc.match(/(07\d{8})/);
  return m ? m[1] : null;
}

function extractTid(desc: string): string | null {
  const m = desc.match(/TID\s+([A-Za-z0-9]+)/i) || desc.match(/ref:\s*([A-Za-z0-9]+)/i);
  return m ? m[1] : null;
}

function extractScore(desc: string): string | null {
  const m = desc.match(/score\s+(\d{1,3})\s*%/i);
  return m ? `${m[1]}%` : null;
}

function extractChannel(desc: string): string | null {
  // e.g. "...outgoing payment email from Android SMS via IFTTT TID 148674624771..."
  const m = desc.match(/from\s+(.+?)\s+TID/i);
  return m ? m[1].trim() : null;
}

function fmtWhen(iso?: string | null): string | null {
  if (!iso) return null;
  try {
    return format(new Date(iso), 'd MMM yyyy, h:mm a');
  } catch {
    return iso;
  }
}

export interface TimelineStep {
  key: string;
  title: string;
  detail: string;
  meta: string[];
}

export interface DeductionTimeline {
  isAutoDebit: boolean;
  /** The exact rule that triggered the auto-debit, in plain language. */
  rule: string | null;
  score: string | null;
  channel: string | null;
  steps: TimelineStep[];
}

/**
 * Builds an ordered timeline for a wallet deduction:
 *   1. the matching outgoing-payment signal (date, TID, phone, channel)
 *   2. the exact rule that triggered the auto-debit (with confidence score)
 *   3. the wallet debit itself
 *
 * For non auto-debit deductions it returns a simpler "action → wallet debited"
 * pair so the same UI works for every cash-out row.
 */
export function deductionTimeline(row: DeductionLike): DeductionTimeline {
  const base = plainDeductionReason(row);
  const cat = (row.category ?? '').toLowerCase();
  const desc = row.description ?? '';
  const lower = desc.toLowerCase();
  const when = fmtWhen(row.transaction_date);

  const isAutoDebit =
    lower.includes('email charge') ||
    lower.includes('outgoing payment email') ||
    (cat === 'wallet_transfer' &&
      lower.includes('cfo debit') &&
      (lower.includes('auto-debit') || lower.includes('auto debit')));

  if (isAutoDebit) {
    const score = extractScore(desc);
    const channel = extractChannel(desc) ?? 'mobile-money SMS';
    const rule =
      `Email-charge auto-debit: an outgoing-payment message from the user's own line` +
      (base.phone ? ` (${base.phone})` : '') +
      (score ? ` matched at ${score} confidence` : ` matched`) +
      `, so the same amount is mirrored out of the withdrawable wallet to keep it in sync with the money that left the phone.`;

    const steps: TimelineStep[] = [
      {
        key: 'signal',
        title: 'Outgoing-payment signal received',
        detail: `A payment notification was captured from ${channel}.`,
        meta: [
          base.phone ? `Phone ${base.phone}` : null,
          base.tid ? `TID ${base.tid}` : null,
          when,
        ].filter(Boolean) as string[],
      },
      {
        key: 'rule',
        title: 'Auto-debit rule matched',
        detail: rule,
        meta: [score ? `Confidence ${score}` : null].filter(Boolean) as string[],
      },
      {
        key: 'debit',
        title: 'Withdrawable wallet debited',
        detail: `The matching amount was charged to the withdrawable wallet.`,
        meta: [when].filter(Boolean) as string[],
      },
    ];

    return { isAutoDebit: true, rule, score, channel, steps };
  }

  // Generic, non auto-debit deduction.
  const steps: TimelineStep[] = [
    {
      key: 'action',
      title: base.title,
      detail: base.reason,
      meta: [
        base.phone ? `Phone ${base.phone}` : null,
        base.tid ? `Ref ${base.tid}` : null,
      ].filter(Boolean) as string[],
    },
    {
      key: 'debit',
      title: 'Wallet debited',
      detail: `The amount was deducted from the wallet.`,
      meta: [when].filter(Boolean) as string[],
    },
  ];

  return { isAutoDebit: false, rule: null, score: null, channel: null, steps };
}

export function plainDeductionReason(row: DeductionLike): PlainDeduction {
  const cat = (row.category ?? '').toLowerCase();
  const desc = row.description ?? '';
  const lower = desc.toLowerCase();
  const phone = extractPhone(desc);
  const tid = extractTid(desc);

  // CFO email / SMS auto-debit for an outgoing mobile-money payment.
  if (
    lower.includes('email charge') ||
    lower.includes('outgoing payment email') ||
    (cat === 'wallet_transfer' && lower.includes('cfo debit'))
  ) {
    return {
      title: 'Outgoing mobile-money payment',
      reason:
        `We detected an outgoing mobile-money payment` +
        (phone ? ` from your line ${phone}` : '') +
        (tid ? ` (transaction ${tid})` : '') +
        `, so this amount was charged to your withdrawable wallet to match the money that left your phone.`,
      phone,
      tid,
    };
  }

  // Generic CFO direct debit.
  if (lower.includes('cfo debit') || row.source_table === 'cfo_direct_credit') {
    return {
      title: 'Direct debit by Finance',
      reason: `Finance debited this from your wallet${desc ? `: ${desc}` : '.'}`,
      phone,
      tid,
    };
  }

  if (cat === 'wallet_withdrawal' || cat === 'agent_wallet_withdrawal' || cat === 'withdrawal') {
    return {
      title: 'Withdrawal to mobile money',
      reason: `You withdrew this amount to mobile money${tid ? ` (ref ${tid})` : ''}.`,
      phone,
      tid,
    };
  }

  if (cat === 'rent_payment_for_tenant' || cat === 'agent_float_used_for_rent') {
    return {
      title: "Paid a tenant's rent",
      reason: `This came out of your operational float to pay a tenant's rent.`,
      phone,
      tid,
    };
  }

  if (cat === 'landlord_payout') {
    return {
      title: 'Paid a landlord',
      reason: `This was paid out from your float to a landlord.`,
      phone,
      tid,
    };
  }

  if (cat === 'advance_recovery' || cat === 'advance_repayment') {
    return {
      title: 'Advance recovery',
      reason: `We recovered part of an advance you owe from this incoming money.`,
      phone,
      tid,
    };
  }

  if (cat === 'debt_recovery') {
    return {
      title: 'Debt recovery',
      reason: `This was deducted to recover money owed (e.g. an unauthorized withdrawal adjustment).`,
      phone,
      tid,
    };
  }

  if (cat === 'partner_float_transfer_out' || cat === 'transfer_out' || cat === 'wallet_transfer') {
    return {
      title: 'Transfer sent',
      reason: desc || `This amount was transferred out of your wallet.`,
      phone,
      tid,
    };
  }

  // Fallback: use the description if it reads like a sentence, otherwise a generic note.
  return {
    title: 'Money out',
    reason: desc || `This amount was deducted from your wallet.`,
    phone,
    tid,
  };
}
