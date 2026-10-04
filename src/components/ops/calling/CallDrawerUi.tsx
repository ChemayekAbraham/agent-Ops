import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ContactActions } from '@/components/ops/ContactActions';

/**
 * Presentation-only building blocks shared by the Tenant and Landlord call
 * drawers. No data fetching, no workflow logic — layout and styling only.
 */

export function DrawerSection({
  title,
  icon: Icon,
  action,
  children,
  className,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('mt-4', className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {Icon && <Icon className="h-3.5 w-3.5" />}
          {title}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Label / value pair used inside the details grid. */
export function DetailField({
  label,
  value,
  phone,
  message,
}: {
  label: string;
  value: string;
  phone?: string | null;
  message?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border/50 bg-background/60 px-2.5 py-2">
      <p className="text-[10px] font-medium uppercase tracking-wide leading-tight text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-center justify-between gap-2">
        <p className="min-w-0 flex-1 break-words text-xs font-semibold leading-snug text-foreground">{value}</p>
        {phone ? <ContactActions phone={phone} message={message} size="xs" /> : null}
      </div>
    </div>
  );
}

export function DetailGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">{children}</div>;
}

export function StatTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-border/60 bg-muted/40 p-2.5">
      <p className="break-words text-[10px] font-medium uppercase tracking-wide leading-tight text-muted-foreground">
        {label}
      </p>
      <p className={cn('mt-1 break-normal text-sm font-bold leading-tight tabular-nums sm:text-base', tone)}>{value}</p>
    </div>
  );
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">{children}</div>;
}

/** Rounded contact card used for agent / landlord / caretaker rows. */
export function ContactCard({
  role,
  name,
  phone,
  message,
  meta,
}: {
  role: string;
  name: string;
  phone?: string | null;
  message?: string;
  meta?: string | null;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-xl border border-border/60 bg-card px-2.5 py-2">
      <div className="min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{role}</p>
        <p className="truncate text-xs font-semibold text-foreground">{name || '—'}</p>
        {meta && <p className="truncate text-[10px] text-muted-foreground">{meta}</p>}
      </div>
      <ContactActions phone={phone || ''} message={message} size="xs" />
    </div>
  );
}

export function initialsOf(name: string) {
  return (name || '?')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map(p => p[0]?.toUpperCase() ?? '')
    .join('');
}

/** Gradient identity header with initials avatar. */
export function PersonHeader({
  name,
  subtitle,
  badges,
  children,
}: {
  name: string;
  subtitle?: string;
  badges?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border/60 bg-gradient-to-br from-primary/10 via-card to-card p-3">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary">
          {initialsOf(name)}
        </div>
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-bold leading-tight text-foreground sm:text-base">{name}</p>
          {subtitle && <p className="mt-0.5 break-words text-[11px] text-muted-foreground">{subtitle}</p>}
          {badges && <div className="mt-1.5 flex flex-wrap items-center gap-1.5">{badges}</div>}
        </div>
      </div>
      {children && <div className="mt-2.5 flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}
