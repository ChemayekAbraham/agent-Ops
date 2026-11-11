import { useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AnimatePresence, motion, useMotionTemplate, useMotionValue, useReducedMotion, useSpring } from 'framer-motion';
import { Calculator, Eye, EyeOff } from 'lucide-react';
import { usePartnerPortfolios } from '@/hooks/usePartnerPortfolios';
import { computeAccrual, normalizePortfolioState } from '@/lib/portfolioAccrual';
import { formatUGX } from '@/lib/rentCalculations';
import { generateWelileAiId } from '@/lib/welileAiId';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { cn } from '@/lib/utils';
import { useAvailableBalance } from '@/hooks/useAvailableBalance';
const welileLogo = '/welile-colored.png';

// Fine grain: real cards are printed, and a flat gradient is what makes a card look like a CSS box.
export const NOISE_BACKGROUND =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)'/%3E%3C/svg%3E\")";

const SHEEN_HOME = { x: 28, y: 18 };
const SHEEN_SPRING = { damping: 26, mass: 0.4, stiffness: 140 };
const TILT_SPRING = { damping: 22, mass: 0.5, stiffness: 160 };
const MASK_LENGTH = 6;
const BLUR = 6;
const CHAR_STAGGER = 0.018;

/** The app's low-power mode for phones that struggle with blend and blur effects. */
const isSafeMode = () =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('android-compositor-safe');

// Fine flowing lines in two bands, like the engraved waves on a gold card. Drawn once, scaled to the card.
const WAVE_UPPER = Array.from({ length: 9 }, (_, i) => `M ${160 + i * 7} -10 C ${215 + i * 5} 72, ${310 - i * 4} 38, 432 ${64 + i * 6}`);
const WAVE_LOWER = Array.from({ length: 9 }, (_, i) => `M -10 ${214 + i * 6} C 118 ${172 + i * 4}, 252 ${252 - i * 3}, 432 ${188 + i * 7}`);

/** Engraved wave ribbons in two bands. The gold card uses a cream tint; other cards pass their own. */
export function CardWaves({
  stroke = 'rgba(255,246,222,0.55)',
  fill = 'rgba(255,244,214,0.10)',
}: { stroke?: string; fill?: string }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 420 265" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full" fill="none">
      {/* two soft satin sweeps */}
      <path d="M0 196 C 120 150, 262 252, 420 170 L420 265 L0 265 Z" fill={fill} />
      <path d="M150 0 C 220 80, 330 30, 420 90 L420 0 Z" fill={fill} />
      <g stroke={stroke} strokeWidth="0.8" strokeLinecap="round">
        {WAVE_UPPER.map((d) => <path key={d} d={d} />)}
        {WAVE_LOWER.map((d) => <path key={d} d={d} />)}
      </g>
    </svg>
  );
}

function GoldWaves() {
  return <CardWaves />;
}

/** EMV chip, contact grid and all. */
export function EmvChip() {
  const gradientId = useId();
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 34 26"
      fill="none"
      className="shrink-0"
      style={{ height: 'clamp(18px, 5.6cqw, 28px)', width: 'auto', aspectRatio: '34 / 26' }}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#f7e8b0" />
          <stop offset="45%" stopColor="#dbb54c" />
          <stop offset="100%" stopColor="#a47a1c" />
        </linearGradient>
      </defs>
      <rect x="0.5" y="0.5" width="33" height="25" rx="4.5" fill={`url(#${gradientId})`} stroke="rgba(70,45,5,0.35)" />
      <g stroke="rgba(70,45,5,0.45)" strokeWidth="1">
        <path d="M0 8.5H11" /><path d="M0 17.5H11" /><path d="M23 8.5H34" /><path d="M23 17.5H34" />
        <path d="M11 3.5V22.5" /><path d="M23 3.5V22.5" /><path d="M11 13H23" />
      </g>
    </svg>
  );
}

/** Contactless payment glyph: three nested arcs. */
export function ContactlessGlyph({ className = 'text-black/70' }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth="1.7"
      className={cn('shrink-0', className)}
      style={{ width: 'clamp(13px, 4.2cqw, 20px)', height: 'clamp(13px, 4.2cqw, 20px)' }}
    >
      <path d="M5.5 9.4a5.4 5.4 0 0 1 0 5.2" />
      <path d="M9.2 7a9.4 9.4 0 0 1 0 10" />
      <path d="M12.9 4.7a13.4 13.4 0 0 1 0 14.6" />
    </svg>
  );
}

