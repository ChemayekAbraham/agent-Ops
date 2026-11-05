import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronRight, Building2, Clock, RefreshCw } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import type { PortfolioRecord } from '@/hooks/useCapitalOpportunities';
import { computeAccrual } from '@/lib/portfolioAccrual';
import { usePendingTopup } from './ActivePortfolioCard';

/**
 * Fanned stack of the partner's portfolios, like a wallet of cards.
 * The front card is the selected portfolio; its details sit in a frosted panel under the stack.
 * Tap a card behind to bring it forward; tap the panel to open the portfolio.
 * Display only: it reads the same figures as the list card and moves no money.
 */

const PEEK = 46; // how much of each card behind shows
const CARD_HEIGHT = 176;
const FRONT_VISIBLE = 104; // how much of the front card shows above the panel
const OVERLAP = CARD_HEIGHT - FRONT_VISIBLE; // how far the cards tuck under the panel
const SPRING = 'cubic-bezier(0.34, 1.35, 0.64, 1)';

interface Palette {
  from: string;
  to: string;
  ink: string;
}

// Lime, lilac and peach, each a card of its own. Plain hex so older Android WebViews draw them.
const PALETTES: Palette[] = [
  { from: '#b4f24e', to: '#00cb90', ink: '#092104' },
  { from: '#c7aff5', to: '#847ce2', ink: '#16102f' },
  { from: '#fcb17e', to: '#ed7665', ink: '#35180e' },
];

const FILM =
  'linear-gradient(115deg, transparent 18%, rgba(255,189,233,0.55) 32%, rgba(148,245,255,0.55) 42%, rgba(204,254,152,0.5) 52%, rgba(255,210,145,0.45) 62%, transparent 78%)';

