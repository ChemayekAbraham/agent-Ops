import { ReactNode } from 'react';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type CcTone = 'primary' | 'emerald' | 'amber' | 'rose' | 'violet' | 'sky' | 'slate';

const TONE_MAP: Record<CcTone, {
  ring: string;
  iconBg: string;
  iconText: string;
  valueText: string;
  pillBg: string;
  pillText: string;
  barBg: string;
  glow: string;
}> = {
  primary: {
    ring: 'border-primary/25 hover:border-primary/45',
    iconBg: 'bg-primary/12 text-primary ring-1 ring-primary/20',
    iconText: 'text-primary',
    valueText: 'text-foreground',
    pillBg: 'bg-primary/12 text-primary border-primary/25',
    pillText: 'text-primary',
    barBg: 'from-primary to-primary/60',
    glow: 'from-primary/10 via-primary/4 to-transparent',
  },
  emerald: {
    ring: 'border-emerald-500/25 hover:border-emerald-500/45',
    iconBg: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 ring-1 ring-emerald-500/25',
    iconText: 'text-emerald-600 dark:text-emerald-400',
    valueText: 'text-emerald-700 dark:text-emerald-300',
    pillBg: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300 border-emerald-500/30',
    pillText: 'text-emerald-700 dark:text-emerald-300',
    barBg: 'from-emerald-500 to-emerald-400',
    glow: 'from-emerald-500/10 via-emerald-500/4 to-transparent',
  },
  amber: {
    ring: 'border-amber-500/25 hover:border-amber-500/45',
    iconBg: 'bg-amber-500/12 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/25',
    iconText: 'text-amber-600 dark:text-amber-400',
    valueText: 'text-amber-700 dark:text-amber-300',
    pillBg: 'bg-amber-500/12 text-amber-700 dark:text-amber-300 border-amber-500/30',
    pillText: 'text-amber-700 dark:text-amber-300',
    barBg: 'from-amber-500 to-amber-400',
    glow: 'from-amber-500/10 via-amber-500/4 to-transparent',
  },
  rose: {
    ring: 'border-rose-500/25 hover:border-rose-500/45',
    iconBg: 'bg-rose-500/12 text-rose-600 dark:text-rose-400 ring-1 ring-rose-500/25',
    iconText: 'text-rose-600 dark:text-rose-400',
    valueText: 'text-rose-700 dark:text-rose-300',
    pillBg: 'bg-rose-500/12 text-rose-700 dark:text-rose-300 border-rose-500/30',
    pillText: 'text-rose-700 dark:text-rose-300',
    barBg: 'from-rose-500 to-rose-400',
    glow: 'from-rose-500/10 via-rose-500/4 to-transparent',
  },
  violet: {
    ring: 'border-violet-500/25 hover:border-violet-500/45',
    iconBg: 'bg-violet-500/12 text-violet-600 dark:text-violet-400 ring-1 ring-violet-500/25',
    iconText: 'text-violet-600 dark:text-violet-400',
    valueText: 'text-violet-700 dark:text-violet-300',
    pillBg: 'bg-violet-500/12 text-violet-700 dark:text-violet-300 border-violet-500/30',
    pillText: 'text-violet-700 dark:text-violet-300',
    barBg: 'from-violet-500 to-violet-400',
    glow: 'from-violet-500/10 via-violet-500/4 to-transparent',
  },
  sky: {
    ring: 'border-sky-500/25 hover:border-sky-500/45',
    iconBg: 'bg-sky-500/12 text-sky-600 dark:text-sky-400 ring-1 ring-sky-500/25',
    iconText: 'text-sky-600 dark:text-sky-400',
    valueText: 'text-sky-700 dark:text-sky-300',
    pillBg: 'bg-sky-500/12 text-sky-700 dark:text-sky-300 border-sky-500/30',
    pillText: 'text-sky-700 dark:text-sky-300',
    barBg: 'from-sky-500 to-sky-400',
    glow: 'from-sky-500/10 via-sky-500/4 to-transparent',
  },
  slate: {
    ring: 'border-border/70 hover:border-border',
    iconBg: 'bg-muted text-muted-foreground ring-1 ring-border/60',
    iconText: 'text-muted-foreground',
    valueText: 'text-foreground',
    pillBg: 'bg-muted text-muted-foreground border-border',
    pillText: 'text-muted-foreground',
    barBg: 'from-muted-foreground/60 to-muted-foreground/30',
    glow: 'from-muted/40 via-transparent to-transparent',
  },
};

