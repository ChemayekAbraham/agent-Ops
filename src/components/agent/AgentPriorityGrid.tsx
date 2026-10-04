import { ArrowRight, UserPlus, Home as HomeIcon, Sparkles } from 'lucide-react';
import { useProfile } from '@/hooks/useProfile';
import { formatUGX } from '@/lib/rentCalculations';
import { hapticTap } from '@/lib/haptics';
import { cn } from '@/lib/utils';

/**
 * Agent dashboard priority grid — 3 large, finger-friendly tiles.
 *
 * The three priorities an ordinary agent should reach instantly, in plain words:
 *   1. Collect Rent  — record cash collected today (live total)
 *   2. Add Tenant    — start a rent request
 *   3. List House    — register an empty house and earn a bonus
 *
 * Designed for low-end Android browsers: 1.5x icon size, ≥80px tap target,
 * minimal text, plain language. Collect Rent uses local IndexedDB so it works offline.
 */

interface Props {
  agentId: string;
  onOpenNewTenant: () => void;
  onOpenListHouse: () => void;
  /**
   * Merchant Agents are payout-only: hide Collect Rent / Add Tenant / List House.
   */
  restricted?: boolean;
}

export function AgentPriorityGrid({ onOpenNewTenant, onOpenListHouse, restricted = false }: Props) {
  useProfile(); // keep hook to preserve profile prefetch behaviour

  return (
    <div className="grid grid-cols-2 gap-2.5">
      {/* 3. Add Tenant — rent request (hidden for Merchant Agents) */}
      {!restricted && (
      <PriorityTile
        onClick={() => { hapticTap(); onOpenNewTenant(); }}
        icon={<UserPlus className="h-6 w-6" strokeWidth={2.2} />}
        iconBg="bg-emerald-600 text-white"
        label="Add Tenant"
        valueLabel="UGX 10,000"
        sub="On landlord float disbursed"
      />
      )}

      {/* 4. List House — open empty house listing flow (hidden for Merchant Agents) */}
      {!restricted && (
      <PriorityTile
        onClick={() => { hapticTap(); onOpenListHouse(); }}
        icon={
          <div className="relative">
            <HomeIcon className="h-6 w-6" strokeWidth={2.2} />
            <Sparkles className="h-3 w-3 text-amber-300 absolute -top-1 -right-1" />
          </div>
        }
        iconBg="bg-amber-500 text-white"
        label="List House"
        valueLabel={formatUGX(2000)}
        sub="Landlord + LC1 bonus"
        ariaLabel="List an empty house — earn up to UGX 2,000 when you register the landlord and LC1 chairperson"
        title="List an empty house"
        highlight
      />
      )}
    </div>
  );
}

/* ───────── Tile ───────── */

function PriorityTile({
  onClick,
  icon,
  iconBg,
  label,
  valueLabel,
  sub,
  statusIcon,
  ariaLabel,
  title,
  highlight,
}: {
  onClick: () => void;
  icon: React.ReactNode;
  iconBg: string;
  label: string;
  valueLabel: string;
  sub?: string;
  statusIcon?: React.ReactNode;
  ariaLabel?: string;
  title?: string;
  highlight?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={ariaLabel ?? `${label}: ${valueLabel}${sub ? ` — ${sub}` : ''}`}
      title={title ?? label}
      className={cn(
        'flex flex-col items-start gap-2 p-4 rounded-2xl border active:scale-[0.97] transition-all min-h-[112px] text-left touch-manipulation focus:outline-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:border-primary',
        highlight
          ? 'bg-amber-500/10 border-amber-500/40 hover:border-amber-500/60 hover:bg-amber-500/15'
          : 'bg-card border-border/60 active:bg-accent/40 hover:border-border'
      )}
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <div className="flex items-center justify-between w-full">
        <div className={cn('h-11 w-11 rounded-xl flex items-center justify-center shadow-sm shrink-0', iconBg)}>
          {icon}
        </div>
        <ArrowRight className={cn('h-3.5 w-3.5', highlight ? 'text-amber-600' : 'text-muted-foreground/60')} />
      </div>
      <div className="min-w-0 w-full">
        <p className={cn('text-[10px] uppercase tracking-wide font-medium', highlight ? 'text-amber-700 dark:text-white' : 'text-muted-foreground dark:text-white')}>
          {label}
        </p>
        <p className={cn('text-base font-bold tabular-nums leading-tight tracking-tight truncate mt-0.5', highlight ? 'text-amber-900 dark:text-white' : 'dark:text-white')}>
          {valueLabel}
        </p>
        {(sub || statusIcon) && (
          <p className="inline-flex items-center gap-1 text-[11px] mt-0.5 truncate">
            {statusIcon}
            <span className={cn('truncate', highlight ? 'text-amber-700/80' : 'text-muted-foreground')}>{sub}</span>
          </p>
        )}
      </div>
    </button>
  );
}

export default AgentPriorityGrid;