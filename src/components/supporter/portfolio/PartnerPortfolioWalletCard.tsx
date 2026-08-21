import { useMemo, useState } from 'react';
import { Calculator, Eye, EyeOff, Menu, Plus, Users, Wallet } from 'lucide-react';
import { usePartnerPortfolios } from '@/hooks/usePartnerPortfolios';
import { computeAccrual, normalizePortfolioState } from '@/lib/portfolioAccrual';
import { formatUGX } from '@/lib/rentCalculations';
import { generateWelileAiId } from '@/lib/welileAiId';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useSupportedTenants } from '@/hooks/useSupportedTenants';
const welileLogo = '/welile-colored.png';

// Taller card (354x200) to give the Add Card button more room on mobile.
const NOTCH_PATH =
  'M 20,0 L 334,0 A 20,20 0 0 1 354,20 L 354,154 A 8,8 0 0 1 346,162 L 241,162 A 8,8 0 0 0 233,170 L 233,180 A 20,20 0 0 1 213,200 L 20,200 A 20,20 0 0 1 0,180 L 0,20 A 20,20 0 0 1 20,0 Z';

interface Props {
  onAddCard?: () => void;
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
export function PartnerPortfolioWalletCard({ onAddCard, onPortfolios, onCalculator, onMore }: Props) {
  const { user } = useAuth();
  const { profile } = useProfile();
  const { portfolios, loading } = usePartnerPortfolios();
  const { tenants, isLoading: tenantsLoading } = useSupportedTenants();
  const [showAmount, setShowAmount] = useState(true);

  const active = useMemo(
    // Locked portfolios (open redemption) stop accruing but the capital is still
    // deployed, so it stays visible in the card total.
    () => portfolios.filter(p => {
      const s = normalizePortfolioState(p.status);
      return s === 'active' || s === 'locked';
    }),
    [portfolios]
  );

  const directTenantCount = useMemo(
    () => tenants.filter((t) => t.funding_mode === 'self_managed').length,
    [tenants]
  );

  const activePortfolioCount = useMemo(() => active.length, [active]);

  const supportingCount = useMemo(
    () => directTenantCount + activePortfolioCount,
    [directTenantCount, activePortfolioCount]
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

  if (loading || tenantsLoading) {
    return <div className="w-full aspect-[354/200] min-h-[180px] max-h-[280px] rounded-[20px] bg-muted animate-pulse" />;
  }

  return (
    <div className="w-full space-y-3">
      {/* CARD */}
      <div
        className="relative w-full aspect-[354/200] min-h-[180px] max-h-[280px] mx-auto"
        style={{
          filter: 'drop-shadow(0px 8px 22px rgba(99, 26, 186, 0.30))',
          containerType: 'inline-size',
        }}
      >
        <svg
          className="absolute inset-0 w-full h-full"
          viewBox="0 0 354 200"
          preserveAspectRatio="none"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <defs>
            <linearGradient id="welilePurpleCardGrad" x1="0" y1="0" x2="354" y2="200" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#7321d4" />
              <stop offset="45%" stopColor="#631aba" />
              <stop offset="85%" stopColor="#6219bb" />
              <stop offset="100%" stopColor="#500fa3" />
            </linearGradient>
          </defs>
          <path d={NOTCH_PATH} fill="url(#welilePurpleCardGrad)" stroke="rgba(255,255,255,0.45)" strokeWidth="8" strokeLinejoin="round" />
        </svg>

        {/* CONTENT */}
        <div
          className="relative z-10 w-full h-full flex flex-col justify-between text-white select-none"
          style={{ padding: 'min(12px, 3.4cqw) min(16px, 4.5cqw) min(18px, 5.1cqw)' }}
        >
          <div className="flex items-center justify-between" style={{ paddingTop: 4 }}>
            <img
              src={welileLogo}
              alt="Welile"
              className="w-auto brightness-0 invert object-contain block"
              style={{ height: 'clamp(16px, 4cqw, 24px)' }}
            />
            <span
              className="font-medium tracking-widest text-white/80 uppercase whitespace-nowrap"
              style={{ fontSize: 'clamp(9px, 2.2cqw, 14px)', paddingRight: 'min(0.5cqw, 4px)' }}
            >
              {aiId}
            </span>
          </div>

          <div className="flex items-end justify-between gap-2" style={{ marginTop: 'min(-0.5cqw, -2px)' }}>
            <div className="flex flex-col min-w-0">
              <div
                className="flex items-center gap-1.5"
                style={{ marginBottom: 'min(0.6cqw, 4px)' }}
              >
                <span
                  className="font-medium tracking-wider text-white/70 uppercase whitespace-nowrap"
                  style={{ fontSize: 'clamp(8px, 2.25cqw, 13px)' }}
                >
                  ACTIVE RENT PRINCIPAL
                </span>
                <button
                  type="button"
                  onClick={() => setShowAmount((s) => !s)}
                  aria-label={showAmount ? 'Hide amount' : 'Show amount'}
                  aria-pressed={showAmount}
                  className="shrink-0 rounded p-0.5 text-white/70 hover:text-white hover:bg-white/10 transition"
                >
                  {showAmount ? (
                    <EyeOff style={{ width: 'clamp(12px, 3cqw, 18px)', height: 'clamp(12px, 3cqw, 18px)' }} />
                  ) : (
                    <Eye style={{ width: 'clamp(12px, 3cqw, 18px)', height: 'clamp(12px, 3cqw, 18px)' }} />
                  )}
                </button>
              </div>
              <div
                className="font-black text-white tracking-tight leading-none whitespace-nowrap"
                style={{
                  fontSize: 'clamp(20px, 6.8cqw, 40px)',
                  fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro", "Segoe UI", Roboto, sans-serif',
                }}
              >
                {showAmount ? formatUGX(totalPrincipal) : 'UGX ••••••'}
              </div>
            </div>
            <div className="flex flex-col items-end shrink-0" style={{ paddingRight: 'min(0.5cqw, 4px)' }}>
              <span
                className="font-medium tracking-wider text-white/70 uppercase text-right whitespace-nowrap"
                style={{ fontSize: 'clamp(8px, 2.25cqw, 13px)', marginBottom: 'min(0.6cqw, 4px)' }}
              >
                NEXT PAYOUT
              </span>
              <div
                className="font-bold text-white/90 leading-none whitespace-nowrap"
                style={{ fontSize: 'clamp(11px, 2.9cqw, 17px)' }}
              >
                {payoutLabel}
              </div>
            </div>
          </div>

          <div className="flex items-end justify-between gap-2" style={{ marginTop: 'clamp(16px, 5cqw, 26px)' }}>
            <div className="flex flex-col min-w-0">
              <span
                className="font-medium tracking-wider text-white/70 uppercase whitespace-nowrap"
                style={{ fontSize: 'clamp(8px, 2cqw, 12px)', marginBottom: 'min(0.4cqw, 3px)' }}
              >
                PARTNER NAME
              </span>
              <span
                className="font-bold tracking-wide text-white uppercase truncate whitespace-nowrap"
                style={{ fontSize: 'clamp(11px, 2.9cqw, 17px)' }}
              >
                {name || '—'}
              </span>
            </div>
          </div>
        </div>

        {/* ADD CARD PILL — spans the full notch shelf (x 233→354, y 162→200 of the SVG),
            so it stretches to the notch's left edge on every viewport. */}
        <button
          type="button"
          onClick={onAddCard}
          aria-label="Support"
          
          className="absolute z-20 bg-black hover:bg-neutral-900 rounded-full flex items-center justify-center border border-white/10 shadow-lg transition active:scale-95"
          style={{
            left: '66.2%',
            right: 0,
            top: 'calc(81% + 4px)',
            height: 'calc(19% - 7px)',
            minHeight: '26px',
            gap: 'clamp(4px, 1.4cqw, 8px)',
            paddingInline: 'clamp(6px, 2cqw, 14px)',
          }}
        >
          <span
            className="rounded-full bg-white flex items-center justify-center shrink-0"
            style={{ width: 'clamp(15px, 4.6cqw, 26px)', height: 'clamp(15px, 4.6cqw, 26px)' }}
          >
            <Plus className="text-black" strokeWidth={3.5} style={{ width: 'clamp(9px, 2.8cqw, 16px)', height: 'clamp(9px, 2.8cqw, 16px)' }} />
          </span>
          <span
            className="tracking-tight text-white font-bold whitespace-nowrap"
            style={{ fontSize: 'clamp(9.5px, 2.8cqw, 15px)' }}
          >
            Support
          </span>
        </button>
      </div>

      {/* ACTION ROW */}
      <div className="bg-muted/70 backdrop-blur rounded-2xl p-2.5 shadow-md border border-border/70 flex items-center justify-around">
        <ActionButton label="Portfolios" onClick={onPortfolios} icon={<Wallet className="w-4 h-4" />} />
        <ActionButton label="Calculator" onClick={onCalculator} icon={<Calculator className="w-4 h-4" />} />
        <ActionButton
          label="Supporting"
          onClick={() => document.getElementById('supported-tenants')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          icon={<Users className="w-4 h-4" />}
          badge={supportingCount}
        />
        <ActionButton label="More" onClick={onMore} icon={<Menu className="w-4 h-4" />} />
      </div>
    </div>
  );
}
