import { useEffect, useMemo, useState } from 'react';
import { ChevronRight, Building2, Clock, RefreshCw } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import type { PortfolioRecord } from '@/hooks/useCapitalOpportunities';
import { computeAccrual, type PortfolioState } from '@/lib/portfolioAccrual';
import { usePendingTopup } from './ActivePortfolioCard';

/**
 * Fanned stack of the partner's portfolios, like a wallet of cards.
 * The front card is the selected portfolio; its details sit in the panel under the stack.
 * Tap a card behind to bring it forward; tap the panel to open the portfolio.
 * Display only: it reads the same figures as the list card and moves no money.
 */

const PEEK = 44; // how much of each card behind shows
const FRONT_VISIBLE = 104; // how much of the front card shows above the panel
const CARD_HEIGHT = 176;

// One brand purple, lighter and softer for the cards behind.
const FACES = [
  'linear-gradient(135deg, hsl(271 81% 50%) 0%, hsl(262 74% 36%) 100%)',
  'linear-gradient(135deg, hsl(271 52% 58%) 0%, hsl(265 46% 46%) 100%)',
  'linear-gradient(135deg, hsl(271 40% 66%) 0%, hsl(268 36% 54%) 100%)',
];

const STATE_LABEL: Record<PortfolioState, { label: string; dot: string }> = {
  active: { label: 'Active', dot: 'bg-emerald-300' },
  pending: { label: 'Pending', dot: 'bg-amber-300' },
  matured: { label: 'Matured', dot: 'bg-white' },
  paused: { label: 'Paused', dot: 'bg-white/60' },
  locked: { label: 'Locked', dot: 'bg-amber-300' },
  withdrawn: { label: 'Withdrawn', dot: 'bg-white/50' },
};

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return reduced;
}

function remainingLabel(daysToPayout: number | null) {
  if (daysToPayout === null) return null;
  if (daysToPayout < 0) return 'Ready for payout';
  if (daysToPayout === 0) return 'Ready today';
  if (daysToPayout === 1) return 'Pays tomorrow';
  return `${daysToPayout} days remaining`;
}

