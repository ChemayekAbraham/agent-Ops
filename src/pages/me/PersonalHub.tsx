import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { FileText, Briefcase, User, Bell, FolderOpen, Ticket, Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import PersonalLayout from '@/components/layout/PersonalLayout';
import NameCompletionReminder from '@/components/notifications/NameCompletionReminder';
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
    'group flex flex-col gap-3 rounded-2xl border bg-card p-5 shadow-sm transition-colors',
    disabled
      ? 'cursor-not-allowed opacity-60'
      : 'hover:border-primary/30 hover:bg-accent/50'
  );

  const visibleBadges = (badges ?? []).filter((b) => b.count > 0);

  const content = (
    <>
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <h2 className="font-semibold text-card-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {visibleBadges.length > 0 && (
        <div className="mt-auto flex flex-wrap gap-1.5">
          {visibleBadges.map((b) => (
            <span
              key={b.label}
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                b.tone === 'pending'
                  ? 'border-amber-200 bg-amber-100 text-amber-800 dark:border-amber-900 dark:bg-amber-900/30 dark:text-amber-300'
                  : 'border-emerald-200 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-300'
              )}
            >
              <span className="font-bold">{b.count}</span>
              {b.label}
            </span>
          ))}
        </div>
      )}
      {disabled && (
        <span className="mt-auto self-start rounded-full bg-muted px-2 py-1 text-xs font-medium text-muted-foreground">
          Coming soon
        </span>
      )}
    </>
  );


  if (disabled || !to) {
    return (
      <div className={className} aria-disabled="true">
        {content}
      </div>
    );
  }

  return (
    <Link to={to} className={className}>
      {content}
    </Link>
  );
};

const CARDS = [
  {
    to: '/your-profile',
    icon: User,
    title: 'My profile',
    description: 'Your personal details',
  },
  {
    to: '/me/payslips',
    icon: FileText,
    title: 'My payslips',
    description: 'Your own pay records',
  },
  {
    to: '/me/work',
    icon: Briefcase,
    title: 'My work',
    description: 'Tasks assigned to you',
  },
  {
    to: '/me/tickets',
    icon: Ticket,
    title: 'Tickets',
    description: 'Raise a fault or pick one up',
  },
  {
    to: '/me/requisitions',
    icon: Wallet,
    title: 'Make a requisition',
    description: 'Ask for funds — reviewed by your head, COO, then CFO',
  },
  {
    to: '/notifications',
    icon: Bell,
    title: 'Notifications',
    description: 'Messages and alerts',
  },
  {
    icon: FolderOpen,
    title: 'My documents',
    description: 'Your contracts, letters and certificates',
    to: '/me/documents',
  },
];


const PersonalHub = () => {
  const [staffRecord, setStaffRecord] = useState<Employee | null>(null);
  const [reqCounts, setReqCounts] = useState({ pending: 0, approved: 0 });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id;
      if (!uid || cancelled) return;
      const { data, error } = await supabase
        .from('staff_requisitions')
        .select('stage')
        .eq('requester_id', uid);
      if (cancelled) return;
      if (error) {
        console.error('staff_requisitions counts', error);
        return;
      }
      const rows = (data ?? []) as { stage: string | null }[];
      setReqCounts({
        pending: rows.filter(
          (r) => r.stage && !['approved', 'rejected', 'cancelled'].includes(r.stage)
        ).length,
        approved: rows.filter((r) => r.stage === 'approved').length,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);


  useEffect(() => {
    let cancelled = false;
    (async () => {
      let staff: Employee | null = null;
      try {
        staff = await getMyStaff();
      } catch {
        staff = null;
      }
      if (cancelled) return;
      setStaffRecord(staff);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <PersonalLayout title="My space">
      <div className="space-y-4">
        <NameCompletionReminder />
        <GrowthCommissionCard />
        {staffRecord && <MyAdvanceCard staffId={staffRecord.id} />}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CARDS.map((card, index) => (
            <HubCard
              key={index}
              {...card}
              badges={
                card.to === '/me/requisitions'
                  ? [
                      { label: 'pending', count: reqCounts.pending, tone: 'pending' as const },
                      { label: 'approved', count: reqCounts.approved, tone: 'approved' as const },
                    ]
                  : undefined
              }
            />
          ))}

        </div>

      </div>
    </PersonalLayout>
  );
};

export default PersonalHub;
