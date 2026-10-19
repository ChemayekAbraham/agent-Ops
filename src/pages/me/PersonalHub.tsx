import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import PersonalLayout from '@/components/layout/PersonalLayout';
import { useFoodCoordinatorStatus, useFoodCanUseCanteen } from '@/hooks/useFoodService';
import { PERSONAL_NAV } from '@/components/layout/personalNav';
import GrowthCommissionCard from '@/components/me/GrowthCommissionCard';
import MyAdvanceCard from '@/hr/pay/MyAdvanceCard';
import { getMyStaff } from '@/hr/api';
import { supabase } from '@/hr/api/client';
import type { Employee } from '@/hr/types';

interface HubBadge {
  label: string;
  count: number;
  tone: 'pending' | 'approved';
}

interface HubCardProps {
  to?: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  disabled?: boolean;
  badges?: HubBadge[];
}

const HubCard = ({ to, icon: Icon, title, description, disabled, badges }: HubCardProps) => {
  const className = cn(
    'group relative flex min-h-[138px] flex-col gap-3 rounded-xl border border-border/70 bg-card p-4 shadow-sm transition-all sm:p-5',
    disabled
      ? 'cursor-not-allowed opacity-60'
      : 'hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-md hover:shadow-primary/5',
  );
  const visibleBadges = (badges ?? []).filter((b) => b.count > 0);
  const content = (
    <>
      <div className="flex items-center justify-between">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary transition-colors group-hover:bg-primary/15">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        {!disabled && <ArrowRight className="h-4 w-4 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />}
      </div>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-card-foreground sm:text-base">{title}</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground sm:text-sm">{description}</p>
      </div>
      {visibleBadges.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1.5">
          {visibleBadges.map((b) => (
            <span key={b.label} className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
              b.tone === 'pending'
                ? 'border-warning/30 bg-warning/10 text-warning-foreground dark:text-warning'
                : 'border-success/30 bg-success/10 text-success',
            )}>
              <span className="font-bold">{b.count}</span>{b.label}
            </span>
          ))}
        </div>
      )}
      {disabled && <span className="mt-auto self-start rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">Coming soon</span>}
    </>
  );
  if (disabled || !to) return <div className={className} aria-disabled="true">{content}</div>;
  return <Link to={to} className={className}>{content}</Link>;
};

const CARDS = PERSONAL_NAV;


const PersonalHub = () => {
  const { data: reqCounts = { pending: 0, approved: 0 } } = useQuery({
    queryKey: ['staff-requisitions-counts'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data: sessionData } = await supabase.auth.getSession();
      const uid = sessionData.session?.user?.id ?? (await supabase.auth.getUser()).data.user?.id;
      if (!uid) return { pending: 0, approved: 0 };
      const { data, error } = await supabase.from('staff_requisitions').select('stage').eq('requester_id', uid);
      if (error) { console.error('staff_requisitions counts', error); return { pending: 0, approved: 0 }; }
      const rows = (data ?? []) as { stage: string | null }[];
      return {
        pending: rows.filter((r) => r.stage && !['approved', 'rejected', 'cancelled'].includes(r.stage)).length,
        approved: rows.filter((r) => r.stage === 'approved').length,
      };
    },
  });

  const { data: staffRecord = null } = useQuery<Employee | null>({
    queryKey: ['hr-my-staff'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      try { return await getMyStaff(); } catch { return null; }
    },
  });

  const { data: isPsoOfficer } = useQuery<boolean>({
    queryKey: ['pso-is-officer'],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('pso_is_officer' as any);
      if (error) return false;
      return data === true;
    },
  });

  // Food Management is only offered to someone holding the assignment.
  const { data: foodStatus } = useFoodCoordinatorStatus();
  const { data: canUseCanteen } = useFoodCanUseCanteen();

  const visibleCards = CARDS.filter(
    (card) => (!card.requiresPsoOfficer || isPsoOfficer === true)
      && (!card.requiresStaff || !!staffRecord)
      && (!card.requiresFoodCoordinator || foodStatus?.isCoordinator === true)
      && (!card.requiresCanteen || canUseCanteen === true),
  );

  return (
    <PersonalLayout title="My space">
      <div className="space-y-5">
        <GrowthCommissionCard />
        {staffRecord && <MyAdvanceCard staffId={staffRecord.id} />}
        <section aria-labelledby="workspace-heading">
          <div className="mb-3 flex items-end justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Workspace</p>
              <h2 id="workspace-heading" className="mt-1 text-base font-semibold tracking-tight sm:text-lg">Your tools and records</h2>
            </div>
            <span className="text-xs text-muted-foreground">{visibleCards.length} areas</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visibleCards.map((card, index) => (
              <HubCard key={index} {...card} badges={card.to === '/me/requisitions' ? [
                { label: 'pending', count: reqCounts.pending, tone: 'pending' as const },
                { label: 'approved', count: reqCounts.approved, tone: 'approved' as const },
              ] : undefined} />
            ))}
          </div>
        </section>
      </div>
    </PersonalLayout>
  );
};

export default PersonalHub;