export function PortfolioCardStack({
  portfolios,
  onView,
}: {
  portfolios: PortfolioRecord[];
  onView: (portfolioId: string) => void;
}) {
  const reduced = usePrefersReducedMotion();
  const idsKey = portfolios.map((p) => p.id).join('|');
  // Back to front: the first portfolio (newest) starts at the front.
  const [order, setOrder] = useState<string[]>(() => portfolios.map((p) => p.id).reverse());
  useEffect(() => {
    setOrder(portfolios.map((p) => p.id).reverse());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  const accruals = useMemo(
    () => Object.fromEntries(portfolios.map((p) => [p.id, computeAccrual(p)])),
    [portfolios],
  );
  const byId = useMemo(() => Object.fromEntries(portfolios.map((p) => [p.id, p])), [portfolios]);

  const frontId = order[order.length - 1];
  const front = frontId ? byId[frontId] : undefined;
  const pendingTopup = usePendingTopup(front?.id);
  if (!front) return null;

  const depth = order.length - 1;
  const a = accruals[front.id];
  const isActive = a.state === 'active';
  const progressPct = Math.round(a.cycleProgress * 100);
  const period = a.isMonthlyCycle ? 'Monthly Returns' : `${a.cycleDays}-day Returns`;
  const isCompounding = front.roi_mode === 'monthly_compounding' || front.auto_reinvest === true;
  const remaining = remainingLabel(a.daysToPayout);

  return (
    <div className="overflow-hidden rounded-3xl border border-border/60 bg-card">
      {/* The stack. Cards behind show a strip; every card is clipped where the panel starts. */}
      <div
        className="relative mx-auto w-full overflow-hidden px-4 pt-4"
        style={{ height: 16 + depth * PEEK + FRONT_VISIBLE }}
      >
        {order.map((id, pos) => {
          const p = byId[id];
          const acc = accruals[id];
          const fromFront = depth - pos; // 0 = front
          const isFront = fromFront === 0;
          const st = STATE_LABEL[acc.state];
          const ref = p.portfolio_code || p.account_name || 'Portfolio';
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                if (isFront) return;
                hapticTap();
                setOrder((o) => [...o.filter((x) => x !== id), id]);
              }}
              aria-label={`${ref}, ${st.label}${isFront ? ', selected' : ', bring to front'}`}
              aria-pressed={isFront}
              className="absolute left-4 right-4 block rounded-2xl p-0 text-left text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{
                top: 16 + (depth - fromFront) * PEEK,
                height: CARD_HEIGHT,
                zIndex: pos + 1,
                transform: `scale(${1 - fromFront * 0.05})`,
                transformOrigin: 'top center',
                background: FACES[Math.min(fromFront, FACES.length - 1)],
                boxShadow: '0 -8px 22px -14px rgba(32, 8, 72, 0.7), inset 0 1px 0 rgba(255,255,255,0.35)',
                cursor: isFront ? 'default' : 'pointer',
                transition: reduced
                  ? 'none'
                  : 'top 520ms cubic-bezier(0.34, 1.3, 0.64, 1), transform 520ms cubic-bezier(0.34, 1.3, 0.64, 1)',
              }}
            >
              {/* soft top gloss, static so it costs nothing to draw */}
              <span
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-2xl"
                style={{ backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0) 38%)' }}
              />
              <span className="relative flex items-center justify-between gap-3 px-4 pt-3">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="grid h-7 w-7 flex-none place-items-center rounded-full bg-white/20">
                    <Building2 className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[10px] font-medium uppercase leading-none tracking-wide text-white/75">Tenant capital</span>
                    <span className="block truncate text-sm font-semibold leading-tight">{ref}</span>
                  </span>
                </span>
                <span className="flex flex-none items-center gap-1.5 text-xs font-medium">
                  <span className={cn('h-1.5 w-1.5 rounded-full', st.dot)} aria-hidden />
                  {st.label}
                </span>
              </span>
              <span className="relative mt-3 block px-4 text-xs font-medium text-white/80">
                {acc.monthlyRoiPct}% · {acc.isMonthlyCycle ? 'Monthly Returns' : `${acc.cycleDays}-day Returns`}
              </span>
            </button>
          );
        })}
      </div>

      {/* Details of the front portfolio. Tapping it opens the portfolio, as the list card did. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => { hapticTap(); onView(front.id); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            hapticTap();
            onView(front.id);
          }
        }}
        aria-label={`Open portfolio ${front.portfolio_code || ''}`}
        className="relative z-[20] -mt-px cursor-pointer rounded-t-3xl border-t border-border/60 bg-card px-4 pb-4 pt-4 active:bg-muted/30"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Principal</p>
            <p className="mt-0.5 break-words text-2xl font-bold leading-tight tracking-tight text-foreground">{formatUGX(a.deployed)}</p>
          </div>
          <span className="mt-1 grid h-9 w-9 flex-none place-items-center rounded-full bg-muted text-muted-foreground">
            <ChevronRight className="h-4 w-4" />
          </span>
        </div>

        {isActive && (
          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                Earned <span className="font-semibold text-success">+{formatUGX(Math.round(a.cycleAccrued))}</span>
              </span>
              {remaining && <span className="font-medium text-foreground">{remaining}</span>}
            </div>
            <div
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPct}
              aria-label="Payout cycle progress"
            >
              <div className="h-full rounded-full bg-primary transition-all duration-1000" style={{ width: `${progressPct}%` }} />
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              {formatUGX(Math.round(a.dailyAccrual))}/day · day {a.cycleElapsedDays}/{a.cycleDays} · {period}
            </p>
          </div>
        )}

        {(isCompounding || pendingTopup > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {isCompounding && (
              <span className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium text-primary">
                <RefreshCw className="h-3 w-3" />
                Compounding
              </span>
            )}
            {pendingTopup > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-border px-2.5 py-0.5 text-[11px] font-medium text-warning">
                <Clock className="h-3 w-3" />
                +{formatUGX(pendingTopup)} pending
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