/** The amount, one character at a time: it blurs out when hidden and sharpens in when shown. */
function BalanceDisplay({ amount, hidden, reduced }: { amount: string; hidden: boolean; reduced: boolean }) {
  const symbol = amount.split(/\s/)[0] || 'UGX';
  const characters = hidden
    ? [...symbol.split(''), ' ', ...Array.from({ length: MASK_LENGTH }, () => '•')]
    : amount.split('');
  return (
    <span aria-label={hidden ? 'Amount hidden' : amount} className="flex">
      <AnimatePresence initial={false} mode="popLayout">
        {characters.map((char, index) => (
          <motion.span
            key={`${hidden}-${index}-${char}`}
            aria-hidden="true"
            className="inline-block"
            initial={reduced ? { opacity: 1 } : { filter: `blur(${BLUR}px)`, opacity: 0 }}
            animate={{ filter: 'blur(0px)', opacity: 1 }}
            exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { filter: `blur(${BLUR}px)`, opacity: 0 }}
            transition={reduced ? { duration: 0 } : { type: 'spring', bounce: 0.1, duration: 0.25, delay: index * CHAR_STAGGER }}
          >
            {char === ' ' ? '\u00A0' : char}
          </motion.span>
        ))}
      </AnimatePresence>
    </span>
  );
}

interface Props {
  onPortfolios?: () => void;
  onCalculator?: () => void;
  onMore?: () => void;
}