export function CcKpiTile({
  label,
  value,
  sublabel,
  icon: Icon,
  tone = 'primary',
  progress,
  badge,
  onClick,
  active,
  className,
}: {
  label: string;
  value: ReactNode;
  sublabel?: ReactNode;
  icon?: LucideIcon;
  tone?: CcTone;
  progress?: number;
  badge?: ReactNode;
  onClick?: () => void;
  active?: boolean;
  className?: string;
}) {
  const t = TONE_MAP[tone];
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'group relative overflow-hidden rounded-2xl border bg-card text-left p-3.5 sm:p-4 transition-all duration-200 shadow-xs',
        t.ring,
        onClick && 'cursor-pointer hover:-translate-y-0.5 hover:shadow-md active:translate-y-0',
        active && 'ring-2 ring-primary border-primary shadow-md',
        className,
      )}
    >
      <div
        aria-hidden
        className={cn(
          'pointer-events-none absolute -top-12 -right-12 h-28 w-28 rounded-full bg-gradient-to-br blur-2xl opacity-80 transition-opacity group-hover:opacity-100',
          t.glow,
        )}
      />
      <div className="relative flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground truncate">
            {label}
          </div>
          <div className={cn('mt-1 text-xl sm:text-2xl font-bold tabular-nums tracking-tight leading-none', t.valueText)}>
            {value}
          </div>
        </div>
        {Icon && (
          <span className={cn('h-9 w-9 shrink-0 rounded-xl flex items-center justify-center transition-transform group-hover:scale-105', t.iconBg)}>
            <Icon className="h-4 w-4" />
          </span>
        )}
      </div>
      {(sublabel || badge) && (
        <div className="relative mt-2.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span className="truncate">{sublabel}</span>
          {badge}
        </div>
      )}
      {typeof progress === 'number' && (
        <div className="relative mt-2.5 h-1.5 w-full rounded-full bg-muted/70 overflow-hidden">
          <div
            className={cn('h-full rounded-full bg-gradient-to-r transition-all duration-500', t.barBg)}
            style={{ width: `${Math.max(0, Math.min(100, progress))}%` }}
          />
        </div>
      )}
    </Comp>
  );
}

export function CcSectionCard({
  title,
  subtitle,
  icon: Icon,
  tone = 'primary',
  actions,
  children,
  className,
  bodyClassName,
  noPadding,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  tone?: CcTone;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  noPadding?: boolean;
}) {
  const t = TONE_MAP[tone];
  return (
    <section
      className={cn(
        'relative overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs',
        className,
      )}
    >
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border/60 bg-muted/20 px-4 py-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {Icon && (
              <span className={cn('h-8 w-8 shrink-0 rounded-lg flex items-center justify-center', t.iconBg)}>
                <Icon className="h-4 w-4" />
              </span>
            )}
            <div className="min-w-0">
              {title && <h3 className="text-sm font-semibold leading-tight text-foreground truncate">{title}</h3>}
              {subtitle && <p className="text-[11px] text-muted-foreground truncate mt-0.5">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex items-center gap-1.5 flex-wrap">{actions}</div>}
        </header>
      )}
      <div className={cn(!noPadding && 'p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export function CcPill({
  children,
  tone = 'slate',
  icon: Icon,
  pulse,
  className,
}: {
  children: ReactNode;
  tone?: CcTone;
  icon?: LucideIcon;
  pulse?: boolean;
  className?: string;
}) {
  const t = TONE_MAP[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium leading-4',
        t.pillBg,
        className,
      )}
    >
      {pulse && (
        <span className="relative flex h-1.5 w-1.5">
          <span className={cn('animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 bg-current')} />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-current" />
        </span>
      )}
      {Icon && <Icon className="h-3 w-3" />}
      {children}
    </span>
  );
}

export function CcEmptyState({
  icon: Icon,
  title,
  description,
  action,
  tone = 'slate',
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  tone?: CcTone;
}) {
  const t = TONE_MAP[tone];
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-4">
      <div className={cn('h-12 w-12 rounded-2xl flex items-center justify-center mb-3', t.iconBg)}>
        <Icon className="h-5 w-5" />
      </div>
      <div className="text-sm font-semibold text-foreground">{title}</div>
      {description && <p className="text-xs text-muted-foreground max-w-sm mt-1">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

/** Human-friendly label formatter — removes underscores and capitalizes words */
export function formatHumanLabel(raw?: string | null): string {
  if (!raw) return '—';
  const map: Record<string, string> = {
    reached_ok: 'Reached — All Good',
    confirmed_payout_number: 'Confirmed Payout Number',
    wants_more_tenants: 'Wants More Tenants',
    complaint: 'Complaint Raised',
    payout_issue: 'Payout Issue',
    not_landlord: 'Not a Landlord',
    wrong_number: 'Wrong Number',
    engaged: 'Engaged',
    reached_busy: 'Reached (Busy)',
    no_answer: 'No Answer',
    unreachable: 'Unreachable / Off',
    callback_requested: 'Callback Requested',
    completed: 'Completed',
    verified: 'Verified',
    unverified: 'Unverified',
    pending: 'Pending Review',
    landlords_registry_all: 'All Registered Landlords',
    landlords_never_called: 'Never Called Landlords',
    landlords_active_plans: 'Landlords with Active Rent Plans',
    landlords_paid_30d: 'Paid in Last 30 Days',
    landlords_unverified: 'Unverified Landlords',
    landlords_no_houses: 'Landlords without Listed Houses',
    landlords_not_called_30d: 'Not Called in 30+ Days',
    landlords_not_called_60d: 'Not Called in 60+ Days',
    landlords_not_called_90d: 'Not Called in 90+ Days',
    landlords_all: 'All Landlords (Base)',
    landlords_with_plans: 'Landlords with Rent Plans',
    landlords_with_houses: 'Landlords with Houses',
  };
  const key = raw.trim().toLowerCase();
  if (map[key]) return map[key];
  return raw
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (l) => l.toUpperCase());
}
