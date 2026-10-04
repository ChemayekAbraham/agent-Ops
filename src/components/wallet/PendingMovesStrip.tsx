import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { Loader2, ArrowDownToLine, Plus, ChevronRight, Users } from 'lucide-react';
import { decodeAllocationsFromNote, type TenantAllocation } from '@/components/payments/OperationalFloatTenantAllocator';
import {
  useDepositRequests,
  useWithdrawalRequestsList,
  type DepositRequestRow,
  type WithdrawalRequestRow,
} from '@/hooks/wallet/useWalletRequests';

/**
 * One row in the pending strip. We normalise deposits and withdrawals
 * into a single shape so the UI doesn't branch per kind. `status` keeps
 * the raw DB value for tooltips, while `stage` is the user-facing label.
 */
interface PendingMove {
  id: string;
  kind: 'deposit' | 'withdrawal';
  amount: number;
  status: string;
  stage: string;
  created_at: string;
  /**
   * For deposits only. When the deposit was filed as `operational_float`
   * we surface its per-tenant breakdown inline so the agent can see, at
   * the wallet level, *who* this in-flight cash will be credited to as
   * the request walks through approval.
   */
  allocations?: TenantAllocation[] | null;
  transaction_id?: string | null;
}

/** Map a raw DB status to a short user-facing stage label. */
function stageLabel(kind: 'deposit' | 'withdrawal', status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'pending') return kind === 'deposit' ? 'Verifying' : 'Submitted';
  if (s === 'reviewed' || s === 'under_review') return 'In review';
  if (s === 'approved') return 'Approved · awaiting payout';
  if (s === 'processing') return 'Processing';
  if (s === 'rejected') return 'Rejected';
  return status || 'Pending';
}

/**
 * Live-updating strip showing the user's open deposits/withdrawals on the
 * wallet widget. Subscribes to both `deposit_requests` and
 * `withdrawal_requests` filtered by user_id so new submissions appear and
 * resolved ones disappear without a manual refresh.
 *
 * Hidden when there is nothing pending — keeps the wallet clean for the
 * 95% case where users have no in-flight money movements.
 */
// Statuses we still consider "in-flight" — anything else (success,
// disbursed, fully_paid, cancelled) drops off the strip automatically.
const OPEN_STATUSES = ['pending', 'reviewed', 'under_review', 'approved', 'processing'];

function toPendingMove(row: DepositRequestRow | WithdrawalRequestRow, kind: 'deposit' | 'withdrawal'): PendingMove {
  if (kind === 'deposit') {
    const d = row as DepositRequestRow;
    const isOpFloat = d.deposit_purpose === 'operational_float';
    const decoded = isOpFloat ? decodeAllocationsFromNote(d.notes) : null;
    return {
      id: `d-${d.id}`,
      kind: 'deposit',
      amount: Number(d.amount ?? 0),
      status: d.status,
      stage: stageLabel('deposit', d.status),
      created_at: d.created_at,
      allocations: decoded?.allocations ?? null,
      transaction_id: d.transaction_id ?? null,
    };
  }
  const w = row as WithdrawalRequestRow;
  return {
    id: `w-${w.id}`,
    kind: 'withdrawal',
    amount: Number(w.amount ?? 0),
    status: w.status,
    stage: stageLabel('withdrawal', w.status),
    created_at: w.created_at,
  };
}