function ActionButton({
  label,
  icon,
  badge,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  badge?: number;
  onClick?: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="group flex flex-col items-center gap-1">
      <span className="relative w-9 h-9 sm:w-10 sm:h-10 rounded-full bg-card flex items-center justify-center text-foreground/80 shadow-sm border border-border/60 transition-colors group-hover:bg-primary/10 group-hover:text-primary">
        {icon}
        {typeof badge === 'number' && badge > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-primary text-white text-[10px] font-bold flex items-center justify-center border-2 border-background">
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </span>
      <span className="text-[10px] sm:text-[11px] font-semibold text-foreground/80">{label}</span>
    </button>
  );
}

/**
 * Premium bank-card style summary of the partner's deployed capital.
 * Additive card — does not replace the wallet hero card.
 */
export function PartnerPortfolioWalletCard({ onCalculator, onMore }: Props) {
  const { user } = useAuth();
  const { profile } = useProfile();
  const { portfolios, loading } = usePartnerPortfolios();
  const { available: availableBalance, refresh: refreshAvailable } = useAvailableBalance(user?.id);
  const [showAmount, setShowAmount] = useState(false);

  // The pointer drives a highlight and a slight tilt. All of it is written to motion values,
  // so moving over the card never re-renders it.
  const reduced = Boolean(useReducedMotion());
  const safe = useMemo(isSafeMode, []);
  const cardRef = useRef<HTMLDivElement>(null);
  const pointerActive = useRef(false);
  const hoverCapable = useRef(false);
  const px = useMotionValue(SHEEN_HOME.x);
  const py = useMotionValue(SHEEN_HOME.y);
  const sheenX = useSpring(px, SHEEN_SPRING);
  const sheenY = useSpring(py, SHEEN_SPRING);
  const sheen = useMotionTemplate`radial-gradient(120% 90% at ${sheenX}% ${sheenY}%, rgba(255,255,255,0.32), rgba(255,255,255,0.06) 45%, transparent 72%)`;
  const tiltX = useSpring(useMotionValue(0), TILT_SPRING);
  const tiltY = useSpring(useMotionValue(0), TILT_SPRING);

  useEffect(() => {
    const mq = window.matchMedia('(hover: hover) and (pointer: fine)');
    hoverCapable.current = mq.matches;
    const onChange = (e: MediaQueryListEvent) => { hoverCapable.current = e.matches; };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // With no pointer over it (a phone, say), the highlight drifts slowly so the card still looks alive.
  useEffect(() => {
    const el = cardRef.current;
    if (!el || reduced || safe) return;
    let visible = true;
    const io = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; });
    io.observe(el);
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!visible || document.hidden || pointerActive.current) return;
      px.set(SHEEN_HOME.x + Math.sin((now - t0) / 2800) * 28);
      py.set(SHEEN_HOME.y + Math.cos((now - t0) / 3400) * 14);
    };
    raf = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(raf); io.disconnect(); };
  }, [reduced, safe, px, py]);

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!hoverCapable.current || reduced || safe) return;
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    pointerActive.current = true;
    px.set(x * 100);
    py.set(y * 100);
    tiltY.set((x - 0.5) * 10);
    tiltX.set(-(y - 0.5) * 8);
  };
  const handlePointerLeave = () => {
    pointerActive.current = false;
    tiltX.set(0);
    tiltY.set(0);
  };

  const active = useMemo(
    // Locked portfolios (open redemption) stop accruing but the capital is still
    // deployed, so it stays visible in the card total.
    () => portfolios.filter(p => {
      const s = normalizePortfolioState(p.status);
      return s === 'active' || s === 'locked';
    }),
    [portfolios]
  );

  const totalPrincipal = useMemo(
    () => active.reduce((sum, p: any) => sum + Number(p.investment_amount || 0), 0),
    [active]
  );

  const nextPayout = useMemo(() => {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const dates = active
      .map(p => computeAccrual(p).nextPayoutDate)
      .filter((d): d is Date => !!d && d.getTime() >= today.getTime())
      .sort((a, b) => a.getTime() - b.getTime());
    return dates[0] ?? null;
  }, [active]);

  const payoutLabel = nextPayout
    ? `${String(nextPayout.getDate()).padStart(2, '0')}/${String(nextPayout.getMonth() + 1).padStart(2, '0')}`
    : '--/--';

  const aiId = user?.id ? generateWelileAiId(user.id) : '';
  const name = (profile?.full_name || '').trim().toUpperCase();

  if (loading) {
    return <div className="mx-auto aspect-[1.586] w-full max-w-[420px] rounded-[18px] bg-muted animate-pulse" />;
  }

  return (
    <div className="w-full space-y-3">
      {/* CARD: a real bank card's proportions (85.6 x 54 mm), rounded corners and edge light */}
      <motion.div
        ref={cardRef}
        className="relative mx-auto aspect-[1.586] w-full max-w-[420px] overflow-hidden rounded-[18px]"
        initial={reduced || safe ? false : { opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', bounce: 0.15, duration: 0.6 }}
        onPointerMove={handlePointerMove}
        onPointerLeave={handlePointerLeave}
        style={{
          backgroundImage: 'radial-gradient(90% 80% at 92% 55%, rgba(244,184,128,0.65), transparent 62%), linear-gradient(135deg, #b8913e 0%, #d4ae58 38%, #e1bd74 62%, #c79a45 100%)',
          boxShadow:
            '0 2px 4px rgba(0,0,0,0.10), 0 14px 28px -10px rgba(120,80,10,0.50), 0 34px 60px -24px rgba(120,80,10,0.42)',
          containerType: 'inline-size',
          transformPerspective: 900,
          rotateX: reduced || safe ? 0 : tiltX,
          rotateY: reduced || safe ? 0 : tiltY,
        }}
      >
        {/* soft light across the top, like the glossy lip of a card */}
        <span aria-hidden className="pointer-events-none absolute inset-0" style={{ backgroundImage: 'linear-gradient(180deg, rgba(255,255,255,0.22) 0%, transparent 34%)' }} />
        {/* engraved wave lines */}
        <GoldWaves />
        {/* printed grain */}
        <span aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.14] mix-blend-overlay" style={{ backgroundImage: NOISE_BACKGROUND }} />
        {/* highlight that follows the pointer */}
        {!safe && (
          <motion.span
            aria-hidden
            className="pointer-events-none absolute inset-0 mix-blend-soft-light"
            style={{ backgroundImage: sheen }}
          />
        )}
        {/* the card's edge: a bright inner rim and a bevelled top edge */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0 rounded-[18px]"
          style={{ boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.22), inset 0 1px 0 rgba(255,255,255,0.45), inset 0 -1px 0 rgba(0,0,0,0.25)' }}
        />

        {/* CONTENT */}
        <div
          className="relative z-10 flex h-full w-full select-none flex-col justify-between text-black"
          style={{ textShadow: '0 1px 0 rgba(255, 244, 214, 0.55)', padding: 'clamp(14px, 5.2cqw, 24px) clamp(16px, 5.6cqw, 26px)' }}
        >
          {/* the brand and the card type, then the chip */}
          <div className="flex items-start justify-between gap-3">
            <img
              src={welileLogo}
              alt="Welile"
              className="block w-auto object-contain brightness-0"
              style={{ height: 'clamp(16px, 4.6cqw, 26px)' }}
            />
            <span className="whitespace-nowrap font-medium uppercase tracking-[0.14em] text-black/90" style={{ fontSize: 'clamp(10px, 3.1cqw, 15px)' }}>
              Partner card
            </span>
          </div>
          <div className="flex items-center gap-2.5" aria-hidden="true">
            <EmvChip />
            <ContactlessGlyph />
          </div>

          {/* the amount */}
          <div className="flex min-w-0 flex-col">
            <div className="flex items-center gap-1.5" style={{ marginBottom: 'min(0.8cqw, 5px)' }}>
              <span className="whitespace-nowrap font-medium uppercase tracking-wider text-black/70" style={{ fontSize: 'clamp(8px, 2.3cqw, 12px)' }}>
                Active rent principal
              </span>
              <button
                type="button"
                onClick={() => setShowAmount((s) => !s)}
                aria-label={showAmount ? 'Hide amount' : 'Show amount'}
                aria-pressed={showAmount}
                className="shrink-0 rounded p-0.5 text-black/70 transition hover:bg-black/10 hover:text-black"
              >
                {showAmount ? (
                  <Eye style={{ width: 'clamp(12px, 3.2cqw, 18px)', height: 'clamp(12px, 3.2cqw, 18px)' }} />
                ) : (
                  <EyeOff style={{ width: 'clamp(12px, 3.2cqw, 18px)', height: 'clamp(12px, 3.2cqw, 18px)' }} />
                )}
              </button>
            </div>
            <div
              className="whitespace-nowrap font-semibold leading-none tracking-tight text-black tabular-nums"
              style={{
                fontSize: 'clamp(22px, 8.4cqw, 40px)',
                fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro", "Segoe UI", Roboto, sans-serif',
              }}
            >
              <BalanceDisplay amount={formatUGX(totalPrincipal)} hidden={!showAmount} reduced={reduced || safe} />
            </div>
          </div>

          {/* the member ID, printed where a card number would be */}
          <div className="whitespace-nowrap font-medium tabular-nums text-black/85" style={{ fontSize: 'clamp(12px, 4cqw, 19px)', letterSpacing: '0.16em' }}>
            {aiId || '—'}
          </div>

          {/* holder and the next payout, like holder and valid thru */}
          <div className="flex items-end justify-between gap-4">
            <div className="min-w-0">
              <span className="block uppercase tracking-[0.14em] text-black/55" style={{ fontSize: 'clamp(7px, 1.9cqw, 10px)' }}>
                Partner name
              </span>
              <span className="block truncate font-medium uppercase tracking-[0.05em] text-black/95" style={{ fontSize: 'clamp(11px, 3.2cqw, 16px)' }}>
                {name || '—'}
              </span>
            </div>
            <div className="shrink-0 text-right">
              <span className="block uppercase tracking-[0.14em] text-black/55" style={{ fontSize: 'clamp(7px, 1.9cqw, 10px)' }}>
                Next payout
              </span>
              <span className="block font-medium tabular-nums tracking-[0.05em] text-black/95" style={{ fontSize: 'clamp(11px, 3.2cqw, 16px)' }}>
                {payoutLabel}
              </span>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ACTION ROW */}
      <div className="bg-muted/70 backdrop-blur rounded-2xl p-2.5 shadow-md border border-border/70 flex items-center justify-around">
        <ActionButton label="Calculator" onClick={onCalculator} icon={<Calculator className="w-4 h-4" />} />
      </div>
    </div>
  );
}
