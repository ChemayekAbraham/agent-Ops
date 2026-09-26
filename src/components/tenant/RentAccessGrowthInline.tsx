import { TrendingUp } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { useRentAccessLimitParams } from '@/hooks/useRentAccessLimitParams';
import {
  useRentAccessPromoTracking,
  type RentAccessPromoSurface,
} from '@/hooks/useRentAccessPromoTracking';

interface RentAccessGrowthInlineProps {
  /** 'onPrimary' for use inside primary-gradient cards, 'default' otherwise */
  variant?: 'default' | 'onPrimary';
  className?: string;
  /** Which payment screen this instance appears on (analytics) */
  surface: RentAccessPromoSurface;
}

/**
 * Compact rent-access growth message shown on tenant payment screens so the
 * tenant sees, at the moment of paying, that daily payments grow their rent
 * access up to the configured maximum. Figures come live from system settings.
 */
export function RentAccessGrowthInline({ variant = 'default', className = '' }: RentAccessGrowthInlineProps) {
  const { params } = useRentAccessLimitParams();

  const wrapper =
    variant === 'onPrimary'
      ? 'bg-white/15 text-primary-foreground'
      : 'bg-primary/10 text-primary border border-primary/20';

  return (
    <div className={`flex items-start gap-2 rounded-lg px-3 py-2 ${wrapper} ${className}`}>
      <TrendingUp className="h-4 w-4 mt-0.5 shrink-0" />
      <p className="text-xs leading-snug font-medium">
        Every day you pay adds <span className="font-bold">+{formatUGX(params.paid_increment_ugx)}</span> to your
        rent access — keep paying daily and grow it up to{' '}
        <span className="font-bold">{formatUGX(params.max_limit_ugx)}</span>.
      </p>
    </div>
  );
}

export default RentAccessGrowthInline;
