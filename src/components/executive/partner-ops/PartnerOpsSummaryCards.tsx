import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Users, Wallet, CalendarDays, Hourglass, UserCog, ArrowRight, UserPlus } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { fetchSupporterSummary, fetchAllNearingPayoutPortfolios } from '@/lib/supabaseBatchUtils';
import { dateOnlyToLocalDate, extractDateOnly, formatLocalDateOnly } from '@/lib/portfolioDates';
import { PendingPortfoliosCard } from '@/components/executive/PendingPortfoliosCard';
import { PortfolioTopUpsCard } from '@/components/coo/PortfolioTopUpsCard';
import { OnboardProxyAgentDialog } from './OnboardProxyAgentDialog';
import type { PartnerOpsViewKey } from './partnerOpsNav';

/* ─── Card shell (mirrors the Partner Directory summary cards) ─── */
function SummaryCard({ icon, label, value, sub, accent, onClick }: {
  icon: React.ReactNode; label: string; value: string | number; sub: string;
  accent: 'primary' | 'amber';
  onClick?: () => void;
}) {
  const styles = {
    primary: { card: 'border-primary/30 bg-primary/5', icon: 'text-primary bg-primary/10' },
    amber: { card: 'border-amber-500/20 bg-amber-500/5', icon: 'text-amber-600 bg-amber-500/10' },
  };
  const s = styles[accent];
  return (
    <div
      className={cn('rounded-2xl border p-3.5 space-y-2', s.card, onClick && 'cursor-pointer transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring')}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="flex items-center gap-2">
        <div className={cn('p-1.5 rounded-lg', s.icon)}>{icon}</div>
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
      </div>
      <p className="text-xl font-black tracking-tight tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground leading-snug">{sub}</p>
    </div>
  );
}

/** Next payout date, timezone-safe, derived from created_at + payout_day when missing. */
function nextPayoutDate(nextRoiDate: string | null, createdAt: string, payoutDay: number): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const createdOnly = extractDateOnly(createdAt);
  const created = createdOnly ? dateOnlyToLocalDate(createdOnly) : new Date(createdAt);
  const day = Math.min(payoutDay || created.getDate(), 28);
  let d: Date;
  if (nextRoiDate) {
    d = dateOnlyToLocalDate(nextRoiDate);
  } else {
    d = new Date(created.getFullYear(), created.getMonth() + 1, day);
    while (d.getTime() < today.getTime()) d = new Date(d.getFullYear(), d.getMonth() + 1, day);
  }
  return formatLocalDateOnly(d);
}

const EXPIRY_WINDOW_DAYS = 90;

/**
 * Read-only mirror of the Partner Directory summary strip, for the Overview view.
 * Clicking a card navigates to the matching sidebar section.
 */
