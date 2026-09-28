import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { FilePlus2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useProxyPerformanceDashboard, type ProxyRange } from '@/hooks/useProxyPerformanceDashboard';
import { PromissoryNoteDialog } from '@/components/agent/PromissoryNoteDialog';
import type { HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';
import {
  ProxyKpiGrid, ProxyTodayCard, ProxyTargetCard, ProxyPerformanceChart, ProxyEarningsSnapshot,
  ProxyRecentNotes, ProxyDashboardSkeleton, SectionError,
} from '@/components/proxy-dashboard/ProxyDashboardParts';
import { ProxyHouseOpportunities } from '@/components/proxy-dashboard/ProxyHouseOpportunities';
import { ProxyHowItWorksDialog } from '@/components/proxy-dashboard/ProxyHowItWorksDialog';
import { ProxyMobileNav, ProxySidebar, sectionPath, type ProxySection } from '@/components/proxy-dashboard/ProxyWorkspaceNav';
import { ProxyNotesSection } from '@/components/proxy-dashboard/ProxyNotesSection';
import { ProxyPartnersSection } from '@/components/proxy-dashboard/ProxyPartnersSection';
import { ProxyEarningsSection } from '@/components/proxy-dashboard/ProxyEarningsSection';
import { ProxyInviteSection } from '@/components/proxy-dashboard/ProxyInviteSection';
import { ProxyReportsSection } from '@/components/proxy-dashboard/ProxyReportsSection';

const SECTIONS: ProxySection[] = ['home', 'notes', 'partners', 'earnings', 'invite', 'reports', 'houses'];

export default function ProxyPerformanceDashboard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const { section: raw } = useParams();
  const section: ProxySection = SECTIONS.includes(raw as ProxySection) ? (raw as ProxySection) : 'home';
  const [range, setRange] = useState<ProxyRange>('7d');
  const [noteHouse, setNoteHouse] = useState<HouseOpportunity | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  // Home summary is also reused by Notes/Earnings for their headline figures (shared cache).
  const needsSummary = section === 'home' || section === 'notes' || section === 'earnings';
  const q = useProxyPerformanceDashboard(needsSummary || howOpen ? user?.id : undefined, range);
  const d = q.data;
  const meta = (user?.user_metadata ?? {}) as { full_name?: string };
  const name = (meta.full_name || user?.email?.split('@')[0] || 'Agent').split(' ')[0];
  const go = (s: ProxySection) => navigate(sectionPath(s));

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const dayFraction = Math.min(1, Math.max(0, (hour - 7) / 11));
  const weekFraction = d ? (7 - d.targets.days_remaining - 1 + dayFraction) / 7 : 0;
  const todayLabel = (d?.today ? new Date(`${d.today}T00:00:00`) : new Date()).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });

  const home = (
    <div className="space-y-3 md:space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h1 className="truncate text-lg font-bold tracking-tight md:text-2xl">{greet}, {name}</h1>
          <p className="text-xs text-muted-foreground">{todayLabel}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" className="hidden h-9 md:inline-flex" onClick={() => setHowOpen(true)}>How it works</Button>
          <Button size="sm" className="h-9" onClick={() => setNoteOpen(true)}><FilePlus2 className="mr-1 h-4 w-4" /><span className="md:hidden">Create Note</span><span className="hidden md:inline">Create Promissory Note</span></Button>
        </div>
      </div>

      {q.isLoading && !d ? <ProxyDashboardSkeleton /> : q.isError && !d ? (
        <SectionError label="your performance" onRetry={() => q.refetch()} />
      ) : d ? (
        <>
          <div className="md:hidden"><ProxyTodayCard d={d} /></div>
          <div className="grid gap-2.5 md:grid-cols-2 md:gap-3 lg:grid-cols-3">
            <ProxyTargetCard title="Today's Target" done={d.notes.created_today} target={d.targets.daily} expectedFraction={dayFraction} />
            <ProxyTargetCard title="Weekly Target" done={d.notes.created_this_week} target={d.targets.weekly} expectedFraction={weekFraction}
              remainingText={`${d.targets.days_remaining} day${d.targets.days_remaining === 1 ? '' : 's'} left`} />
            <div className="hidden md:block md:col-span-2 lg:col-span-1"><ProxyTodayCard d={d} /></div>
          </div>
          <ProxyKpiGrid d={d} onEarnings={() => go('earnings')} />
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2"><ProxyPerformanceChart d={d} range={range} onRange={setRange} fetching={q.isFetching} /></div>
            <div className="hidden lg:block"><ProxyEarningsSnapshot d={d} onOpen={() => go('earnings')} /></div>
          </div>
          <ProxyRecentNotes d={d} onViewAll={() => go('notes')} />
        </>
      ) : null}

      <ProxyHouseOpportunities preview onCreateNote={setNoteHouse} onViewAll={() => go('houses')} />
    </div>
  );

  return (
    <div className="flex min-h-screen bg-muted/40">
      <ProxySidebar active={section} />
      <main className="min-w-0 flex-1 px-3 pb-[calc(5rem+env(safe-area-inset-bottom))] pt-3 md:px-6 md:pb-8 md:pt-6">
        <div className="mx-auto w-full max-w-6xl">
          {section === 'home' && home}
          {section === 'notes' && <ProxyNotesSection agentId={user?.id} summary={d} onCreate={() => setNoteOpen(true)} />}
          {section === 'partners' && <ProxyPartnersSection agentId={user?.id} onInvite={() => go('invite')} />}
          {section === 'earnings' && <ProxyEarningsSection userId={user?.id} summary={d} />}
          {section === 'invite' && <ProxyInviteSection agentId={user?.id} />}
          {section === 'reports' && <ProxyReportsSection userId={user?.id} />}
          {section === 'houses' && <ProxyHouseOpportunities onCreateNote={setNoteHouse} />}
        </div>
      </main>
      <ProxyMobileNav active={section} onHowItWorks={() => setHowOpen(true)} />

      <ProxyHowItWorksDialog hideTrigger open={howOpen} onOpenChange={setHowOpen}
        noteRate={d?.commission.note_rate} initialSupportPct={d?.commission.initial_support_pct} topUpPct={d?.commission.top_up_pct} />
      <PromissoryNoteDialog
        open={noteOpen || !!noteHouse}
        initialHouse={noteHouse}
        initialAmount={noteHouse?.monthly_rent}
        onOpenChange={(o) => {
          if (!o) {
            setNoteOpen(false);
            setNoteHouse(null);
            qc.invalidateQueries({ queryKey: ['proxy-performance-dashboard'] });
            qc.invalidateQueries({ queryKey: ['proxy-dash-houses'] });
            qc.invalidateQueries({ queryKey: ['proxy-cc-notes'] });
          }
        }}
      />
    </div>
  );
}
