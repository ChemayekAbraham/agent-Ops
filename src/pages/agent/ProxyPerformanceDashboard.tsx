import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, FilePlus2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/useAuth';
import { useProxyPerformanceDashboard, type ProxyRange } from '@/hooks/useProxyPerformanceDashboard';
import { PromissoryNoteDialog } from '@/components/agent/PromissoryNoteDialog';
import type { HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';
import {
  ProxyDashboardHeader, ProxyKpiGrid, ProxyDailyPerformance, ProxyTargetCard, ProxyPerformanceChart,
  ProxyNotesSummary, ProxyRecentNotes, ProxyDashboardSkeleton, SectionError,
} from '@/components/proxy-dashboard/ProxyDashboardParts';
import { ProxyHouseOpportunities } from '@/components/proxy-dashboard/ProxyHouseOpportunities';

export default function ProxyPerformanceDashboard() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { user } = useAuth();
  const [range, setRange] = useState<ProxyRange>('7d');
  const [noteHouse, setNoteHouse] = useState<HouseOpportunity | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const q = useProxyPerformanceDashboard(user?.id, range);
  const d = q.data;
  const meta = (user?.user_metadata ?? {}) as { full_name?: string };
  const name = (meta.full_name || user?.email?.split('@')[0] || 'Agent').split(' ')[0];

  const hour = new Date().getHours();
  const dayFraction = Math.min(1, Math.max(0, (hour - 7) / 11)); // working day 7am–6pm
  const weekFraction = d ? (7 - d.targets.days_remaining - 1 + dayFraction) / 7 : 0;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 px-3 py-4 md:px-6 md:py-6">
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" size="sm" className="-ml-2 h-8" onClick={() => navigate('/dashboard/agent')}><ArrowLeft className="mr-1 h-4 w-4" />Agent dashboard</Button>
        <Button size="sm" className="h-8" onClick={() => setNoteOpen(true)}><FilePlus2 className="mr-1 h-4 w-4" />Create Promissory Note</Button>
      </div>
      <ProxyDashboardHeader name={name} today={d?.today} />

      {q.isLoading && !d ? <ProxyDashboardSkeleton /> : q.isError && !d ? (
        <SectionError label="your performance" onRetry={() => q.refetch()} />
      ) : d ? (
        <>
          <ProxyKpiGrid d={d} />
          <div className="grid gap-3 md:grid-cols-3">
            <ProxyTargetCard title="Today's Target" done={d.notes.created_today} target={d.targets.daily} unit="notes" expectedFraction={dayFraction} />
            <ProxyTargetCard title="Weekly Target" done={d.notes.created_this_week} target={d.targets.weekly} unit="notes"
              expectedFraction={weekFraction}
              remainingText={`${d.targets.days_remaining} day${d.targets.days_remaining === 1 ? '' : 's'} remaining`} />
            <ProxyDailyPerformance d={d} />
          </div>
          <div className="grid gap-3 lg:grid-cols-3">
            <div className="min-w-0 lg:col-span-2"><ProxyPerformanceChart d={d} range={range} onRange={setRange} fetching={q.isFetching} /></div>
            <ProxyNotesSummary d={d} />
          </div>
          <ProxyRecentNotes d={d} onViewAll={() => navigate('/agent/proxy-agents')} />
        </>
      ) : null}

      <ProxyHouseOpportunities onCreateNote={setNoteHouse} />

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
          }
        }}
      />
    </div>
  );
}
