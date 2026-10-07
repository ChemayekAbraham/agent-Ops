import { motion, useReducedMotion } from 'framer-motion';
import { cn } from '@/lib/utils';
import type { EliteTier } from '@/hooks/useEliteRanks';

export const ELITE_TIER_COLORS: Record<EliteTier, { label: string; from: string; to: string; ring: string; glow: string }> = {
  diamond: { label: 'Diamond', from: '#22D3EE', to: '#8B5CF6', ring: 'conic-gradient(from 0deg, #22D3EE, #8B5CF6, #22D3EE)', glow: 'rgba(139,92,246,0.45)' },
  platinum: { label: 'Platinum', from: '#E2E8F0', to: '#64748B', ring: 'conic-gradient(from 0deg, #CBD5E1, #64748B, #93A3C0, #CBD5E1)', glow: 'rgba(100,116,139,0.45)' },
  gold: { label: 'Gold', from: '#FDE047', to: '#D97706', ring: 'conic-gradient(from 0deg, #FDE047, #D97706, #FBBF24, #FDE047)', glow: 'rgba(217,119,6,0.45)' },
  silver: { label: 'Silver', from: '#F1F5F9', to: '#94A3B8', ring: 'conic-gradient(from 0deg, #F1F5F9, #94A3B8, #E2E8F0, #F1F5F9)', glow: 'rgba(148,163,184,0.45)' },
};

const GEM_PX = { xs: 10, sm: 14, md: 18, lg: 26 } as const;

export function EliteGem({ tier, size = 'sm' }: { tier: EliteTier; size?: keyof typeof GEM_PX }) {
  const reduce = useReducedMotion();
  const c = ELITE_TIER_COLORS[tier];
  const px = GEM_PX[size];
  return (
    <span
      aria-hidden
      className="relative inline-block shrink-0 overflow-hidden"
      style={{
        width: px, height: px,
        clipPath: 'polygon(50% 0%, 100% 38%, 50% 100%, 0% 38%)',
        background: `linear-gradient(135deg, ${c.from}, ${c.to})`,
      }}
    >
      <span className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.55) 0 38%, transparent 38%)', clipPath: 'polygon(0 38%, 50% 0, 100% 38%)' }} />
      <span className="absolute inset-0" style={{ background: 'linear-gradient(90deg, transparent 50%, rgba(0,0,0,0.18) 50%)' }} />
      {!reduce && (
        <motion.span
          className="absolute inset-y-0 w-1/2"
          style={{ background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.8), transparent)' }}
          initial={{ x: '-120%' }}
          animate={{ x: '220%' }}
          transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
        />
      )}
    </span>
  );
}

const SIZE = {
  sm: { gem: 'xs' as const, text: 'text-[10px]', pad: 'px-1.5 py-0.5 gap-1' },
  md: { gem: 'sm' as const, text: 'text-xs', pad: 'px-2 py-0.5 gap-1.5' },
  lg: { gem: 'md' as const, text: 'text-sm', pad: 'px-3 py-1 gap-2' },
};

export function EliteRankBadge({ tier, size = 'md', className }: { tier: EliteTier; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const c = ELITE_TIER_COLORS[tier];
  const s = SIZE[size];
  return (
    <span
      className={cn('inline-flex items-center rounded-full border font-bold', s.pad, s.text, className)}
      style={{ borderColor: `${c.to}66`, background: `linear-gradient(135deg, ${c.from}22, ${c.to}22)`, color: tier === 'silver' || tier === 'platinum' ? '#475569' : c.to }}
      aria-label={`${c.label} rank`}
    >
      <EliteGem tier={tier} size={s.gem} />
      {c.label}
    </span>
  );
}
