/**
 * Every case on the current page of the Verify Payouts queue, each with a plain
 * one-line reason when it cannot be verified — so nothing looks hidden or
 * silently skipped. Display only: the gates themselves live in the database.
 */
import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, BadgeCheck, CheckCircle2, Clock, XCircle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { assessIdNameConfidence } from '@/lib/idNameConfidence';
import type { PayoutDestinationRow } from '@/hooks/usePayoutVerification';

export type BlockedReason = {
  blocked: boolean;
  text: string;
  Icon: typeof AlertTriangle;
  tone: string;
};

/** Why this case cannot be verified right now, in the reviewer's own words. */
export function blockedReasonFor(row: PayoutDestinationRow): BlockedReason | null {
  const what =
    row.double_kind === 'phone'
      ? 'phone number'
      : row.double_kind === 'face'
        ? 'face'
        : row.double_kind === 'id_photo'
          ? 'ID photo'
          : 'National ID';

  if (row.status === 'verified') {
    return {
      blocked: true,
      text: 'Blocked because this account is already verified by Financial Ops — reject it first if anything needs to change.',
      Icon: BadgeCheck,
      tone: 'text-primary',
    };
  }
  if (row.status === 'rejected') {
    return {
      blocked: true,
      text: `Blocked because this case was rejected${row.decision_reason ? `: ${row.decision_reason}` : '. It needs a fresh submission.'}`,
      Icon: XCircle,
      tone: 'text-destructive',
    };
  }
  if (row.double_submission) {
    return {
      blocked: true,
      text: `Blocked because this ${what} already verifies ${row.double_of_name || 'an earlier account'} — only the account that submitted first may be verified.`,
      Icon: AlertTriangle,
      tone: 'text-destructive',
    };
  }
  if (!row.national_id) {
    return {
      blocked: true,
      text: 'Waiting because no National ID number has been entered on this account yet.',
      Icon: Clock,
      tone: 'text-amber-600',
    };
  }
  if (!assessIdNameConfidence(row.national_id_name).confident) {
    return {
      blocked: true,
      text: `Waiting because the name could not be read from the ID photo — ${assessIdNameConfidence(row.national_id_name).reason} A clearer photo is needed.`,
      Icon: Clock,
      tone: 'text-amber-600',
    };
  }
  return {
    blocked: false,
    text: 'Ready to review — ID name read, photos on file, nothing blocking.',
    Icon: CheckCircle2,
    tone: 'text-primary',
  };
}

/** Only the rows in view are rendered once the list gets long. */
const ESTIMATED_ROW_PX = 96;
const VIRTUALIZE_ABOVE = 12;
const MAX_LIST_PX = 560;

export function PayoutQueueBlockedList({
  rows,
  activeId,
  startNumber,
  onOpen,
}: {
  rows: PayoutDestinationRow[];
  activeId: string | null;
  startNumber: number;
  onOpen: (index: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualize = rows.length > VIRTUALIZE_ABOVE;

  const virtualizer = useVirtualizer({
    count: virtualize ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_ROW_PX,
    overscan: 6,
  });

  if (rows.length === 0) return null;

  const renderRow = (r: PayoutDestinationRow, i: number) => {
    const reason = blockedReasonFor(r);
    const number =
      r.destination_type === 'mobile_money'
        ? r.momo_number || '—'
        : `${r.bank_name ?? ''} ${r.bank_account_number ?? ''}`.trim() || '—';
    return (
      <button
        type="button"
        onClick={() => onOpen(i)}
        aria-current={r.id === activeId ? 'true' : undefined}
        className={`w-full border-b border-border px-4 py-3 text-left transition-colors hover:bg-muted/50 ${
          r.id === activeId ? 'bg-primary/5' : ''
        }`}
      >
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold text-muted-foreground">{startNumber + i}.</span>
          <span className="min-w-0 flex-1 truncate text-sm font-bold text-foreground">
            {r.full_name || r.account_name || 'Name not recorded'}
          </span>
          <span className="shrink-0 text-xs font-semibold text-muted-foreground">
            {formatUGX(r.withdrawable_balance)}
          </span>
        </div>
        <p className="ml-5 truncate text-xs text-muted-foreground">{number}</p>
        {reason && (
          <p className={`ml-5 mt-1 flex items-start gap-1.5 text-xs font-medium ${reason.tone}`}>
            <reason.Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span>{reason.text}</span>
          </p>
        )}
      </button>
    );
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card">
      <p className="border-b border-border px-4 py-3 text-xs font-bold uppercase tracking-wide text-muted-foreground">
        This page — why each case can or cannot be verified
      </p>
      {virtualize ? (
        <div
          ref={scrollRef}
          className="overflow-y-auto overscroll-contain"
          style={{ maxHeight: MAX_LIST_PX }}
          role="list"
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((item) => (
              <div
                key={rows[item.index].id}
                role="listitem"
                ref={virtualizer.measureElement}
                data-index={item.index}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${item.start}px)`,
                }}
              >
                {renderRow(rows[item.index], item.index)}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div role="list">
          {rows.map((r, i) => (
            <div role="listitem" key={r.id}>
              {renderRow(r, i)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
