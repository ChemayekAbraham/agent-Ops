import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Building2, Clock, Eye, EyeOff, RefreshCw } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';
import type { PortfolioRecord } from '@/hooks/useCapitalOpportunities';
import { computeAccrual } from '@/lib/portfolioAccrual';
import { usePendingTopup } from './ActivePortfolioCard';
import { useProfile } from '@/hooks/useProfile';
import { CardWaves, ContactlessGlyph, EmvChip, NOISE_BACKGROUND } from './PartnerPortfolioWalletCard';

/**
 * Fanned stack of the partner's portfolios, each drawn as a bank card (85.6 x 54 mm proportions).
 * The front card carries the principal, code, status, rate and next payout; this cycle's Returns
 * sit in the panel under the stack. Tap a card behind to bring it forward; tap the panel to open
 * the portfolio. Display only: it reads the same figures as the list card and moves no money.
 */

const PEEK = 52; // how much of each card behind shows above the one in front
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

/** "2026-11-14" -> "14/11", like the expiry printed on a card. */
function shortDate(value: string | null | undefined) {
  if (!value) return '--/--';
  const [, m, d] = String(value).slice(0, 10).split('-');
  return d && m ? `${d}/${m}` : '--/--';
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
}: {
  portfolios: PortfolioRecord[];
  /** No longer used: the pocket is display only. Kept so existing callers still type-check. */
  onView?: (portfolioId: string) => void;
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
  // Principal across every portfolio in the stack; each card shows its own when lifted out.
  const totalPrincipal = useMemo(
    () => portfolios.reduce((sum, p) => sum + (Number(p.investment_amount) || 0), 0),
    [portfolios],
  );

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

  // Tapping the front card lifts it out of the pocket so its whole face shows; tap again to tuck it back.
  const [expanded, setExpanded] = useState(false);
  // The holder's name is printed on each card, as on the gold Partner card.
  const { profile } = useProfile();
  const holderName = (profile?.full_name || '').trim().toUpperCase();
  // The total stays masked until the partner taps the eye, like the balance on the gold card.
  const [showTotal, setShowTotal] = useState(false);

  const frontId = order[order.length - 1];
  const front = frontId ? byId[frontId] : undefined;
  const pendingTopup = usePendingTopup(front?.id);
  if (!front) return null;

  const depth = order.length - 1;
  const a = accruals[front.id];
  const isActive = a.state === 'active';
  const progressPct = Math.round(a.cycleProgress * 100);
  const period = a.isMonthlyCycle ? 'Monthly Rent profit share' : `${a.cycleDays}-day Rent profit share`;
  const isCompounding = front.roi_mode === 'monthly_compounding' || front.auto_reinvest === true;
  const remaining = remainingLabel(a.daysToPayout);

  // The pocket rises over the lower 46% of the front card. The card is min(wrap - 32px, 420px) wide
  // at bank-card proportions, so its height is that width / 1.586.
  const pocketStyle: CSSProperties = {
    marginTop: expanded ? 12 : 'calc(min(100cqw - 32px, 420px) / 1.586 * -0.46)',
    transition: reduced ? 'none' : `margin-top 600ms ${SPRING}`,
    background: safe ? '#999894' : 'rgba(153,152,148,0.95)',
    borderTop: '1px solid rgba(255,255,255,0.08)',
    boxShadow: '0 -10px 24px -16px rgba(0,0,0,0.35)',
    ...(safe ? {} : { backdropFilter: 'blur(18px) saturate(1.3)', WebkitBackdropFilter: 'blur(18px) saturate(1.3)' }),
  };

  return (
    <div className="overflow-hidden rounded-3xl border border-border/60" style={{ containerType: 'inline-size', background: '#d9d8d4' }}>
      {/* The stack. Pointer position drives the shimmer on every card. */}
      <div
        ref={stackRef}
        className="px-4 pt-4"
        style={{ '--glare': 30 } as CSSProperties}
        onPointerMove={(e) => {
          if (reduced || safe) return;
          const r = e.currentTarget.getBoundingClientRect();
          pointerActive.current = true;
          e.currentTarget.style.setProperty('--glare', String(((e.clientX - r.left) / r.width) * 100));
        }}
        onPointerLeave={() => { pointerActive.current = false; }}
      >
        <div className="mx-auto w-full max-w-[420px]" style={{ paddingTop: depth * PEEK }}>
          <div className="relative aspect-[1.586] w-full">
            {order.map((id, pos) => {
              const p = byId[id];
              const acc = accruals[id];
              const pal = paletteOf[id];
              const fromFront = depth - pos; // 0 = front
              const isFront = fromFront === 0;
              const ref = p.portfolio_code || p.account_name || 'Portfolio';
              // A portfolio can be named for the person it is held for (e.g. HASIFA); that name leads the card.
              const accountName = (p.account_name || '').trim();
              const cardHolder = (accountName || holderName).toUpperCase();
              const status = STATE_LABEL[acc.state] ?? acc.state;
              const returnsLabel = acc.isMonthlyCycle ? 'monthly' : `per ${acc.cycleDays} days`;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    hapticTap();
                    if (isFront) {
                      setExpanded((e) => !e);
                      return;
                    }
                    // A card from behind comes forward already lifted out of the pocket.
                    setOrder((o) => [...o.filter((x) => x !== id), id]);
                    setExpanded(true);
                  }}
                  aria-label={`${accountName ? `${accountName}, ` : ''}${ref}, ${status}, principal ${formatUGX(acc.deployed)}${isFront ? (expanded ? ', tap to put back' : ', tap to show the whole card') : ', bring to front'}`}
                  aria-pressed={isFront}
                  aria-expanded={isFront ? expanded : undefined}
                  className="absolute inset-x-0 block h-full rounded-[18px] p-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{
                    top: -fromFront * PEEK,
                    zIndex: pos + 1,
                    transform: `scale(${1 - fromFront * 0.05}) translateY(${mounted ? (isFront && expanded ? -4 : 0) : 20}px)`,
                    transformOrigin: 'top center',
                    opacity: mounted ? 1 : 0,
                    color: pal.ink,
                    containerType: 'inline-size',
                    boxShadow: isFront
                      ? expanded
                        ? '0 4px 8px rgba(0,0,0,0.12), 0 24px 40px -16px rgba(0,0,0,0.45)'
                        : '0 2px 4px rgba(0,0,0,0.10), 0 14px 28px -12px rgba(0,0,0,0.35)'
                      : '0 -8px 22px -14px rgba(0,0,0,0.6)',
                    cursor: 'pointer',
                    transition: reduced
                      ? 'none'
                      : `top 650ms ${SPRING}, transform 650ms ${SPRING}, box-shadow 500ms ease, opacity 500ms ease ${pos * 90}ms`,
                  } as CSSProperties}
                >
                  {/* card face: gloss, corner glow, colour gradient and printed grain */}
                  <span
                    aria-hidden
                    className="absolute inset-0 overflow-hidden rounded-[18px]"
                    style={{
                      backgroundImage: [
                        'linear-gradient(180deg, rgba(255,255,255,0.3) 0%, transparent 34%)',
                        `radial-gradient(110% 90% at 100% 0%, ${pal.to} 0%, transparent 60%)`,
                        `linear-gradient(135deg, ${pal.from} 0%, ${pal.to} 100%)`,
                      ].join(', '),
                      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.5), inset 0 0 0 1px rgba(255,255,255,0.16)',
                    }}
                  >
                    <span className="absolute inset-0 opacity-[0.12] mix-blend-overlay" style={{ backgroundImage: NOISE_BACKGROUND }} />
                    {/* engraved ribbons, as on the gold Partner card, in white so each card keeps its colour */}
                    <CardWaves stroke="rgba(255,255,255,0.5)" fill="rgba(255,255,255,0.10)" />
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

                  <span
                    className="relative flex h-full flex-col"
                    style={{ padding: 'clamp(12px, 5cqw, 22px) clamp(14px, 5.5cqw, 24px)' }}
                  >
                    {/* top line: what it is, its code, its state. This is the strip that shows on cards behind. */}
                    <span className="flex items-start justify-between gap-3">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="grid h-7 w-7 flex-none place-items-center rounded-full" style={{ background: 'rgba(255,255,255,0.35)' }}>
                          <Building2 className="h-4 w-4" />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate text-[10px] font-semibold uppercase leading-none tracking-[0.12em] opacity-70">
                            Tenant capital · {acc.monthlyRoiPct}% {returnsLabel}
                          </span>
                          <span className="flex min-w-0 items-baseline gap-1.5 leading-tight">
                            {accountName ? (
                              <>
                                <span className="truncate text-[13px] font-bold tracking-wide">{accountName.toUpperCase()}</span>
                                {p.portfolio_code && (
                                  <span className="shrink-0 font-mono text-[10px] font-semibold opacity-70">{p.portfolio_code}</span>
                                )}
                              </>
                            ) : (
                              <span className="truncate text-[13px] font-bold tracking-wide">{ref}</span>
                            )}
                          </span>
                        </span>
                      </span>
                      <span className="flex flex-none items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.08em]">
                        <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden />
                        {status}
                      </span>
                    </span>

                    {/* chip row, with the next payout where a card prints its expiry */}
                    <span className="mt-[4cqw] flex items-center justify-between gap-3">
                      <span className="flex items-center gap-2">
                        <EmvChip />
                        <ContactlessGlyph className="opacity-70" />
                      </span>
                      <span className="flex-none text-right">
                        <span className="block text-[9px] font-semibold uppercase tracking-[0.14em] opacity-65">Next payout</span>
                        <span className="block font-mono text-[13px] font-semibold tabular-nums">{shortDate(p.next_roi_date)}</span>
                      </span>
                    </span>

                    {/* lower half: only seen once the card is lifted out of the pocket */}
                    {isFront && (
                      <span
                        className="mt-auto block"
                        style={{
                          opacity: expanded ? 1 : 0,
                          transition: reduced ? 'none' : `opacity 400ms ease ${expanded ? 180 : 0}ms`,
                        }}
                        aria-hidden={!expanded}
                      >
                        <span className="block text-[10px] font-semibold uppercase tracking-[0.14em] opacity-70">Principal</span>
                        <span
                          className="block truncate font-mono font-semibold tabular-nums tracking-tight"
                          style={{ fontSize: 'clamp(20px, 7.4cqw, 32px)', lineHeight: 1.1 }}
                        >
                          {formatUGX(acc.deployed)}
                        </span>
                        {/* holder's name bottom-left, as a bank card prints it */}
                        <span className="mt-[2cqw] flex items-end justify-between gap-3">
                          <span className="min-w-0">
                            <span className="block text-[9px] font-semibold uppercase tracking-[0.14em] opacity-65">
                              {accountName ? 'Account holder' : 'Partner name'}
                            </span>
                            <span className="block truncate text-[13px] font-semibold tracking-[0.06em]">{cardHolder || '—'}</span>
                          </span>
                          {acc.state === 'active' && (
                            <span className="flex-none text-right">
                              <span className="block text-[9px] font-semibold uppercase tracking-[0.14em] opacity-65">Earned this cycle</span>
                              <span className="block font-mono text-[13px] font-semibold tabular-nums">+{formatUGX(Math.round(acc.cycleAccrued))}</span>
                            </span>
                          )}
                        </span>
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* The wallet pocket the cards sit in: it covers the lower part of the front card.
          Display only; "View all portfolios" below is the way into the portfolios. */}
      <div
        className="relative z-[20] px-4 pb-4 pt-4"
        style={pocketStyle}
        aria-live="polite"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs font-medium text-white/90">
              Your active portfolios
              <button
                type="button"
                onClick={() => { hapticTap(); setShowTotal((v) => !v); }}
                aria-label={showTotal ? 'Hide total' : 'Show total'}
                aria-pressed={showTotal}
                className="-m-1 rounded-full p-1 text-white/90 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showTotal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </p>
            <p className="mt-0.5 break-words font-mono text-2xl font-semibold leading-tight tabular-nums tracking-tight text-white">
              {showTotal ? formatUGX(totalPrincipal) : 'UGX ••••••'}
            </p>
          </div>
        </div>

        {isActive && (
          <div>
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="text-white/90">
                Earned this cycle <span className="font-mono font-semibold tabular-nums text-green-200">+{formatUGX(Math.round(a.cycleAccrued))}</span>
              </span>
              {remaining && <span className="font-medium text-white">{remaining}</span>}
            </div>
            <div
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-white/15"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progressPct}
              aria-label="Payout cycle progress"
            >
              <div className="h-full rounded-full bg-primary transition-all duration-1000" style={{ width: `${progressPct}%` }} />
            </div>
            <p className="mt-1.5 font-mono text-[11px] tabular-nums text-white/90">
              {formatUGX(Math.round(a.dailyAccrual))}/day · day {a.cycleElapsedDays}/{a.cycleDays} · {period}
            </p>
          </div>
        )}

        {(isCompounding || pendingTopup > 0) && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {isCompounding && (
              <span className="inline-flex items-center gap-1 rounded-full border border-white/20 px-2.5 py-0.5 text-[11px] font-medium text-violet-300">
                <RefreshCw className="h-3 w-3" />
                Compounding
              </span>
            )}
            {pendingTopup > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full border border-white/20 px-2.5 py-0.5 text-[11px] font-medium text-amber-300">
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
