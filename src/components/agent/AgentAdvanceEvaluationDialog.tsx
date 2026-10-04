import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { format } from 'date-fns';
import {
  CheckCircle2, Loader2, Sparkles, Info, TrendingUp, Users, Network, Wallet,
  Home, FileText, AlertTriangle, PiggyBank, Coins, ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { RentRequestOutcomes } from '@/components/executive/AgentEvaluationSection';

const num = (v: any) => Number(v ?? 0);

export function scoreColor(score: number) {
  if (score >= 75) return 'text-emerald-600';
  if (score >= 50) return 'text-amber-600';
  return 'text-rose-600';
}
export function scoreBg(score: number) {
  if (score >= 75) return 'bg-emerald-500';
  if (score >= 50) return 'bg-amber-500';
  return 'bg-rose-500';
}
export function tierLabel(score: number) {
  if (score >= 75) return 'High potential';
  if (score >= 50) return 'Growing';
  return 'Early stage';
}

export interface PotentialInfo {
  potential_score: number;
  suggested_amount: number;
  current_limit: number;
  direct_subagents: number;
  active_subagents: number;
  grand_subagents: number;
  rent_collected: number;
  collections_count: number;
  house_listings: number;
  rent_requests: number;
  advances_count: number;
  outstanding_total: number;
  repayment_rate: number | null;
  network_score: number;
  collections_score: number;
  repayment_score: number;
  listings_score: number;
  requests_score: number;
}

/** Map a raw scoring RPC row into PotentialInfo. */
export function mapPotentialRow(r: any): PotentialInfo {
  return {
    potential_score: num(r.potential_score),
    suggested_amount: num(r.suggested_amount),
    current_limit: num(r.current_limit),
    direct_subagents: num(r.direct_subagents),
    active_subagents: num(r.active_subagents),
    grand_subagents: num(r.grand_subagents),
    rent_collected: num(r.rent_collected),
    collections_count: num(r.collections_count),
    house_listings: num(r.house_listings),
    rent_requests: num(r.rent_requests),
    advances_count: num(r.advances_count),
    outstanding_total: num(r.outstanding_total),
    repayment_rate: r.repayment_rate == null ? null : Number(r.repayment_rate),
    network_score: num(r.network_score),
    collections_score: num(r.collections_score),
    repayment_score: num(r.repayment_score),
    listings_score: num(r.listings_score),
    requests_score: num(r.requests_score),
  };
}

export function ScoreBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] mb-1">
        <span className="font-medium">{label} <span className="text-muted-foreground">(max {max})</span></span>
        <span className="font-bold">{value.toFixed(1)}</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={cn('h-full rounded-full', scoreBg(pct))} style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
    </div>
  );
}

