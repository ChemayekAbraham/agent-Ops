import { Repeat, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TenantRelationship } from '@/hooks/useTenantRenewalMap';

interface Props {
  relationship: TenantRelationship | null | undefined;
  /** Prior approved plans — shown in the tooltip and, optionally, as a Cycle chip. */
  approvedPlans?: number;
  /** Also render the "Cycle N" chip next to the tag. */
  showCycle?: boolean;
  size?: 'xs' | 'sm';
  className?: string;
}

const SIZE = {
  xs: 'text-[9px] px-1.5 py-0.5 gap-0.5 [&_svg]:h-2.5 [&_svg]:w-2.5',
  sm: 'text-[10px] px-2 py-0.5 gap-1 [&_svg]:h-3 [&_svg]:w-3',
};

/**
 * "New tenant" / "Renewing" tag used across every rent pipeline stage.
 * Pure presentation: the classification comes from real prior rent plans
 * (see `useTenantRenewalMap` / `rent_pipeline_tenant_history`).
 */
export function TenantRelationshipBadge({ relationship, approvedPlans = 0, showCycle = false, size = 'xs', className }: Props) {
  if (!relationship) {
    return (
      <span className={cn('inline-flex items-center rounded-full border border-dashed border-border text-muted-foreground font-semibold uppercase tracking-wide shrink-0', SIZE[size], className)}>
        Checking…
      </span>
    );
  }
  const renewing = relationship === 'renewing';
  return (
    <>
      {showCycle && (
        <span
          className={cn('inline-flex items-center rounded-full border font-bold uppercase tracking-wide shrink-0 bg-slate-500/15 text-slate-700 dark:text-slate-300 border-slate-500/30', SIZE[size], className)}
          title={`Approved rent plans for this tenant: ${approvedPlans}`}
        >
          <Repeat />
          Cycle {approvedPlans}
        </span>
      )}
      <span
        className={cn(
          'inline-flex items-center rounded-full border font-bold uppercase tracking-wide shrink-0',
          renewing
            ? 'bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/30'
            : 'bg-blue-500/15 text-blue-700 dark:text-blue-300 border-blue-500/30',
          SIZE[size],
          className,
        )}
        title={
          renewing
            ? `Renewing tenant — ${approvedPlans} rent plan${approvedPlans === 1 ? '' : 's'} approved with us before`
            : 'New tenant — no approved rent plan with us yet'
        }
      >
        {renewing ? <Repeat /> : <Sparkles />}
        {renewing ? 'Renewing' : 'New tenant'}
      </span>
    </>
  );
}

export default TenantRelationshipBadge;
