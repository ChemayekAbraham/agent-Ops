import { useQuery } from '@tanstack/react-query';
import { Users, Wallet, CalendarDays, Hourglass, UserCog, ArrowRight } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { fetchSupporterSummary, fetchAllNearingPayoutPortfolios } from '@/lib/supabaseBatchUtils';
import { dateOnlyToLocalDate, extractDateOnly, formatLocalDateOnly } from '@/lib/portfolioDates';
import { PendingPortfoliosCard } from '@/components/executive/PendingPortfoliosCard';
import { PortfolioTopUpsCard } from '@/components/coo/PortfolioTopUpsCard';
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
    </div>
  );
}