export function StatBlock({ icon: Icon, label, value, sub }: { icon: any; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-2.5 sm:p-3 min-w-0 overflow-hidden">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="text-[11px] font-semibold uppercase tracking-wide truncate">{label}</span>
      </div>
      <p className="text-sm sm:text-base font-bold mt-1 truncate" title={value}>{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground truncate" title={sub}>{sub}</p>}
    </div>
  );
}

/**
 * The single, shared advance-eligibility evaluation popup.
 *
 * Used by Agent Ops, the CFO desk and any manager/admin so every reviewer sees
 * the exact same 360° evaluation before acting on an advance request:
 *   - live wallet snapshot + recent earnings (repayment capacity)
 *   - requested vs suggested vs current limit
 *   - potential score, performance breakdown and full stats grid
 *
 * Every requester is scored — even agents who haven't met the "who is an agent"
 * criteria and therefore aren't in the ranked map. When no pre-fetched
 * `potential` is passed, the dialog builds one on demand for that exact agent.
 *
 * `footer` lets each surface render its own actions (approve/reject for Ops,
 * edit & disburse for the CFO), while the evaluation body stays identical.
 */
export function AgentAdvanceEvaluationDialog({
  req,
  agentId,
  agentName,
  potential: potentialProp,
  footer,
  onClose,
}: {
  /** The advance request row (principal, cycle_days, fees, reason…). */
  req: any | null;
  /** Agent id — falls back to req.agent_id. */
  agentId?: string | null;
  /** Display name — falls back to req.agent_full_name / req.profiles.full_name. */
  agentName?: string | null;
  /** Pre-fetched score (from a ranked map). Omit to score on demand. */
  potential?: PotentialInfo;
  /** Surface-specific action buttons rendered sticky at the bottom. */
  footer?: React.ReactNode;
  onClose: () => void;
}) {
  const resolvedAgentId: string | undefined =
    agentId || req?.agent_id || undefined;
  const resolvedName =
    agentName || req?.agent_full_name || req?.profiles?.full_name || 'Agent';

  // Build an evaluation on demand for any agent missing from the ranked map.
  const { data: onDemand, isLoading: onDemandLoading } = useQuery({
    queryKey: ['advance-eval-potential-on-demand', resolvedAgentId],
    enabled: !!resolvedAgentId && !potentialProp && !!req,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_agent_advance_potential_for', {
        _agent_id: resolvedAgentId,
      });
      if (error) throw error;
      const row = ((data ?? []) as any[])[0];
      if (!row) return null;
      return { info: mapPotentialRow(row), isQualifying: !!row.is_qualifying };
    },
  });

  const p: PotentialInfo | undefined = potentialProp ?? onDemand?.info ?? undefined;
  const generatedEval = !potentialProp && !!onDemand?.info && !onDemand?.isQualifying;

  const requested = num(req?.principal);
  const suggested = p ? p.suggested_amount : 0;
  const limit = p ? p.current_limit : 0;
  const repayPct = p?.repayment_rate == null ? null : Math.round((p!.repayment_rate as number) * 100);
  const overSuggested = p && requested > suggested;
  const overLimit = p && limit > 0 && requested > limit;
  const withinAll = p && !overSuggested && !overLimit;

  const [showEarnings, setShowEarnings] = useState(false);

  const { data: wallet, isLoading: walletLoading } = useQuery({
    queryKey: ['advance-eval-wallet', resolvedAgentId],
    enabled: !!resolvedAgentId && !!req,
    staleTime: 30_000,
    queryFn: async () => {
      const [walletRes, availRes] = await Promise.all([
        supabase
          .from('wallets')
          .select('withdrawable_balance, float_balance, advance_balance, balance')
          .eq('user_id', resolvedAgentId as string)
          .maybeSingle(),
        (supabase.rpc as any)('get_user_available_balance', { p_user_id: resolvedAgentId }),
      ]);
      return {
        withdrawable: num(walletRes.data?.withdrawable_balance),
        float: num(walletRes.data?.float_balance),
        advance: num(walletRes.data?.advance_balance),
        available: num(availRes?.data),
      };
    },
  });

  const { data: earnings = [], isLoading: earningsLoading } = useQuery({
    queryKey: ['advance-eval-earnings', resolvedAgentId],
    enabled: !!resolvedAgentId && showEarnings,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_earnings')
        .select('id, amount, earning_type, description, created_at')
        .eq('agent_id', resolvedAgentId as string)
        .order('created_at', { ascending: false })
        .limit(15);
      if (error) throw error;
      return data || [];
    },
  });

  return (
    <Dialog open={!!req} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        {req && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                {resolvedName} — advance evaluation
              </DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              {/* On-demand evaluation status for non-ranked agents */}
              {!potentialProp && (
                onDemandLoading ? (
                  <div className="rounded-xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground inline-flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" /> Building an evaluation for this agent…
                  </div>
                ) : generatedEval ? (
                  <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-800 inline-flex items-center gap-2">
                    <Sparkles className="h-4 w-4 shrink-0" />
                    Generated evaluation — this agent hasn't met the full agent criteria yet, so we scored them on demand from their live activity.
                  </div>
                ) : null
              )}

              {/* Wallet snapshot + recent earnings — repayment-capacity context */}
              <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold flex items-center gap-1.5">
                    <PiggyBank className="h-3.5 w-3.5 text-emerald-600" /> Wallet balance
                  </p>
                  {walletLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
                </div>
                <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
                  <div className="rounded-xl bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-100 dark:border-emerald-800/30 p-2 sm:p-2.5 text-center min-w-0 overflow-hidden">
                    <p className="text-[9px] uppercase tracking-wide text-emerald-700 dark:text-emerald-400 truncate">Withdrawable</p>
                    <p className="text-xs sm:text-sm font-extrabold text-emerald-700 dark:text-emerald-400 leading-tight mt-0.5 tabular-nums tracking-tight truncate" title={formatUGX(wallet?.available ?? wallet?.withdrawable ?? 0)}>
                      {formatUGX(wallet?.available ?? wallet?.withdrawable ?? 0)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-muted/50 border border-border p-2 sm:p-2.5 text-center min-w-0 overflow-hidden">
                    <p className="text-[9px] uppercase tracking-wide text-muted-foreground truncate">Float</p>
                    <p className="text-xs sm:text-sm font-extrabold leading-tight mt-0.5 tabular-nums tracking-tight truncate" title={formatUGX(wallet?.float ?? 0)}>
                      {formatUGX(wallet?.float ?? 0)}
                    </p>
                  </div>
                  <div className="rounded-xl bg-amber-50 dark:bg-amber-950/20 border border-amber-100 dark:border-amber-800/30 p-2 sm:p-2.5 text-center min-w-0 overflow-hidden">
                    <p className="text-[9px] uppercase tracking-wide text-amber-700 dark:text-amber-400 truncate">Advance owed</p>
                    <p className="text-xs sm:text-sm font-extrabold text-amber-700 dark:text-amber-400 leading-tight mt-0.5 tabular-nums tracking-tight truncate" title={formatUGX(wallet?.advance ?? 0)}>
                      {formatUGX(wallet?.advance ?? 0)}
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowEarnings((s) => !s)}
                  className="w-full flex items-center justify-center gap-1.5 rounded-xl border border-border bg-muted/40 py-2 text-xs font-semibold text-foreground hover:bg-muted transition-colors"
                >
                  <Coins className="h-3.5 w-3.5 text-primary" />
                  {showEarnings ? 'Hide recent earnings' : 'See recent earnings activity'}
                  <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', showEarnings ? 'rotate-180' : '')} />
                </button>
                {showEarnings && (
                  <div className="rounded-xl bg-muted/30 p-2 space-y-1 max-h-56 overflow-y-auto">
                    {earningsLoading ? (
                      <div className="flex justify-center py-4"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
                    ) : earnings.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground text-center py-3">No earnings recorded yet.</p>
                    ) : (
                      earnings.map((e: any) => (
                        <div key={e.id} className="flex items-center justify-between gap-2 rounded-lg bg-background/70 px-2.5 py-1.5">
                          <div className="min-w-0 flex-1">
                            <p className="text-[11px] font-semibold truncate">
                              {e.description || (e.earning_type ? String(e.earning_type).replace(/_/g, ' ') : 'Earning')}
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              {e.earning_type ? String(e.earning_type).replace(/_/g, ' ') : ''} · {e.created_at ? format(new Date(e.created_at), 'MMM d, yyyy') : ''}
                            </p>
                          </div>
                          <span className="text-[11px] font-bold text-emerald-600 tabular-nums shrink-0">+{formatUGX(num(e.amount))}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Requested vs suggested vs limit */}
              <div className="grid grid-cols-3 gap-1.5 sm:gap-2">
                <div className="rounded-2xl border border-primary/30 bg-primary/5 p-2 sm:p-3 text-center min-w-0 overflow-hidden flex flex-col justify-between">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">Requested</p>
                  <p className="text-xs sm:text-sm md:text-base font-extrabold text-primary leading-tight my-1 tabular-nums tracking-tight truncate" title={formatUGX(requested)}>
                    {formatUGX(requested)}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate">{req.cycle_days} days</p>
                </div>
                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 dark:bg-emerald-950/20 p-2 sm:p-3 text-center min-w-0 overflow-hidden flex flex-col justify-between">
                  <p className="text-[10px] uppercase tracking-wide text-emerald-700 dark:text-emerald-400 truncate">Suggested</p>
                  <p className="text-xs sm:text-sm md:text-base font-extrabold text-emerald-600 dark:text-emerald-400 leading-tight my-1 tabular-nums tracking-tight truncate" title={p ? formatUGX(suggested) : '—'}>
                    {p ? formatUGX(suggested) : '—'}
                  </p>
                  <p className="text-[10px] text-emerald-700 dark:text-emerald-400 truncate">safe amount</p>
                </div>
                <div className="rounded-2xl border border-border bg-card p-2 sm:p-3 text-center min-w-0 overflow-hidden flex flex-col justify-between">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground truncate">Limit</p>
                  <p className="text-xs sm:text-sm md:text-base font-extrabold leading-tight my-1 tabular-nums tracking-tight truncate" title={p ? formatUGX(limit) : '—'}>
                    {p ? formatUGX(limit) : '—'}
                  </p>
                  <p className="text-[10px] text-muted-foreground truncate">current cap</p>
                </div>
              </div>

              {/* Verdict banner */}
              {p && (
                <div className={cn(
                  'rounded-xl p-3 text-xs font-semibold flex items-start gap-2',
                  withinAll ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
                    : overLimit ? 'bg-rose-50 text-rose-800 border border-rose-200'
                      : 'bg-amber-50 text-amber-800 border border-amber-200',
                )}>
                  {withinAll ? <CheckCircle2 className="h-4 w-4 shrink-0 mt-0.5" /> : <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />}
                  <span>
                    {withinAll && 'Requested amount is within both the suggested amount and the current limit — safe to approve.'}
                    {overLimit && `Requested amount exceeds the current limit by ${formatUGX(requested - limit)}. Consider rejecting or asking the agent to lower it.`}
                    {overSuggested && !overLimit && `Requested amount is ${formatUGX(requested - suggested)} above the suggested (safe) amount but within the limit. Approve with caution.`}
                  </span>
                </div>
              )}

              {/* Potential headline */}
              {p ? (
                <div className="rounded-2xl border border-border bg-gradient-to-br from-primary/10 to-transparent p-4 flex items-center justify-between">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Potential score</p>
                    <p className={cn('text-3xl font-extrabold leading-none', scoreColor(p.potential_score))}>
                      {p.potential_score.toFixed(0)}<span className="text-base text-muted-foreground">/100</span>
                    </p>
                    <p className="text-[11px] font-semibold mt-1">{tierLabel(p.potential_score)}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Repayment</p>
                    <p className="text-2xl font-extrabold leading-tight">
                      {repayPct == null ? 'New' : `${repayPct}%`}
                    </p>
                    <p className="text-[11px] text-muted-foreground">{p.advances_count} advances taken</p>
                  </div>
                </div>
              ) : !onDemandLoading ? (
                <div className="rounded-xl border border-border bg-muted/40 p-3 text-xs text-muted-foreground inline-flex items-center gap-2">
                  <Info className="h-4 w-4" /> No potential score available for this agent — evaluate from the reason and history below.
                </div>
              ) : null}

              {/* Rent request outcomes — approved & disbursed vs pending / rejected */}
              {resolvedAgentId && <RentRequestOutcomes agentId={resolvedAgentId} />}

              {/* Score breakdown */}
              {p && (
                <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
                  <p className="text-xs font-bold flex items-center gap-1.5"><Info className="h-3.5 w-3.5" /> Performance breakdown</p>
                  <ScoreBar label="Sub-agent network" value={p.network_score} max={70} />
                  <ScoreBar label="Rent collections" value={p.collections_score} max={15} />
                  <ScoreBar label="Repayment performance" value={p.repayment_score} max={5} />
                  <ScoreBar label="House listings" value={p.listings_score} max={5} />
                  <ScoreBar label="Rent requests" value={p.requests_score} max={5} />
                </div>
              )}

              {/* Stats grid */}
              {p && (
                <div className="grid grid-cols-2 gap-2">
                  <StatBlock icon={Users} label="Direct sub-agents" value={String(p.direct_subagents)} sub={`${p.active_subagents} active`} />
                  <StatBlock icon={Network} label="Grand sub-agents" value={String(p.grand_subagents)} sub="Under their subs" />
                  <StatBlock icon={Wallet} label="Rent collected" value={formatUGX(p.rent_collected)} sub={`${p.collections_count} collections`} />
                  <StatBlock icon={Home} label="Houses listed" value={String(p.house_listings)} />
                  <StatBlock icon={FileText} label="Rent requests" value={String(p.rent_requests)} sub="For tenants" />
                  <StatBlock icon={TrendingUp} label="Repayment" value={repayPct == null ? 'No history' : `${repayPct}%`} sub={p.advances_count > 0 ? `${p.advances_count} advances` : 'Never taken advance'} />
                </div>
              )}

              {p && p.outstanding_total > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
                  Outstanding advance balance: <strong>{formatUGX(p.outstanding_total)}</strong>. Factor this into the decision.
                </div>
              )}

              {/* Cost breakdown of THIS request */}
              <div className="grid grid-cols-2 gap-2 p-3 rounded-xl bg-muted/50 text-xs">
                <div><span className="text-muted-foreground">Access Fee</span><br /><span className="font-bold">{formatUGX(num(req.access_fee))}</span></div>
                <div><span className="text-muted-foreground">Reg Fee</span><br /><span className="font-bold">{formatUGX(num(req.registration_fee))}</span></div>
                <div><span className="text-muted-foreground">Total Payable</span><br /><span className="font-bold text-primary">{formatUGX(num(req.total_payable))}</span></div>
                <div><span className="text-muted-foreground">Daily Deduction</span><br /><span className="font-bold text-rose-500">{formatUGX(num(req.daily_payment))}/d</span></div>
              </div>

              {/* Reason */}
              <div className="p-3 rounded-xl bg-muted/30">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground mb-1">Agent's reason</p>
                <p className="text-sm">{req.reason || '—'}</p>
              </div>

              {footer && (
                <div className="flex flex-col gap-2 sticky bottom-0 bg-background pt-1">
                  {footer}
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default AgentAdvanceEvaluationDialog;