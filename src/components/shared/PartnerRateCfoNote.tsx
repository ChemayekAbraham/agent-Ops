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
  return (
    <p role="note" className={cn('text-[11px] leading-snug text-amber-700 dark:text-amber-400', className)}>
      Needs CFO approval. The portfolio {meanwhile} until the CFO approves; an approved rate applies from the next cycle.
    </p>
  );
}

export default PartnerRateCfoNote;
