/**
 * RentPlanHistoryPanel
 *
 * Shows the complete lifecycle of a single Rent Plan (rent_request) inside
 * TenantDetailPanel. Rendered as a lazy-expanding section below each plan
 * card — only fetches when the user opens it.
 *
 * Data sources (read-only — no writes):
 *   • agent_collections WHERE rent_request_id = planId          → Agent Payments
 *   • general_ledger   WHERE source_id       = planId           → Self Payments,
 *                                                                  Disbursement, Commission
 *
 * Nothing in TenantDetailPanel's existing queries, handlers, edit flows, or
 * collection/receipt logic is touched. This component is purely additive.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  History,
  ChevronDown,
  ChevronUp,
  Loader2,
  ArrowUpRight,
  ArrowDownLeft,
  Banknote,
  Wallet,
  Building2,
  ClipboardList,
} from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';

// ─── Types ──────────────────────────────────────────────────────────────────

type EventKind =
  | 'plan_created'
  | 'disbursed'
  | 'agent_payment'
  | 'self_payment'
  | 'commission'
  | 'other_ledger';

interface PlanEvent {
  id: string;
  kind: EventKind;
  occurredAt: string;
  amountUgx: number | null;
  direction: 'in' | 'out' | null;
  runningBalance: number | null;
  actorName: string | null;
  actionLabel: string;
  paymentMethod: string | null;
  reference: string | null;
  status: string | null;
  description: string | null;
}

// ─── Props ───────────────────────────────────────────────────────────────────

interface Props {
  planId: string;
  tenantId: string;
  agentId: string | null;
  agentName: string | null;
  totalRepayment: number;
  createdAt: string;
  status: string;
}

// ─── Visual config ───────────────────────────────────────────────────────────

const KIND_LABEL: Record<EventKind, string> = {
  plan_created:  'Plan created',
  disbursed:     'Disbursement',
  agent_payment: 'Agent payment recorded',
  self_payment:  'Self payment received',
  commission:    'Agent commission',
  other_ledger:  'Ledger entry',
};

const KIND_ICON: Record<EventKind, React.ElementType> = {
  plan_created:  ClipboardList,
  disbursed:     Building2,
  agent_payment: Banknote,
  self_payment:  Wallet,
  commission:    ArrowUpRight,
  other_ledger:  ArrowDownLeft,
};

const KIND_COLOR: Record<EventKind, string> = {
  plan_created:  'text-blue-600 bg-blue-500/10',
  disbursed:     'text-purple-600 bg-purple-500/10',
  agent_payment: 'text-amber-700 bg-amber-500/10',
  self_payment:  'text-emerald-700 bg-emerald-500/10',
  commission:    'text-slate-600 bg-slate-500/10',
  other_ledger:  'text-muted-foreground bg-muted/50',
};

const SOURCE_BADGE: Partial<Record<EventKind, { label: string; className: string }>> = {
  disbursed:     { label: 'Disbursement', className: 'bg-muted text-muted-foreground border-border' },
  agent_payment: { label: 'Agent Payment', className: 'bg-amber-100 text-amber-800 border-amber-200' },
  self_payment:  { label: 'Self Payment',  className: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
};

const AMOUNT_COLOR: Partial<Record<EventKind, string>> = {
  disbursed:     'text-purple-700',
  self_payment:  'text-emerald-700',
  agent_payment: 'text-amber-700',
};

// ─── Ledger category → event kind ────────────────────────────────────────────

// Landlord-side legs of a plan, matched by ledger category (never by description):
// rent float funded for the landlord and the payout to the landlord.
const LANDLORD_FLOW_CATEGORIES = new Set([
  'rent_disbursement',
  'rent_float_funding',
  'agent_landlord_payout',
]);

function categoryToKind(category: string, userId: string, tenantId: string): EventKind {
  if (category === 'advance_disbursement') return 'disbursed';
  if (LANDLORD_FLOW_CATEGORIES.has(category)) return 'disbursed';
  // rent_receivable_created is shared: booked on the agent/landlord side it is the
  // "landlord float credited" leg; booked on the tenant it is a payment-allocation or
  // A3-correction leg that duplicates the payments listed below, so it stays out.
  if (category === 'rent_receivable_created' && userId !== tenantId) return 'disbursed';
  if (category === 'tenant_repayment' && userId === tenantId) return 'self_payment';
  if (category === 'agent_commission_earned') return 'commission';
  return 'other_ledger';
}

// Labels describe the recorded movement, not a new payment confirmation.
// In particular, landlord float is held by the agent; it is not landlord receipt.
function disbursementLabel(leg: {
  category: string;
  direction: string;
  description: string | null;
}, agentId: string | null, userId: string): string {
  if (/float (?:recalled|returned)|reversal.*tenant cancelled/i.test(leg.description || '')) {
    return 'Rent funds returned to platform';
  }
  if (/Rent float funded for agent to pay landlord/i.test(leg.description || '')) {
    return 'CFO → agent wallet (landlord payment funds)';
  }
  if (leg.category === 'rent_receivable_created') {
    return 'Agent landlord-payment float credited';
  }
  if (leg.category === 'rent_float_funding') {
    return 'Landlord-payment float funded';
  }
  if (leg.category === 'agent_landlord_payout') {
    return leg.direction === 'cash_in' && userId !== agentId
      ? 'Landlord received money'
      : 'Agent sent money to landlord';
  }
  if (leg.category === 'advance_disbursement') {
    return 'Advance funds disbursed';
  }
  return 'Rent funds disbursed';
}

// ─── Component ───────────────────────────────────────────────────────────────

export function RentPlanHistoryPanel({
  planId,
  tenantId,
  agentId,
  agentName,
  totalRepayment,
  createdAt,
  status,
}: Props) {
  const [open, setOpen] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['rent-plan-history', planId],
    enabled: open,
    staleTime: 60_000,
    queryFn: async () => {
      const [collectionsRes, ledgerRes] = await Promise.all([
        (supabase as any)
          .from('agent_collections')
          .select('id, amount, created_at, agent_id, payment_method, reversed_at')
          .eq('rent_request_id', planId)
          .order('created_at', { ascending: true }),
        (supabase as any)
          .from('general_ledger')
          .select('id, user_id, category, direction, amount, currency, created_at, description, ledger_scope')
          .eq('source_id', planId)
          .order('created_at', { ascending: true }),
      ]);
      return {
        collections: (collectionsRes.data || []) as Array<{
          id: string;
          amount: number;
          created_at: string;
          agent_id: string | null;
          payment_method: string | null;
          reversed_at: string | null;
        }>,
        ledger: (ledgerRes.data || []) as Array<{
          id: string;
          user_id: string;
          category: string;
          direction: string;
          amount: number;
          currency: string;
          created_at: string;
          description: string | null;
          ledger_scope: string;
        }>,
      };
    },
  });

  // Build merged event list
  const events: PlanEvent[] = (() => {
    if (!data) return [];
    const list: PlanEvent[] = [];

    // ① Plan created (synthetic event)
    list.push({
      id: `${planId}-created`,
      kind: 'plan_created',
      occurredAt: createdAt,
      amountUgx: null,
      direction: null,
      runningBalance: null,
      actorName: null,
      actionLabel: KIND_LABEL.plan_created,
      paymentMethod: null,
      reference: planId.slice(0, 8),
      status: status.replace(/_/g, ' '),
      description: null,
    });

    // ② Ledger entries
    for (const leg of data.ledger) {
      const kind = categoryToKind(leg.category, leg.user_id, tenantId);
      // Agent commission/bonus/override and other agent-money legs are not part of
      // the plan's own history; `.includes` (not `===`) keeps `kind` un-narrowed below.
      if ((['commission', 'other_ledger'] as EventKind[]).includes(kind)) continue;
      list.push({
        id: `ledger-${leg.id}`,
        kind,
        occurredAt: leg.created_at,
        amountUgx: Number(leg.amount || 0),
        direction: leg.direction === 'cash_in' ? 'in' : 'out',
        runningBalance: null,
        actorName:
          kind === 'agent_payment' || kind === 'commission'
            ? agentName
            : kind === 'self_payment'
            ? 'Tenant (wallet)'
            : null,
        actionLabel: kind === 'disbursed'
          ? disbursementLabel(leg, agentId, leg.user_id)
          : KIND_LABEL[kind],
        paymentMethod: leg.ledger_scope || 'wallet',
        reference: leg.id.slice(0, 8),
        status: leg.category,
        description: leg.description,
      });
    }

    // ③ Agent collections — authoritative physical payment records
    for (const c of data.collections) {
      list.push({
        id: `col-${c.id}`,
        kind: 'agent_payment',
        occurredAt: c.created_at,
        amountUgx: Number(c.amount || 0),
        direction: 'out',
        runningBalance: null,
        actorName: agentName,
        actionLabel: 'Agent payment recorded',
        paymentMethod: c.payment_method,
        reference: c.id.slice(0, 8),
        status: c.reversed_at ? 'reversed' : 'recorded',
        description: c.reversed_at
          ? `Reversed at ${format(new Date(c.reversed_at), 'dd MMM yyyy')}`
          : null,
      });
    }

    // Sort chronologically
    list.sort((a, b) => new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime());

    // Compute running balance (outstanding = totalRepayment – cumulative repayments)
    // Only agent_payment and self_payment rows that are not reversed reduce outstanding.
    let cumRepaid = 0;
    for (const ev of list) {
      const isRepayment =
        (ev.kind === 'agent_payment' || ev.kind === 'self_payment') &&
        ev.amountUgx !== null &&
        ev.amountUgx > 0 &&
        ev.status !== 'reversed';
      if (isRepayment) cumRepaid += ev.amountUgx!;
      if (ev.kind !== 'plan_created' && ev.kind !== 'commission' && ev.kind !== 'other_ledger') {
        ev.runningBalance = Math.max(0, totalRepayment - cumRepaid);
      }
    }

    return list;
  })();

  return (
    <div className="mt-2">
      {/* Toggle */}
      <Button
        variant="ghost"
        size="sm"
        className="h-7 gap-1.5 px-2 text-[11px] text-muted-foreground hover:text-foreground"
        onClick={() => setOpen((v) => !v)}
        id={`plan-history-toggle-${planId}`}
      >
        <History className="h-3.5 w-3.5" />
        Plan History
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
      </Button>

      {open && (
        <div className="mt-2 rounded-xl border border-border/60 bg-muted/20 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border/40 px-3 py-2 bg-muted/30">
            <span className="text-[11px] font-semibold text-foreground">Plan Payment History</span>
            <div className="flex gap-1.5">
              <Badge variant="outline" className="text-[9px] px-1 py-0 bg-emerald-100 text-emerald-800 border-emerald-200">
                Self Payment
              </Badge>
              <Badge variant="outline" className="text-[9px] px-1 py-0 bg-amber-100 text-amber-800 border-amber-200">
                Agent Payment
              </Badge>
            </div>
          </div>

          {/* Loading */}
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Loading plan history…
            </div>
          )}

          {/* Error */}
          {isError && (
            <p className="px-3 py-4 text-xs text-destructive text-center">
              Could not load plan history. Check your connection and try again.
            </p>
          )}

          {/* Empty */}
          {!isLoading && !isError && events.length === 0 && (
            <p className="px-3 py-4 text-xs text-muted-foreground text-center">
              No history recorded for this plan yet.
            </p>
          )}

          {/* Timeline */}
          {!isLoading && !isError && events.length > 0 && (
            <div className="divide-y divide-border/40">
              {events.map((ev, idx) => {
                const badge = SOURCE_BADGE[ev.kind];
                const isReversed = ev.status === 'reversed';
                const KindIcon = KIND_ICON[ev.kind];
                return (
                  <div
                    key={ev.id}
                    className={cn(
                      'px-3 py-2.5 flex items-start gap-2.5',
                      isReversed && 'opacity-50',
                    )}
                  >
                    {/* Timeline dot + connector */}
                    <div className="flex flex-col items-center pt-0.5 shrink-0">
                      <div className={cn('rounded-full p-1', KIND_COLOR[ev.kind])}>
                        <KindIcon className="h-3.5 w-3.5" />
                      </div>
                      {idx < events.length - 1 && (
                        <div className="mt-1 w-px min-h-[10px] bg-border/40 flex-1" />
                      )}
                    </div>

                    {/* Row content */}
                    <div className="flex-1 min-w-0 pb-0.5">
                      {/* Row 1: action label + source badge + timestamp */}
                      <div className="flex items-center justify-between gap-1 flex-wrap">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[11px] font-semibold text-foreground leading-tight">
                            {ev.actionLabel}
                          </span>
                          {badge && (
                            <Badge
                              variant="outline"
                              className={cn('text-[9px] px-1 py-0 border', badge.className)}
                            >
                              {badge.label}
                            </Badge>
                          )}
                          {isReversed && (
                            <Badge
                              variant="outline"
                              className="text-[9px] px-1 py-0 border border-destructive/30 text-destructive bg-destructive/5"
                            >
                              Reversed
                            </Badge>
                          )}
                        </div>
                        <time className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
                          {format(new Date(ev.occurredAt), 'dd MMM yyyy, HH:mm')}
                        </time>
                      </div>

                      {/* Row 2: amount + running balance */}
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0">
                        {ev.amountUgx !== null && (
                          <span
                            className={cn(
                              'text-[11px] font-mono font-semibold',
                              AMOUNT_COLOR[ev.kind] || 'text-foreground',
                            )}
                          >
                            UGX {ev.amountUgx.toLocaleString()}
                          </span>
                        )}
                        {ev.runningBalance !== null && (
                          <span className="text-[10px] text-muted-foreground">
                            Outstanding after:{' '}
                            <span className="text-foreground/80 font-mono">
                              UGX {ev.runningBalance.toLocaleString()}
                            </span>
                          </span>
                        )}
                      </div>

                      {/* Row 3: actor · method · reference · status */}
                      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0">
                        {ev.actorName && (
                          <span className="text-[10px] text-muted-foreground">
                            Actor:{' '}
                            <span className="text-foreground/80">{ev.actorName}</span>
                          </span>
                        )}
                        {ev.paymentMethod && ev.kind !== 'plan_created' && (
                          <span className="text-[10px] text-muted-foreground">
                            Via:{' '}
                            <span className="text-foreground/80">{ev.paymentMethod}</span>
                          </span>
                        )}
                        {ev.reference && (
                          <span className="text-[10px] text-muted-foreground font-mono">
                            Ref: {ev.reference}
                          </span>
                        )}
                        {ev.status && ev.status !== 'reversed' && ev.kind === 'plan_created' && (
                          <span className="text-[10px] text-muted-foreground">
                            Status:{' '}
                            <span className="text-foreground/80 capitalize">{ev.status}</span>
                          </span>
                        )}
                      </div>

                      {/* Row 4: description / extra */}
                      {ev.description && (
                        <p className="mt-0.5 text-[10px] text-muted-foreground italic truncate">
                          {ev.description}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Footer — total obligation */}
          {!isLoading && !isError && events.length > 0 && (
            <div className="border-t border-border/40 px-3 py-2 flex items-center justify-between bg-muted/30">
              <span className="text-[10px] text-muted-foreground">Total Repayment Obligation</span>
              <span className="text-[11px] font-semibold font-mono">
                UGX {totalRepayment.toLocaleString()}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