export function PendingMovesStrip() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  // Shared, cached, realtime-backed — same source UserDepositRequests /
  // UserWithdrawalRequests read, so this no longer runs its own fetch or
  // keeps its own realtime channel. Narrows to the "in-flight" subset
  // client-side instead of re-querying with a status filter.
  const { requests: depositRequests, isLoading: depositsLoading } = useDepositRequests(user?.id);
  const { requests: withdrawalRequests, isLoading: withdrawalsLoading } = useWithdrawalRequestsList(user?.id);
  const loading = depositsLoading || withdrawalsLoading;

  const moves = useMemo(() => {
    const merged: PendingMove[] = [
      ...depositRequests.filter((d) => OPEN_STATUSES.includes(d.status)).map((d) => toPendingMove(d, 'deposit')),
      ...withdrawalRequests.filter((w) => OPEN_STATUSES.includes(w.status)).map((w) => toPendingMove(w, 'withdrawal')),
    ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    return merged;
  }, [depositRequests, withdrawalRequests]);

  if (loading || moves.length === 0) return null;

  const headline = moves[0];
  const remaining = moves.length - 1;
  const headlineHasAllocs = !!headline.allocations && headline.allocations.length > 0;

  return (
    <div className="rounded-xl border border-warning/40 bg-warning/5 overflow-hidden">
      <button
        type="button"
        onClick={() =>
          moves.length > 1 || headlineHasAllocs
            ? setExpanded((v) => !v)
            : navigate('/transactions')
        }
        className="w-full flex items-center gap-2.5 p-2.5 text-left hover:bg-warning/10 transition-colors"
      >
        <span className="relative flex h-2 w-2 shrink-0">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-warning opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-warning" />
        </span>
        <div className="p-1.5 rounded-lg bg-background border border-warning/30 shrink-0">
          {headline.kind === 'deposit' ? (
            <Plus className="h-3.5 w-3.5 text-success" />
          ) : (
            <ArrowDownToLine className="h-3.5 w-3.5 text-warning" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-semibold text-foreground truncate">
            {headline.kind === 'deposit' ? 'Deposit' : 'Withdrawal'} ·{' '}
            {headline.amount >= 1000
              ? `${(headline.amount / 1000).toFixed(0)}K`
              : headline.amount}{' '}
            UGX
          </p>
          <p className="text-[10px] text-muted-foreground truncate">
            {headline.stage}
            {remaining > 0 && ` · +${remaining} more pending`}
            {headlineHasAllocs && (
              <>
                {' · '}
                <span className="inline-flex items-center gap-0.5 text-primary font-medium">
                  <Users className="h-2.5 w-2.5" />
                  {headline.allocations!.length} tenant
                  {headline.allocations!.length === 1 ? '' : 's'}
                </span>
              </>
            )}
          </p>
        </div>
        {moves.length > 1 || headlineHasAllocs ? (
          <ChevronRight
            className={`h-4 w-4 text-muted-foreground transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        ) : (
          <Loader2 className="h-3.5 w-3.5 text-warning animate-spin" />
        )}
      </button>

      {/* Headline op-float breakdown — surfaced first because it's the
          most actionable info ("who am I crediting with this drop?"). */}
      {expanded && headlineHasAllocs && (
        <AllocationBreakdown
          allocations={headline.allocations!}
          transactionId={headline.transaction_id ?? null}
          stage={headline.stage}
        />
      )}

      {expanded && moves.length > 1 && (
        <ul className="border-t border-warning/30 divide-y divide-warning/20">
          {moves.slice(1, 6).map((m) => (
            <li key={m.id} className="px-2.5 py-1.5">
              <div className="flex items-center gap-2">
                <div className="p-1 rounded bg-background border border-border/60 shrink-0">
                  {m.kind === 'deposit' ? (
                    <Plus className="h-3 w-3 text-success" />
                  ) : (
                    <ArrowDownToLine className="h-3 w-3 text-warning" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] font-medium truncate">
                    {m.kind === 'deposit' ? 'Deposit' : 'Withdrawal'} ·{' '}
                    {m.amount >= 1000 ? `${(m.amount / 1000).toFixed(0)}K` : m.amount} UGX
                  </p>
                  <p className="text-[9px] text-muted-foreground truncate">
                    {m.stage}
                    {m.allocations && m.allocations.length > 0 && (
                      <>
                        {' · '}
                        <span className="inline-flex items-center gap-0.5 text-primary font-medium">
                          <Users className="h-2 w-2" />
                          {m.allocations.length}
                        </span>
                      </>
                    )}
                  </p>
                </div>
              </div>
              {m.allocations && m.allocations.length > 0 && (
                <AllocationBreakdown
                  allocations={m.allocations}
                  transactionId={m.transaction_id ?? null}
                  stage={m.stage}
                  compact
                />
              )}
            </li>
          ))}
          {moves.length > 6 && (
            <li className="px-2.5 py-1.5 text-center">
              <button
                type="button"
                onClick={() => navigate('/transactions')}
                className="text-[10px] font-semibold text-primary hover:underline"
              >
                View all {moves.length} pending →
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/**
 * Per-tenant breakdown panel for an in-flight Operational Float deposit.
 * Renders the live status chip + a compact tenant list with amounts so
 * the agent can see at-a-glance who their pending drop will credit as
 * Financial Ops moves the request through approval.
 */
function AllocationBreakdown({
  allocations,
  transactionId,
  stage,
  compact = false,
}: {
  allocations: TenantAllocation[];
  transactionId: string | null;
  stage: string;
  compact?: boolean;
}) {
  const total = allocations.reduce((sum, a) => sum + Number(a.amount || 0), 0);
  return (
    <div
      className={`border-t border-warning/30 bg-background/40 ${
        compact ? 'mt-1.5 rounded-md border px-2 py-1.5' : 'p-2.5'
      }`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-primary">
          <Users className="h-2.5 w-2.5" />
          {allocations.length} tenant{allocations.length === 1 ? '' : 's'} · {stage}
        </span>
        {transactionId && (
          <span
            className="text-[9px] font-mono text-muted-foreground truncate max-w-[45%]"
            title={transactionId}
          >
            {transactionId}
          </span>
        )}
      </div>
      <ul className="space-y-0.5">
        {allocations.slice(0, 6).map((a) => (
          <li
            key={a.tenant_id}
            className="flex items-center justify-between gap-2 text-[10px]"
          >
            <span className="truncate text-foreground">{a.tenant_name}</span>
            <span className="font-mono tabular-nums text-muted-foreground shrink-0">
              UGX {Number(a.amount || 0).toLocaleString()}
            </span>
          </li>
        ))}
        {allocations.length > 6 && (
          <li className="text-[9px] italic text-muted-foreground">
            +{allocations.length - 6} more…
          </li>
        )}
      </ul>
      <div className="mt-1 pt-1 border-t border-border/60 flex items-center justify-between text-[10px] font-semibold">
        <span className="text-muted-foreground">Allocated total</span>
        <span className="font-mono tabular-nums">UGX {total.toLocaleString()}</span>
      </div>
    </div>
  );
}