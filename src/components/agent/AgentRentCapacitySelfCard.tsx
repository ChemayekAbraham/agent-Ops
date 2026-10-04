import { useMemo, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
  useAgentCapacityMap,
  AGENT_RENT_CAP_UGX,
  AGENT_TIER_THRESHOLDS,
  DAILY_ELIGIBILITY_THRESHOLD,
  type AgentCapacity,
} from '@/hooks/useAgentCapacityMap';
import { formatUGX } from '@/lib/rentCalculations';
import { Gauge, CalendarCheck2, Users, Info, Printer, Loader2, ChevronDown, ChevronUp, CheckCircle2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { hapticTap } from '@/lib/haptics';
import {
  fetchAgentCapacityTenants,
  generateAgentCapacityPdf,
  downloadCapacityPdf,
} from '@/lib/generateAgentCapacityPdf';
import { supabase } from '@/integrations/supabase/client';
import { DailyRatingThresholdPopover } from '@/components/shared/DailyRatingThresholdPopover';

const TIER_TONE: Record<AgentCapacity['tier'], string> = {
  Positive:   'bg-emerald-500/15 text-emerald-700 border-emerald-500/30',
  Fair:       'bg-amber-500/15 text-amber-700 border-amber-500/30',
  Bad:        'bg-orange-500/15 text-orange-700 border-orange-500/30',
  'Very Bad': 'bg-destructive/15 text-destructive border-destructive/30',
  Starter:    'bg-violet-500/15 text-violet-700 border-violet-500/30',
};

/**
 * Agent-facing capacity & tier card. Shows the same numbers Ops sees,
 * plus a plain-English explanation of how the tier was computed.
 */
export function AgentRentCapacitySelfCard() {
  const { user } = useAuth();
  const ids = useMemo(() => (user?.id ? [user.id] : []), [user?.id]);
  const { data, isLoading } = useAgentCapacityMap(ids);
  const cap = user?.id ? data?.get(user.id) : undefined;
  const [printing, setPrinting] = useState(false);
  const [open, setOpen] = useState(false);

  const handlePrint = async () => {
    if (!user?.id || !cap) return;
    setPrinting(true);
    try {
      const { data: prof } = await supabase
        .from('profiles')
        .select('full_name, phone')
        .eq('id', user.id)
        .maybeSingle();
      const tenants = await fetchAgentCapacityTenants(user.id, cap);
      const blob = generateAgentCapacityPdf(
        { full_name: prof?.full_name || 'Agent', phone: prof?.phone || null },
        cap,
        tenants,
      );
      downloadCapacityPdf(blob, prof?.full_name || 'agent');
      toast.success('Capacity report downloaded');
    } catch (err: any) {
      toast.error(err?.message || 'Failed to generate report');
    } finally {
      setPrinting(false);
    }
  };

  if (!user?.id) return null;

  const ratePct = cap ? Math.round(cap.response_rate * 100) : 0;
  const pct = cap ? cap.pct : 0;
  const bar = pct >= 95 ? 'bg-destructive' : pct >= 75 ? 'bg-amber-500' : 'bg-emerald-500';

  return (
    <div className="rounded-2xl border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={() => { hapticTap(); setOpen(o => !o); }}
        aria-expanded={open}
        aria-controls="agent-rent-capacity-body"
        className="w-full text-left p-4 bg-gradient-to-br from-primary/10 via-violet-500/5 to-transparent border-b border-border hover:bg-primary/5 transition-colors"
      >
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
            <Gauge className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-foreground">My Rent-Request Capacity</h3>
            <p className="text-xs text-muted-foreground">
              {open ? 'Tap to hide details' : 'Tap to see how much rent you can post'}
            </p>
          </div>
          {cap && (
            <span
              className={`px-2.5 py-1 rounded-full text-xs font-extrabold border ${TIER_TONE[cap.tier]} shrink-0`}
            >
              {cap.tier} · {ratePct}%
            </span>
          )}
          {open
            ? <ChevronUp className="h-5 w-5 text-muted-foreground shrink-0" />
            : <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0" />}
        </div>
        {!open && cap && (
          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
            <div className="rounded-lg bg-background/70 border border-border p-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Headroom left</div>
              <div className="mt-0.5 font-extrabold tabular-nums text-foreground">{formatUGX(cap.headroom)}</div>
            </div>
            <div className="rounded-lg bg-background/70 border border-border p-2.5">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Per-tenant max</div>
              <div className="mt-0.5 font-extrabold tabular-nums text-foreground">{formatUGX(cap.per_tenant_max)}</div>
            </div>
          </div>
        )}
      </button>

      {open && (
      <div id="agent-rent-capacity-body" className="p-4 space-y-4">
        {cap && (
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 px-3"
              onClick={handlePrint}
              disabled={printing}
              title="Download per-tenant capacity PDF"
            >
              {printing
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <Printer className="h-4 w-4" />}
              <span className="text-xs font-semibold">Print report</span>
            </Button>
          </div>
        )}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading capacity…</p>
        ) : !cap ? (
          <p className="text-sm text-muted-foreground leading-relaxed">
            You have no active rent requests yet. Once you post one, your tier will start at{' '}
            <strong>Starter</strong> with a UGX 500,000 per-tenant limit.
          </p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                Daily Performance Rating
              </span>
              <DailyRatingThresholdPopover />
            </div>

            {/* Daily Eligibility Law banner — one distinct message per rating level */}
            {(() => {
              const rating = cap.daily_rating;
              const ypct = Math.round(cap.yesterday_response_pct * 100);
              const tpct = Math.round(cap.today_response_pct * 100);
              const threshold = Math.round(DAILY_ELIGIBILITY_THRESHOLD * 100);
              const baseMsg = (
                <>Today you have collected{' '}
                  <strong className="font-mono">{formatUGX(cap.paid_today)}</strong>{' '}
                  of <strong className="font-mono">{formatUGX(cap.expected_daily)}</strong>{' '}
                  expected daily — that is <strong>{tpct}%</strong> of today&apos;s target.
                  {' '}Yesterday: <strong className="font-mono">{formatUGX(cap.paid_yesterday)}</strong> ({ypct}%).
                </>
              );
              if (rating === 'Starter') {
                return (
                  <div className="rounded-xl border border-violet-500/30 bg-violet-500/5 p-3 flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-violet-600 shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <div className="font-bold text-violet-700">You can post your first rent request</div>
                      <p className="text-muted-foreground mt-0.5">
                        Once you have active rents, you must collect at least{' '}
                        <strong>{threshold}%</strong> of your expected daily rent each day
                        to keep posting new ones tomorrow.
                      </p>
                    </div>
                  </div>
                );
              }
              if (rating === 'Very Good') {
                return (
                  <div className="rounded-xl border border-emerald-600/50 bg-emerald-600/10 p-3 flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <div className="font-extrabold text-emerald-700">Very Good — outstanding daily performance, free to post today</div>
                      <p className="text-foreground/80 mt-0.5">
                        {baseMsg} You are well above the <strong>{threshold}%</strong> daily law and can post new rent requests. Keep this up to stay at the top.
                      </p>
                    </div>
                  </div>
                );
              }
              if (rating === 'Good') {
                return (
                  <div className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-3 flex items-start gap-3">
                    <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <div className="font-extrabold text-emerald-700">Good — you can post new rent requests today</div>
                      <p className="text-foreground/80 mt-0.5">
                        {baseMsg} You met the <strong>{threshold}%</strong> daily law. Keep collecting to move up to <strong className="text-emerald-700">Very Good</strong> (≥ 50%).
                      </p>
                    </div>
                  </div>
                );
              }
              if (rating === 'Fair') {
                return (
                  <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 flex items-start gap-3">
                    <Lock className="h-5 w-5 text-amber-600 shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <div className="font-extrabold text-amber-700">Fair — close to target but blocked from new rent requests today</div>
                      <p className="text-foreground/80 mt-0.5">
                        {baseMsg} You are between 15% and 19%, just shy of the <strong>{threshold}%</strong> unblock line. Hit <strong>{threshold}%</strong> today and you will be unblocked and rated <strong className="text-emerald-700">Good</strong> immediately.
                      </p>
                    </div>
                  </div>
                );
              }
              if (rating === 'Bad') {
                return (
                  <div className="rounded-xl border border-orange-500/40 bg-orange-500/10 p-3 flex items-start gap-3">
                    <Lock className="h-5 w-5 text-orange-600 shrink-0 mt-0.5" />
                    <div className="text-sm">
                      <div className="font-extrabold text-orange-700">Bad — well below target, blocked from new rent requests today</div>
                      <p className="text-foreground/80 mt-0.5">
                        {baseMsg} You are between 5% and 14%, below the <strong>{threshold}%</strong> daily law. Hit <strong>{threshold}%</strong> today and you will be unblocked and rated <strong className="text-emerald-700">Good</strong> immediately.
                      </p>
                    </div>
                  </div>
                );
              }
              // Very Bad
              return (
                <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 flex items-start gap-3">
                  <Lock className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
                  <div className="text-sm">
                    <div className="font-extrabold text-destructive">Very Bad — critically low, blocked from new rent requests today</div>
                    <p className="text-foreground/80 mt-0.5">
                      {baseMsg} You are below 5%, far below the <strong>{threshold}%</strong> daily law. Hit <strong>{threshold}%</strong> today and you will be unblocked and rated <strong className="text-emerald-700">Good</strong> immediately.
                    </p>
                  </div>
                </div>
              );
            })()}

            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-xs font-bold uppercase tracking-wide text-emerald-700">
                    Last 7 days · Tenants who paid
                  </div>
                  <div className="mt-1 text-3xl font-extrabold tabular-nums text-foreground">
                    {cap.paying_tenants_last_week}
                    <span className="text-lg font-bold text-muted-foreground">
                      {' '}/ {cap.active_tenant_count} tenants
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    Daily response rate: <strong>{ratePct}%</strong> ·{' '}
                    {cap.responding_tenant_days}/{cap.expected_tenant_days} tenant-day responses
                  </p>
                  {cap.unfunded_tenant_count > 1 && (
                    <p className="mt-1 text-sm font-bold text-destructive">
                      {cap.unfunded_tenant_count} tenants marked <span className="underline">Not Funded</span> — removed from your expected list
                    </p>
                  )}
                  {cap.unfunded_tenant_count === 1 && (
                    <p className="mt-1 text-sm font-bold text-destructive">
                      1 tenant marked <span className="underline">Not Funded</span> — removed from your expected list
                    </p>
                  )}
                </div>
                <div className="h-14 w-14 rounded-full border-2 border-emerald-500/30 flex items-center justify-center shrink-0">
                  <CalendarCheck2 className="h-7 w-7 text-emerald-600" />
                </div>
              </div>
              <div className="mt-3 h-2.5 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${ratePct}%` }}
                />
              </div>
            </div>

            {/* Paid vs Expected — today + this week */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {(() => {
                const expectedWeek = cap.expected_daily * 7;
                const todayPct = cap.expected_daily > 0
                  ? Math.min(100, Math.round((cap.paid_today / cap.expected_daily) * 100))
                  : 0;
                const weekPct = expectedWeek > 0
                  ? Math.min(100, Math.round((cap.paid_last_week / expectedWeek) * 100))
                  : 0;
                const todayTone = todayPct >= 100 ? 'text-emerald-700' : todayPct >= 50 ? 'text-amber-700' : 'text-destructive';
                const weekTone = weekPct >= 100 ? 'text-emerald-700' : weekPct >= 50 ? 'text-amber-700' : 'text-destructive';
                const todayBar = todayPct >= 100 ? 'bg-emerald-500' : todayPct >= 50 ? 'bg-amber-500' : 'bg-destructive';
                const weekBar = weekPct >= 100 ? 'bg-emerald-500' : weekPct >= 50 ? 'bg-amber-500' : 'bg-destructive';
                return (
                  <>
                    <div className="rounded-xl border border-border bg-background/70 p-3">
                      <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">Today · Paid vs Expected</div>
                      <div className={`mt-1 text-base font-extrabold tabular-nums ${todayTone}`}>
                        {formatUGX(cap.paid_today)}
                        <span className="text-muted-foreground font-semibold"> / {formatUGX(cap.expected_daily)}</span>
                      </div>
                      <div className="mt-1.5 h-2 w-full rounded-full bg-muted overflow-hidden">
                        <div className={`h-full ${todayBar}`} style={{ width: `${todayPct}%` }} />
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">{todayPct}% of daily target</div>
                    </div>
                    <div className="rounded-xl border border-border bg-background/70 p-3">
                      <div className="text-xs font-bold uppercase tracking-wide text-muted-foreground">This week (7d) · Paid vs Expected</div>
                      <div className={`mt-1 text-base font-extrabold tabular-nums ${weekTone}`}>
                        {formatUGX(cap.paid_last_week)}
                        <span className="text-muted-foreground font-semibold"> / {formatUGX(expectedWeek)}</span>
                      </div>
                      <div className="mt-1.5 h-2 w-full rounded-full bg-muted overflow-hidden">
                        <div className={`h-full ${weekBar}`} style={{ width: `${weekPct}%` }} />
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">{weekPct}% of weekly target</div>
                    </div>
                  </>
                );
              })()}
            </div>

            <div>
              <div className="flex items-center justify-between text-sm font-semibold tabular-nums mb-1.5">
                <span className="text-muted-foreground">
                  Exposure{' '}
                  <span className="text-foreground">{formatUGX(cap.used)}</span> /{' '}
                  {formatUGX(AGENT_RENT_CAP_UGX)}
                </span>
                <span className="text-muted-foreground">{pct}%</span>
              </div>
              <div className="h-2.5 w-full rounded-full bg-muted overflow-hidden">
                <div className={`h-full ${bar} transition-all`} style={{ width: `${pct}%` }} />
              </div>
              <div className="flex items-center justify-between text-sm mt-2 text-muted-foreground">
                <span>
                  Headroom <strong className="text-foreground font-mono">{formatUGX(cap.headroom)}</strong>
                </span>
                <span>
                  Per-tenant max{' '}
                  <strong className="text-foreground font-mono">{formatUGX(cap.per_tenant_max)}</strong>
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="rounded-xl border border-border bg-background/70 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-primary">
                  <Users className="h-4 w-4" />
                  Active Tenants
                </div>
                <div className="mt-1 text-lg font-extrabold tabular-nums text-foreground">
                  {cap.active_count}
                </div>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  Each tenant × 7 days = {cap.expected_tenant_days} chances to respond
                </p>
              </div>
              <div className="rounded-xl border border-border bg-background/70 p-3">
                <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-emerald-600">
                  <CalendarCheck2 className="h-4 w-4" />
                  Responses · Last 7 days
                </div>
                <div className="mt-1 text-lg font-extrabold tabular-nums text-foreground">
                  {cap.responding_tenant_days}
                </div>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  Tenant-days with any payment · {formatUGX(cap.paid_last_week)} total
                </p>
              </div>
            </div>
          </>
        )}

        <div className="rounded-xl border border-border bg-muted/40 p-4">
          <div className="flex items-center gap-2 text-sm font-bold text-foreground mb-2">
            <Info className="h-4 w-4 text-primary" />
            How your tier is calculated
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            We measure <strong>responsiveness</strong>, not the size of payments. For each of your
            active tenants over the last 7 days, we check: <em>did they pay anything that day?</em>
            {' '}Even UGX 1,000 counts as a response. Your tier rewards agents who keep tenants
            paying every single day.
          </p>
          <ul className="mt-3 space-y-2 text-sm">
            <li className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
                <strong className="text-foreground">Positive</strong>
                <span className="text-muted-foreground">
                  ≥ {Math.round(AGENT_TIER_THRESHOLDS.positive * 100)}% daily response
                </span>
              </span>
              <span className="font-mono text-foreground">UGX 6,000,000 / tenant</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-amber-500" />
                <strong className="text-foreground">Fair</strong>
                <span className="text-muted-foreground">
                  {Math.round(AGENT_TIER_THRESHOLDS.fair * 100)}–
                  {Math.round(AGENT_TIER_THRESHOLDS.positive * 100) - 1}%
                </span>
              </span>
              <span className="font-mono text-foreground">UGX 3,000,000 / tenant</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-orange-500" />
                <strong className="text-foreground">Bad</strong>
                <span className="text-muted-foreground">
                  {Math.round(AGENT_TIER_THRESHOLDS.bad * 100)}–
                  {Math.round(AGENT_TIER_THRESHOLDS.fair * 100) - 1}%
                </span>
              </span>
              <span className="font-mono text-foreground">UGX 1,000,000 / tenant</span>
            </li>
            <li className="flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-destructive" />
                <strong className="text-foreground">Very Bad</strong>
                <span className="text-muted-foreground">
                  ≤ {Math.round(AGENT_TIER_THRESHOLDS.bad * 100) - 1}%
                </span>
              </span>
              <span className="font-mono text-destructive">Blocked from new requests</span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-muted-foreground leading-relaxed">
            New agents start at <strong>Starter</strong> (UGX 500,000 / tenant) until they have
            active rent collections to measure. Your tier refreshes daily based on the most recent
            7-day window — so a strong week immediately moves you up.
          </p>
        </div>
      </div>
      )}
    </div>
  );
}

export default AgentRentCapacitySelfCard;