const STATE_LABEL: Record<string, string> = {
  active: 'Active',
  pending: 'Pending',
  matured: 'Matured',
  paused: 'Paused',
  locked: 'Locked',
  withdrawn: 'Withdrawn',
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

/** The app's low-power mode for phones that struggle with blur and blend effects. */
const isSafeMode = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('android-compositor-safe');

function useMounted() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return on;
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
  const safe = useMemo(isSafeMode, []);
  const mounted = useMounted();
  const stackRef = useRef<HTMLDivElement>(null);
  const pointerActive = useRef(false);

  const idsKey = portfolios.map((p) => p.id).join('|');
  // Back to front: the first portfolio (newest) starts at the front.
  const [order, setOrder] = useState<string[]>(() => portfolios.map((p) => p.id).reverse());
  useEffect(() => {
    setOrder(portfolios.map((p) => p.id).reverse());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey]);

  // Each portfolio keeps its own colour, even when it moves to the front.
  const paletteOf = useMemo(
    () => Object.fromEntries(portfolios.map((p, i) => [p.id, PALETTES[i % PALETTES.length]])),
    [portfolios],
  );
  const accruals = useMemo(
    () => Object.fromEntries(portfolios.map((p) => [p.id, computeAccrual(p)])),
    [portfolios],
  );
  const byId = useMemo(() => Object.fromEntries(portfolios.map((p) => [p.id, p])), [portfolios]);

  // The shimmer is written straight to a CSS variable, so it never re-renders the cards.
  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    el.style.setProperty('--glare', '30');
    if (reduced || safe) return;
    let visible = true;
    const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    io.observe(el);
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!visible || document.hidden || pointerActive.current) return;
      el.style.setProperty('--glare', String(30 + Math.sin((now - t0) / 2600) * 30));
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
  }, [reduced, safe]);

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

  const panelStyle: CSSProperties = {
    marginTop: -OVERLAP,
    background: safe ? 'hsl(var(--card))' : 'hsl(var(--card) / 0.82)',
    borderTop: '1px solid hsl(var(--foreground) / 0.1)',
    ...(safe ? {} : { backdropFilter: 'blur(18px) saturate(1.3)', WebkitBackdropFilter: 'blur(18px) saturate(1.3)' }),
  };

  return (
    <div className="overflow-hidden rounded-3xl border border-border/60 bg-card">
      {/* The stack. Pointer position drives the shimmer on every card. */}
      <div
        ref={stackRef}
        className="relative px-4 pt-4"
        style={{ height: 16 + depth * PEEK + CARD_HEIGHT, '--glare': 30 } as CSSProperties}
        onPointerMove={(e) => {
          if (reduced || safe) return;
          const r = e.currentTarget.getBoundingClientRect();
          pointerActive.current = true;
          e.currentTarget.style.setProperty('--glare', String(((e.clientX - r.left) / r.width) * 100));
        }}
        onPointerLeave={() => { pointerActive.current = false; }}
      >
        {order.map((id, pos) => {
          const p = byId[id];
          const acc = accruals[id];
          const pal = paletteOf[id];
          const fromFront = depth - pos; // 0 = front
          const isFront = fromFront === 0;
          const ref = p.portfolio_code || p.account_name || 'Portfolio';
          const status = STATE_LABEL[acc.state] ?? acc.state;
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                if (isFront) return;
                hapticTap();
                setOrder((o) => [...o.filter((x) => x !== id), id]);
              }}
              aria-label={`${ref}, ${status}${isFront ? ', selected' : ', bring to front'}`}
              aria-pressed={isFront}
              className="absolute left-4 right-4 block rounded-2xl p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              style={{
                top: 16 + (depth - fromFront) * PEEK,
                height: CARD_HEIGHT,
                zIndex: pos + 1,
                transform: `scale(${1 - fromFront * 0.055}) translateY(${mounted ? 0 : 20}px)`,
                transformOrigin: 'top center',
                opacity: mounted ? 1 : 0,
                color: pal.ink,
                boxShadow: '0 -10px 28px -14px rgba(0,0,0,0.75)',
                cursor: isFront ? 'default' : 'pointer',
                transition: reduced
                  ? 'none'
                  : `top 650ms ${SPRING}, transform 650ms ${SPRING}, opacity 500ms ease ${pos * 90}ms`,
              }}
            >
              {/* card face: gloss, corner glow and the colour gradient */}
              <span
                aria-hidden
                className="absolute inset-0 overflow-hidden rounded-2xl"
                style={{
                  backgroundImage: [
                    'linear-gradient(180deg, rgba(255,255,255,0.3) 0%, transparent 34%)',
                    `radial-gradient(110% 90% at 100% 0%, ${pal.to} 0%, transparent 60%)`,
                    `linear-gradient(135deg, ${pal.from} 0%, ${pal.to} 100%)`,
                  ].join(', '),
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5), inset 0 0 0 1px rgba(255,255,255,0.16)',
                }}
              >
                {/* holographic film that slides with the pointer */}
                {!safe && (
                  <span
                    className="absolute inset-0"
                    style={{
                      backgroundImage: FILM,
                      backgroundSize: '260% 100%',
                      backgroundPosition: `calc((var(--glare, 30) + ${fromFront * 18}) * 1%) 0`,
                      mixBlendMode: 'soft-light',
                      transition: reduced ? 'none' : 'background-position 700ms cubic-bezier(0.22, 1, 0.36, 1)',
                    }}
                  />
                )}
              </span>

              <span className="relative flex items-center justify-between gap-3 px-4 pt-3.5">
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="grid h-7 w-7 flex-none place-items-center rounded-full" style={{ background: 'rgba(255,255,255,0.35)' }}>
                    <Building2 className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[10px] font-semibold uppercase leading-none tracking-wide opacity-70">Tenant capital</span>
                    <span className="block truncate text-[13px] font-bold leading-tight tracking-tight">{ref}</span>
                  </span>
                </span>
                <span className="flex flex-none items-center gap-1.5 font-mono text-[12px] font-semibold">
                  <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                  {status}
                </span>
              </span>
              <span className="relative mt-3 block px-4 text-xs font-semibold opacity-75">
                {acc.monthlyRoiPct}% · {acc.isMonthlyCycle ? 'Monthly Returns' : `${acc.cycleDays}-day Returns`}
              </span>
            </button>
          );
        })}
      </div>

      {/* Frosted panel the cards tuck under. Tapping it opens the portfolio, as the list card did. */}
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
        className="relative z-[20] cursor-pointer px-4 pb-4 pt-4 active:opacity-90"
        style={panelStyle}
        aria-live="polite"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-muted-foreground">Principal</p>
            <p className="mt-0.5 break-words font-mono text-2xl font-semibold leading-tight tabular-nums tracking-tight text-foreground">
              {formatUGX(a.deployed)}
            </p>
          </div>
          <span className="mt-1 grid h-9 w-9 flex-none place-items-center rounded-full bg-muted/80 text-muted-foreground">
            <ChevronRight className="h-4 w-4" />
          </span>
        </div>

        {isActive && (
          <div className="mt-3">
            <div className="flex items-baseline justify-between gap-2 text-xs">
              <span className="text-muted-foreground">
                Earned <span className="font-mono font-semibold tabular-nums text-success">+{formatUGX(Math.round(a.cycleAccrued))}</span>
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
            <p className="mt-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
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
