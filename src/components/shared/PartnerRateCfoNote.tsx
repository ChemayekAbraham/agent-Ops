import { cn } from '@/lib/utils';
import { formatRatePct, rateAwaitsCfo, typedRate as parseTypedRate } from '@/lib/partnerReturnPolicy';

interface PartnerRateCfoNoteProps {
  /** usePartnerReturnPolicy({ fresh: true }).enabled: true = switch on, false = off, null = unknown. */
  policyEnabled: boolean | null;
  /**
   * The partner's own rate for a NEW portfolio (usePartnerQuoteRate('partner', id)); null when unknown.
   * Ignored when `currentRate` is given.
   */
  personRate: number | null;
  /** The rate staff typed (raw input value or number). */
  typedRate: string | number | null | undefined;
  /**
   * The portfolio's stored rate when this form CHANGES an existing portfolio (edit, renewal).
   * Omit for a new portfolio, which earns the partner's own rate while the CFO decides.
   */
  currentRate?: number | null;
  className?: string;
}

/**
 * Whether the note would show, for callers that need the same answer (tests, button copy).
 * Only while the switch is on: a typed rate that differs from the partner's own rate (new portfolio)
 * or from the stored rate (an edit) is stored at that rate and queued for the CFO by the database
 * gate. When the partner's own rate is unknown, the note shows (the database decides).
 */
export function partnerRateNeedsCfoNote(
  policyEnabled: boolean | null,
  typedRate: string | number | null | undefined,
  referenceRate: number | null,
): boolean {
  if (policyEnabled !== true) return false;
  const typed = parseTypedRate(typedRate);
  if (typed === null || typed === 'invalid') return false;
  return referenceRate === null || rateAwaitsCfo(typed, referenceRate);
}

/**
 * Toast line for a typed rate that waits for the CFO: "The X% Returns rate waits for CFO approval;
 * Y% applies until then." Either figure may be unknown; the sentence then names no number for it.
 */
export function rateAwaitsCfoMessage(requested: number | null | undefined, inForce: number | null | undefined): string {
  const requestedPct = formatRatePct(requested ?? null);
  const inForcePct = formatRatePct(inForce ?? null);
  const head = requestedPct ? `The ${requestedPct} Returns rate` : 'The typed Returns rate';
  const tail = inForcePct ? `${inForcePct} applies until then.` : "the partner's own rate applies until then.";
  return `${head} waits for CFO approval; ${tail}`;
}

/** The rate keys create-portfolio-invite returns (partner staff get the rates; other staff get rate_note). */
export interface CreatePortfolioRateKeys {
  roi_percentage?: number | null;
  requested_roi_percentage?: number | null;
  rate_awaits_cfo?: boolean | null;
  rate_note?: string | null;
}

/** The extra toast line for a create-portfolio-invite answer, or null when there is nothing to add. */
export function createResponseRateMessage(data: CreatePortfolioRateKeys | null | undefined): string | null {
  if (!data) return null;
  if (data.rate_awaits_cfo === true) return rateAwaitsCfoMessage(data.requested_roi_percentage, data.roi_percentage);
  return typeof data.rate_note === 'string' && data.rate_note.trim() ? data.rate_note : null;
}

/**
 * Inline note under a staff "Returns rate" field (design v2 §6.2 #2; markup for Gemini to review).
 */
export function PartnerRateCfoNote({ policyEnabled, personRate, typedRate, currentRate, className }: PartnerRateCfoNoteProps) {
  const reference = currentRate != null ? currentRate : personRate;
  if (!partnerRateNeedsCfoNote(policyEnabled, typedRate, reference ?? null)) return null;
  const currentPct = currentRate != null ? formatRatePct(Number(currentRate)) : null;
  const personPct = formatRatePct(personRate);
  const meanwhile = currentPct
    ? `keeps its current ${currentPct}`
    : personPct
      ? `earns this partner's own rate (${personPct})`
      : "earns this partner's own rate";
  // An edit or renewal changes a running portfolio: the approved rate starts with the next cycle.
  // A new portfolio (owner decision D10): an approval before its first Returns sets the rate from the start.
  const whenApproved = currentRate != null
    ? 'An approved rate applies from the next cycle.'
    : 'An approved rate applies from its first monthly Returns.';
  return (
    <p role="note" className={cn('text-[11px] leading-snug text-amber-700 dark:text-amber-400', className)}>
      Needs CFO approval. The portfolio {meanwhile} until the CFO approves. {whenApproved}
    </p>
  );
}

export default PartnerRateCfoNote;