export function PartnerOpsSummaryCards({ onNavigate }: { onNavigate: (v: PartnerOpsViewKey) => void }) {
  const { data: summary } = useQuery({
    queryKey: ['partner-ops-overview-summary'],
    queryFn: fetchSupporterSummary,
    staleTime: 60_000,
  });

  const { data: derived } = useQuery({
    queryKey: ['partner-ops-overview-portfolio-signals'],
    staleTime: 60_000,
    queryFn: async () => {
      const { portfolios, supporterIds } = await fetchAllNearingPayoutPortfolios();
      const todayStr = formatLocalDateOnly(new Date());
      const now = new Date();
      now.setHours(0, 0, 0, 0);

      let dueTodayCount = 0;
      let dueTodayAmount = 0;
      let expiringCount = 0;
      let soonestExpiry: number | null = null;

      portfolios.forEach((p: any) => {
        if (p.status !== 'active') return;
        const ownerId = p.investor_id && supporterIds.has(p.investor_id) ? p.investor_id
          : p.agent_id && supporterIds.has(p.agent_id) ? p.agent_id : null;
        if (!ownerId) return;

        const nextDate = nextPayoutDate(p.next_roi_date, p.created_at, p.payout_day ?? 15);
        if (nextDate === todayStr) {
          dueTodayCount += 1;
          dueTodayAmount += Math.round((p.investment_amount || 0) * (p.roi_percentage ?? 15) / 100);
        }

        const expiry = new Date(p.created_at);
        expiry.setMonth(expiry.getMonth() + (Number(p.duration_months) || 12));
        const remainingDays = Math.ceil((expiry.getTime() - Date.now()) / 86400000);
        if (remainingDays >= 0 && remainingDays <= EXPIRY_WINDOW_DAYS) {
          expiringCount += 1;
          soonestExpiry = soonestExpiry === null ? remainingDays : Math.min(soonestExpiry, remainingDays);
        }
      });

      return { dueTodayCount, dueTodayAmount, expiringCount, soonestExpiry };
    },
  });

  const todayLabel = new Date().toLocaleDateString('en-UG', { weekday: 'short', day: 'numeric', month: 'short' });
  const dueTodayCount = derived?.dueTodayCount ?? 0;
  const hasPayouts = dueTodayCount > 0;
  const expiringCount = derived?.expiringCount ?? 0;
  const hasExpiring = expiringCount > 0;
  const soonest = derived?.soonestExpiry ?? null;
  const [inviteOpen, setInviteOpen] = useState(false);

  const { data: proxyStatus, isLoading: proxyStatusLoading } = useQuery({
    queryKey: ['partner-ops-proxy-agents-status-breakdown'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('proxy_agent_identity')
        .select('status, updated_at');
      if (error) throw error;
      const counts = { approved: 0, pending: 0, rejected: 0, suspended: 0, other: 0 };
      let lastUpdated: string | null = null;
      for (const row of data ?? []) {
        const s = String((row as any).status || '').toLowerCase();
        if (s === 'approved') counts.approved += 1;
        else if (s === 'pending') counts.pending += 1;
        else if (s === 'rejected') counts.rejected += 1;
        else if (s === 'suspended') counts.suspended += 1;
        else counts.other += 1;
        const u = (row as any).updated_at as string | null;
        if (u && (!lastUpdated || u > lastUpdated)) lastUpdated = u;
      }
      return { counts, lastUpdated };
    },
    staleTime: 60_000,
  });

  const proxyTotal = proxyStatus
    ? proxyStatus.counts.approved + proxyStatus.counts.pending + proxyStatus.counts.rejected + proxyStatus.counts.suspended + proxyStatus.counts.other
    : 0;

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
      <SummaryCard
        icon={<Users className="h-4 w-4" />}
        label="Total Partners"
        value={summary?.totalPartners ?? '—'}
        sub={summary ? `${summary.activePartners} active · ${summary.suspendedPartners} suspended` : 'Loading…'}
        accent="primary"
        onClick={() => onNavigate('directory')}
      />

      <PendingPortfoliosCard onClick={() => onNavigate('portfolios.pending')} />

      <SummaryCard
        icon={<Wallet className="h-4 w-4" />}
        label="Wallet Balances"
        value={summary ? formatUGX(summary.totalWalletBalance) : '—'}
        sub="Across all partner wallets · tap to view"
        accent="amber"
        onClick={() => onNavigate('financial.wallets')}
      />

      {/* Nearing payout · today */}
      <button
        onClick={() => onNavigate('nearing.overview')}
        aria-label={`${dueTodayCount} portfolio(s) reach Next Payout Date today`}
        className={cn(
          'rounded-2xl border p-4 space-y-2.5 text-left w-full transition-all hover:shadow-lg active:scale-[0.98]',
          hasPayouts ? 'border-amber-500/40 bg-amber-500/5 ring-2 ring-amber-500/20 shadow-sm' : 'border-violet-500/20 bg-violet-500/5',
        )}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className={cn('p-2 rounded-xl', hasPayouts ? 'bg-amber-500/10 text-amber-600' : 'bg-violet-500/10 text-violet-600')}>
              <CalendarDays className="h-5 w-5" />
            </div>
            <div>
              <span className={cn('text-xs font-bold uppercase tracking-wider', hasPayouts ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground')}>
                Nearing Payout · Today
              </span>
              <p className={cn('text-[11px] leading-snug mt-0.5', hasPayouts ? 'text-amber-600/80 font-medium' : 'text-muted-foreground')}>
                {hasPayouts ? `${todayLabel} · ~${formatUGX(derived?.dueTodayAmount || 0)} due` : `${todayLabel} · no payouts due`}
              </p>
            </div>
          </div>
          <div className={cn('text-2xl font-black tabular-nums px-3 py-1 rounded-xl', hasPayouts ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'text-foreground')}>
            {dueTodayCount}
          </div>
        </div>
      </button>

      {/* Expiring soon · 3 months */}
      <button
        onClick={() => onNavigate('portfolios.expiring')}
        aria-label={`${expiringCount} portfolio(s) expiring within 3 months`}
        className={cn(
          'rounded-2xl border p-4 space-y-2.5 text-left w-full transition-all hover:shadow-lg active:scale-[0.98]',
          hasExpiring ? 'border-rose-500/40 bg-rose-500/5 ring-2 ring-rose-500/20 shadow-sm' : 'border-primary/20 bg-primary/[0.03]',
        )}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className={cn('p-2 rounded-xl', hasExpiring ? 'bg-rose-500/10 text-rose-600' : 'bg-primary/10 text-primary')}>
              <Hourglass className="h-5 w-5" />
            </div>
            <div>
              <span className={cn('text-xs font-bold uppercase tracking-wider', hasExpiring ? 'text-rose-700 dark:text-rose-400' : 'text-muted-foreground')}>
                Expiring Soon · 3 mo
              </span>
              <p className={cn('text-[11px] leading-snug mt-0.5', hasExpiring ? 'text-rose-600/80 font-medium' : 'text-muted-foreground')}>
                {hasExpiring ? `Soonest in ${soonest} day${soonest === 1 ? '' : 's'}` : 'None expiring soon'}
              </p>
            </div>
          </div>
          <div className={cn('text-2xl font-black tabular-nums px-3 py-1 rounded-xl', hasExpiring ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300' : 'text-foreground')}>
            {expiringCount}
          </div>
        </div>
      </button>

      <PortfolioTopUpsCard />

      {/* Proxy Agent Management — full-width entry point to the agent directory */}
      <button
        type="button"
        onClick={() => onNavigate('proxy.directory')}
        aria-label="Open Proxy Agent Management"
        className="col-span-2 lg:col-span-3 group text-left w-full rounded-2xl border border-primary/30 bg-primary/5 p-4 transition-all hover:bg-primary/10 hover:shadow-md hover:ring-2 hover:ring-primary/20 active:scale-[0.98]"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-xl bg-primary/10 p-2.5 text-primary">
              <UserCog className="h-6 w-6" />
            </div>
            <div>
              <span className="text-xs font-bold uppercase tracking-wider text-primary">Proxy Agent Management</span>
              <p className="mt-0.5 text-sm font-medium text-muted-foreground">
                {proxyStatusLoading
                  ? 'Checking agent records…'
                  : proxyTotal > 0
                    ? `${proxyTotal.toLocaleString()} agent${proxyTotal === 1 ? '' : 's'} on record · tap to manage`
                    : 'No proxy agents yet · invite the first one'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 text-primary">
            <span
              role="button"
              tabIndex={0}
              aria-label="Invite proxy agent"
              onClick={(e) => { e.stopPropagation(); setInviteOpen(true); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); setInviteOpen(true); } }}
              className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
            >
              <UserPlus className="h-3.5 w-3.5" />
              Invite
            </span>
            <span className="hidden text-xs font-semibold sm:inline">Open</span>
            <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </div>
        </div>

        {/* Status breakdown — skeleton while loading, empty state when no agents */}
        {proxyStatusLoading ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5" aria-busy="true" aria-label="Loading proxy agent status">
            {[72, 64, 64, 76].map((w, i) => (
              <span key={i} className="h-7 animate-pulse rounded-full bg-primary/10" style={{ width: w }} />
            ))}
            <span className="ml-auto h-3.5 w-28 animate-pulse rounded bg-primary/10" />
          </div>
        ) : proxyTotal === 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-primary/30 bg-background/60 px-3 py-2.5">
            <UserPlus className="h-4 w-4 text-primary" />
            <p className="text-xs text-muted-foreground">
              Nothing here yet — use <span className="font-semibold text-foreground">Invite</span> above to onboard the first proxy agent.
            </p>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {([
              ['Approved', proxyStatus?.counts.approved, 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/30'],
              ['Pending', proxyStatus?.counts.pending, 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30'],
              ['Rejected', proxyStatus?.counts.rejected, 'bg-rose-500/10 text-rose-700 dark:text-rose-300 border-rose-500/30'],
              ['Suspended', proxyStatus?.counts.suspended, 'bg-muted text-muted-foreground border-border'],
            ] as const).map(([label, count, cls]) => (
              <span
                key={label}
                className={cn('inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-bold tabular-nums', cls)}
              >
                {label}: {typeof count === 'number' ? count.toLocaleString() : '—'}
              </span>
            ))}
            <span className="ml-auto text-[10px] text-muted-foreground">
              {proxyStatus?.lastUpdated
                ? `Last updated ${new Date(proxyStatus.lastUpdated).toLocaleDateString('en-UG', { day: 'numeric', month: 'short' })}, ${new Date(proxyStatus.lastUpdated).toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit' })}`
                : 'Last updated —'}
            </span>
          </div>
        )}
      </button>

      <OnboardProxyAgentDialog open={inviteOpen} onOpenChange={setInviteOpen} />
    </div>
  );
}