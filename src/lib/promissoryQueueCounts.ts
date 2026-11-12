/**
 * One definition for the promissory-note counts on Partner Ops.
 *
 * Every Pending / Approved figure on the promissory list, the overview cards
 * and the pending summary tile is this function applied to the same notes
 * the list is showing (already passed through applyCameInFulfilment).
 *
 * Pending (awaiting review): Partner Ops have not approved the note yet
 * (`approval_bonus_paid` is false). That includes a note the partner already
 * opened from its link (stored as `activated`) or already paid in full (shown
 * as `fulfilled`): approval is what pays the agent's bonus and lets the
 * partner commission pay, so those notes must stay in front of reviewers.
 * Approved: status is `activated` and the note was approved.
 * Fulfilled: an approved note the partner has covered in full.
 * `kpis.approved_notes` (approved_at is set) is a wider server figure and is
 * not shown as "Approved".
 */

export interface PromissoryCountableNote {
  status?: string | null;
  approval_bonus_paid?: boolean | null;
  fulfilment_due_on?: string | null;
  outstanding?: number | null;
  amount?: number | null;
  total_collected?: number | null;
}

export interface PromissoryQueueCounts {
  all: number;
  pending: number;
  approved: number;
  rejected: number;
  fulfilled: number;
  defaulted: number;
  overdue: number;
  missingFulfilment: number;
}

export const PROMISSORY_COUNT_HELP = {
  all: 'Every promissory note in the selected date range. The All filter uses this same count.',
  pending:
    'Notes not approved yet in the selected date range, including notes the partner has already opened from the link or paid in full. The agent is not paid until the note is approved. The Pending filter uses this same count.',
  approved:
    'Notes whose approval is current in the selected date range. The Approved filter uses this same count.',
  rejected: 'Notes stored as rejected (cancelled) in the selected date range.',
  fulfilled: 'Approved notes the partner has covered in full, or that are stored as fulfilled, in the selected date range.',
  defaulted: 'Notes stored as defaulted in the selected date range.',
  overdue: 'Notes with a Fulfils by date before today that still have money outstanding.',
  missingFulfilment: 'Notes in the selected date range with no Fulfils by date, in any status.',
} as const;

/**
 * True while Partner Ops still have to approve the note. A note becomes `activated` when the partner (or anyone
 * signed in) opens its link, and shows as `fulfilled` once the partner has paid in full; neither is an approval.
 * Only an explicit `approval_bonus_paid: false` counts for those two, so rows without the field keep their status.
 */
export function isAwaitingPromissoryReview(note: PromissoryCountableNote): boolean {
  const status = String(note.status || '');
  if (status === 'pending') return true;
  return (status === 'activated' || status === 'fulfilled') && note.approval_bonus_paid === false;
}

/** The status Partner Ops should see: `pending` for any note not approved yet, otherwise the note's own status. */
export function promissoryReviewStatus(note: PromissoryCountableNote): string {
  return isAwaitingPromissoryReview(note) ? 'pending' : String(note.status || '');
}

export function isPromissoryOverdue(note: PromissoryCountableNote, now = new Date()): boolean {
  if (!note.fulfilment_due_on) return false;
  const due = new Date(note.fulfilment_due_on);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (due >= today) return false;
  const outstanding = Number(note.outstanding ?? (Number(note.amount) - Number(note.total_collected)));
  return outstanding > 0;
}

export function countPromissoryQueue(notes: PromissoryCountableNote[], now = new Date()): PromissoryQueueCounts {
  const counts: PromissoryQueueCounts = {
    all: notes.length,
    pending: 0,
    approved: 0,
    rejected: 0,
    fulfilled: 0,
    defaulted: 0,
    overdue: 0,
    missingFulfilment: 0,
  };
  for (const note of notes) {
    const status = promissoryReviewStatus(note);
    if (status === 'pending') counts.pending += 1;
    else if (status === 'activated') counts.approved += 1;
    else if (status === 'cancelled') counts.rejected += 1;
    else if (status === 'fulfilled') counts.fulfilled += 1;
    else if (status === 'defaulted') counts.defaulted += 1;
    if (isPromissoryOverdue(note, now)) counts.overdue += 1;
    if (!note.fulfilment_due_on) counts.missingFulfilment += 1;
  }
  return counts;
}

export function promissoryFilterCount(counts: PromissoryQueueCounts, filter: string): number {
  switch (filter) {
    case 'all':
      return counts.all;
    case 'pending':
      return counts.pending;
    case 'activated':
      return counts.approved;
    case 'cancelled':
      return counts.rejected;
    case 'fulfilled':
      return counts.fulfilled;
    case 'defaulted':
      return counts.defaulted;
    case 'overdue':
      return counts.overdue;
    case 'missing_fulfilment':
      return counts.missingFulfilment;
    default:
      return 0;
  }
}

export function promissoryFilterHelp(filter: string): string | undefined {
  switch (filter) {
    case 'all':
      return PROMISSORY_COUNT_HELP.all;
    case 'pending':
      return PROMISSORY_COUNT_HELP.pending;
    case 'activated':
      return PROMISSORY_COUNT_HELP.approved;
    case 'cancelled':
      return PROMISSORY_COUNT_HELP.rejected;
    case 'fulfilled':
      return PROMISSORY_COUNT_HELP.fulfilled;
    case 'defaulted':
      return PROMISSORY_COUNT_HELP.defaulted;
    case 'overdue':
      return PROMISSORY_COUNT_HELP.overdue;
    case 'missing_fulfilment':
      return PROMISSORY_COUNT_HELP.missingFulfilment;
    default:
      return undefined;
  }
}
