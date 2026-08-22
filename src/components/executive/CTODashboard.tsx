import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { ExecutiveDataTable, Column } from './ExecutiveDataTable';
import { Server, Activity, ShieldAlert, Users, Bug, Wifi, Database, Clock, HardDrive, Gauge } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { format, subDays, startOfDay } from 'date-fns';
import { SystemLogsViewer } from './SystemLogsViewer';
import { BrowserCompatDashboard } from './BrowserCompatDashboard';
import { InfrastructureHealthMonitor } from './InfrastructureHealthMonitor';
import { CTOEmailsOverview } from './CTOEmailsOverview';
import { CTOCommunicationOverview } from './CTOCommunicationOverview';
import { SmsDeliveryLogViewer } from './SmsDeliveryLogViewer';
import { SmsExceptionsManager } from './SmsExceptionsManager';
import { BroadcastStatusPanel } from './BroadcastStatusPanel';
import RunBackupNowButton from '@/components/admin/RunBackupNowButton';
import { CTOLedgerExport } from './CTOLedgerExport';
import MaintenanceToggleCard from '@/components/cto/MaintenanceToggleCard';
import ExtractSchemaCard from '@/components/cto/ExtractSchemaCard';
import ExportUsersWithHashesCard from '@/components/cto/ExportUsersWithHashesCard';
import { CTOPasswordResetPanel } from '@/components/cto/CTOPasswordResetPanel';
import PlatformControlsPanel from '@/components/cto/PlatformControlsPanel';
import { CTOAgentFreezePanel } from '@/components/cto/CTOAgentFreezePanel';
import { CTOKycLevelPanel } from '@/components/cto/CTOKycLevelPanel';
import InviteMerchantAgentCard from '@/components/agent/InviteMerchantAgentCard';
import MerchantInviteLinksManager from '@/components/agent/MerchantInviteLinksManager';
import { SeoIndexMonitorPanel } from './SeoIndexMonitorPanel';
import { SeoCoverageDashboard } from './SeoCoverageDashboard';
import { SeoRedirectAuditPanel } from './SeoRedirectAuditPanel';
import { SemrushBrandTrackerPanel } from './SemrushBrandTrackerPanel';
import { BrandSerpVisibilityPanel } from './BrandSerpVisibilityPanel';
import { ChangeOfAddressMonitorPanel } from './ChangeOfAddressMonitorPanel';
import { RedirectHealthAlertsPanel } from './RedirectHealthAlertsPanel';
import { SignupSourceLogPanel } from './SignupSourceLogPanel';
import { DepositBridgeHealthPanel } from '@/components/bridge/DepositBridgeHealthPanel';

export function CTODashboard({ activeTab }: { activeTab?: string }) {
  if (activeTab === 'system-logs') {
    return <SystemLogsViewer />;
  }
  if (activeTab === 'browser-compat') {
    return <BrowserCompatDashboard />;
  }
  if (activeTab === 'sms-delivery') {
    return <SmsDeliveryLogViewer />;
  }
  if (activeTab === 'sms-exceptions') {
    return <SmsExceptionsManager />;
  }
  if (activeTab === 'broadcast-status') {
    return <BroadcastStatusPanel />;
  }
  if (activeTab === 'emails' || activeTab === 'communication') {
    return <CTOCommunicationOverview />;
  }
  if (activeTab === 'password-reset') {
    return <CTOPasswordResetPanel />;
  }
  if (activeTab === 'platform-controls') {
    return <PlatformControlsPanel />;
  }
  if (activeTab === 'agent-freeze') {
    return <CTOAgentFreezePanel />;
  }
  if (activeTab === 'kyc-level') {
    return <CTOKycLevelPanel />;
  }
  if (activeTab === 'merchant-invites') {
    return <MerchantInviteLinksManager />;
  }
  if (activeTab === 'signup-log') {
    return <SignupSourceLogPanel />;
  }
  if (activeTab === 'bridge-health') {
    return <DepositBridgeHealthPanel />;
  }

  // Real: active users in last 7 days
  const { data: activeUsers, isLoading } = useQuery({
    queryKey: ['cto-active-users'],
    queryFn: async () => {
      const since = subDays(new Date(), 7).toISOString();
      const { count } = await supabase.from('profiles').select('*', { count: 'exact', head: true })
        .gte('last_active_at', since);
      return count || 0;
    },
    staleTime: 300000,
  });

  // Real: total registered users
  const { data: totalProfiles } = useQuery({
    queryKey: ['cto-total-profiles'],
    queryFn: async () => {
      const { count } = await supabase.from('profiles').select('*', { count: 'exact', head: true });
      return count || 0;
    },
    staleTime: 300000,
  });

  // Real: measure actual DB response time (latency probe)
  const { data: dbLatency } = useQuery({
    queryKey: ['cto-db-latency'],
    queryFn: async () => {
      const t0 = performance.now();
      await supabase.from('profiles').select('id', { count: 'exact', head: true });
      const t1 = performance.now();
      return Math.round(t1 - t0);
    },
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  // Real: daily signup velocity (last 14 days) - measures system load
  const { data: signupVelocity } = useQuery({
    queryKey: ['cto-signup-velocity'],
    queryFn: async () => {
      const since = subDays(new Date(), 14).toISOString();
      const { data } = await supabase.from('profiles').select('created_at')
        .gte('created_at', since).order('created_at', { ascending: true }).limit(200);
      if (!data) return [];
      const byDay: Record<string, number> = {};
      for (let i = 13; i >= 0; i--) {
        byDay[format(subDays(new Date(), i), 'yyyy-MM-dd')] = 0;
      }
      data.forEach(p => {
        const day = format(new Date(p.created_at), 'yyyy-MM-dd');
        if (byDay[day] !== undefined) byDay[day]++;
      });
      return Object.entries(byDay).map(([date, count]) => ({
        day: format(new Date(date), 'dd MMM'),
        signups: count,
      }));
    },
    staleTime: 600000,
  });

  // Authoritative system event stream: public.system_events
  // (notifications is write-suppressed per platform policy and is NOT the source of truth)
  const { data: systemEvents, isLoading: loadingEvents } = useQuery({
    queryKey: ['cto-system-events-v2'],
    queryFn: async () => {
      const { data } = await (supabase as any).from('system_events')
        .select('id, event_type, user_id, related_entity_type, related_entity_id, metadata, processed, created_at')
        .order('created_at', { ascending: false })
        .limit(200);
      const categorize = (et: string): 'security' | 'error' | 'warning' | 'info' => {
        const e = (et || '').toLowerCase();
        if (/(fraud|frozen|freeze|suspicious|breach|denied|unauthorized|locked|blocked)/.test(e)) return 'security';
        if (/(fail|failed|reject|rejected|error|defaulted|cancelled|reversal|reversed)/.test(e)) return 'error';
        if (/(drift|warning|absorb|stale|retry|missing|overdraw|unrouted|violation)/.test(e)) return 'warning';
        return 'info';
      };
      return (data || []).map((r: any) => ({
        id: r.id,
        title: r.event_type,
        message: r.related_entity_type
          ? `${r.related_entity_type}${r.related_entity_id ? ' #' + String(r.related_entity_id).slice(0, 8) : ''}${r.metadata ? ' · ' + JSON.stringify(r.metadata).slice(0, 140) : ''}`
          : (r.metadata ? JSON.stringify(r.metadata).slice(0, 180) : ''),
        type: categorize(r.event_type),
        created_at: r.created_at,
      }));
    },
    staleTime: 60000,
  });

  // Real: deposit request processing stats (system throughput indicator)
  const { data: processingStats } = useQuery({
    queryKey: ['cto-processing-stats'],
    queryFn: async () => {
      const since = subDays(new Date(), 7).toISOString();
      const { data } = await supabase.from('deposit_requests')
        .select('status, created_at, approved_at, rejected_at')
        .gte('created_at', since).limit(500);
      if (!data) return { pending: 0, processed: 0, avgProcessingMs: 0 };
      const pending = data.filter(d => d.status === 'pending').length;
      const processed = data.filter(d => d.status !== 'pending');
      const processingTimes = processed
        .filter(d => d.approved_at || d.rejected_at)
        .map(d => {
          const end = new Date(d.approved_at || d.rejected_at!).getTime();
          const start = new Date(d.created_at).getTime();
          return end - start;
        })
        .filter(t => t > 0 && t < 86400000 * 7);
      const avgMs = processingTimes.length > 0
        ? processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length
        : 0;
      return { pending, processed: processed.length, avgProcessingMs: avgMs };
    },
    staleTime: 600000,
  });

  // Real: rent request pipeline health
  const { data: pipelineHealth } = useQuery({
    queryKey: ['cto-pipeline-health'],
    queryFn: async () => {
      const { data } = await supabase.from('rent_requests')
        .select('status').limit(200);
      if (!data) return { total: 0, pending: 0, active: 0, completed: 0, failed: 0 };
      const counts = { total: data.length, pending: 0, active: 0, completed: 0, failed: 0 };
      data.forEach(r => {
        if (['pending', 'submitted'].includes(r.status)) counts.pending++;
        else if (['approved', 'funded', 'disbursed', 'active'].includes(r.status)) counts.active++;
        else if (['completed', 'repaid'].includes(r.status)) counts.completed++;
        else if (['rejected', 'defaulted', 'cancelled'].includes(r.status)) counts.failed++;
      });
      return counts;
    },
    staleTime: 600000,
  });

  // Real: table row counts as DB size indicators
  const { data: tableCounts } = useQuery({
    queryKey: ['cto-table-counts'],
    queryFn: async () => {
      const tables = ['profiles', 'rent_requests', 'landlords', 'referrals', 'general_ledger', 'notifications', 'deposit_requests', 'investor_portfolios'] as const;
      const results: Record<string, number> = {};
      await Promise.all(tables.map(async (table) => {
        const { count } = await supabase.from(table).select('*', { count: 'exact', head: true });
        results[table] = count || 0;
      }));
      return results;
    },
    staleTime: 600000,
  });

  // Real: daily active users trend (last 14 days from last_active_at)
  const { data: dauTrend } = useQuery({
    queryKey: ['cto-dau-trend'],
    queryFn: async () => {
      const results: { day: string; active: number }[] = [];
      for (let i = 13; i >= 0; i--) {
        const dayStart = startOfDay(subDays(new Date(), i)).toISOString();
        const dayEnd = startOfDay(subDays(new Date(), i - 1)).toISOString();
        const { count } = await supabase.from('profiles').select('*', { count: 'exact', head: true })
          .gte('last_active_at', dayStart).lt('last_active_at', dayEnd);
        results.push({ day: format(subDays(new Date(), i), 'dd MMM'), active: count || 0 });
      }
      return results;
    },
    staleTime: 600000,
  });

  // Derived metrics
  const errorCount = (systemEvents || []).filter(n => n.type === 'error' || n.type === 'warning').length;
  const securityAlerts = (systemEvents || []).filter(n =>
    n.type === 'security' || n.title?.toLowerCase().includes('fraud') || n.title?.toLowerCase().includes('frozen')
  ).length;
  const totalRows = tableCounts ? Object.values(tableCounts).reduce((a, b) => a + b, 0) : 0;
  const avgProcessingHrs = processingStats?.avgProcessingMs
    ? (processingStats.avgProcessingMs / 3600000).toFixed(1)
    : '—';

  // Connectivity status derived from latency
  const dbStatus = dbLatency ? (dbLatency < 300 ? 'Healthy' : dbLatency < 1000 ? 'Slow' : 'Degraded') : 'Checking...';
  const dbStatusColor = dbLatency ? (dbLatency < 300 ? 'bg-green-500/10 text-green-600' : dbLatency < 1000 ? 'bg-amber-500/10 text-amber-600' : 'bg-destructive/10 text-destructive') : '';

  const eventsColumns: Column<any>[] = [
    { key: 'created_at', label: 'Time', render: (v) => v ? format(new Date(v as string), 'dd MMM HH:mm') : '—' },
    { key: 'type', label: 'Type', render: (v) => (
      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
        v === 'error' ? 'bg-destructive/10 text-destructive' :
        v === 'security' ? 'bg-purple-500/10 text-purple-700' :
        v === 'warning' ? 'bg-amber-500/10 text-amber-700' :
        'bg-muted text-muted-foreground'
      }`}>
        {String(v)}
      </span>
    )},
    { key: 'title', label: 'Event' },
    { key: 'message', label: 'Details', className: 'max-w-[200px] truncate' },
  ];

  const tableStatsColumns: Column<{ table: string; rows: number }>[] = [
    { key: 'table', label: 'Table' },
    { key: 'rows', label: 'Row Count', render: (v) => Number(v).toLocaleString() },
  ];

  const tableStatsData = tableCounts
    ? Object.entries(tableCounts).map(([table, rows]) => ({ table, rows })).sort((a, b) => b.rows - a.rows)
    : [];

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Maintenance Mode Control (CTO) */}
      <MaintenanceToggleCard />

      {/* Google indexing monitor (welileapp.com SEO) */}
      <SeoIndexMonitorPanel />

      {/* Search Console coverage comparison (welileapp.com vs the legacy domain) */}
      <SeoCoverageDashboard />

      {/* Domain redirect audit (legacy + www -> welileapp.com) */}
      <SeoRedirectAuditPanel />

      {/* Change of Address readiness monitor (welilereceipts.com -> welileapp.com) */}
      <ChangeOfAddressMonitorPanel />

      {/* Redirect uptime alerting (welilereceipts.com -> welileapp.com) */}
      <RedirectHealthAlertsPanel />

      {/* Branded SERP visibility (Search Console demand + Semrush rank + profile presence) */}
      <BrandSerpVisibilityPanel />

      {/* Semrush branded-keyword & backlink tracking (welile / welile.com) */}
      <SemrushBrandTrackerPanel />

      {/* Database Schema Export */}
      <ExtractSchemaCard />

      {/* User Migration Export (profiles + bcrypt hashes) */}
      <ExportUsersWithHashesCard />

      {/* Infrastructure Health Monitor */}
      <InfrastructureHealthMonitor />

      {/* Database Backup */}
      <RunBackupNowButton />

      {/* Ledger Audit Export */}
      <CTOLedgerExport />

      {/* System KPIs - all real */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        <KPICard
          title="DB Response Time"
          value={dbLatency ? `${dbLatency}ms` : '...'}
          icon={Clock}
          color={dbLatency && dbLatency < 300 ? 'bg-green-500/10 text-green-600' : 'bg-amber-500/10 text-amber-600'}
          subtitle="Live probe"
        />
        <KPICard
          title="Active Users (7d)"
          value={(activeUsers || 0).toLocaleString()}
          icon={Users}
          loading={isLoading}
          color="bg-blue-500/10 text-blue-600"
        />
        <KPICard
          title="Total Users"
          value={(totalProfiles || 0).toLocaleString()}
          icon={Activity}
          loading={isLoading}
        />
        <KPICard
          title="DB Connection"
          value={dbStatus}
          icon={Database}
          color={dbStatusColor}
          subtitle={dbLatency ? `${dbLatency}ms latency` : undefined}
        />
        <KPICard
          title="System Events"
          value={errorCount}
          icon={Bug}
          color={errorCount > 0 ? 'bg-destructive/10 text-destructive' : 'bg-green-500/10 text-green-600'}
          subtitle="Errors & warnings (recent)"
        />
        <KPICard
          title="Security Alerts"
          value={securityAlerts}
          icon={ShieldAlert}
          color={securityAlerts > 0 ? 'bg-amber-500/10 text-amber-600' : 'bg-green-500/10 text-green-600'}
          subtitle="Fraud & freeze events"
        />
        <KPICard
          title="Total DB Rows"
          value={totalRows.toLocaleString()}
          icon={HardDrive}
          color="bg-teal-500/10 text-teal-600"
          subtitle="Across key tables"
        />
        <KPICard
          title="Avg Processing Time"
          value={`${avgProcessingHrs}h`}
          icon={Gauge}
          color="bg-indigo-500/10 text-indigo-600"
          subtitle="Deposit request → resolution"
        />
      </div>

      {/* Pipeline Health */}
      {pipelineHealth && (
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h3 className="text-sm font-semibold mb-3">Rent Request Pipeline Health</h3>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 sm:gap-3">
            {[
              { label: 'Total', value: pipelineHealth.total, color: 'text-foreground' },
              { label: 'Pending', value: pipelineHealth.pending, color: 'text-amber-600' },
              { label: 'Active', value: pipelineHealth.active, color: 'text-blue-600' },
              { label: 'Completed', value: pipelineHealth.completed, color: 'text-green-600' },
              { label: 'Failed', value: pipelineHealth.failed, color: 'text-destructive' },
            ].map(s => (
              <div key={s.label} className="text-center p-3 rounded-xl bg-muted/50">
                <p className={`text-xl font-bold ${s.color}`}>{s.value}</p>
                <p className="text-xs text-muted-foreground">{s.label}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Charts - real data */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
        <div className="rounded-2xl border border-border bg-card p-3 sm:p-4">
          <h3 className="text-sm font-semibold mb-3">Daily Active Users (14d)</h3>
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={dauTrend || []}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="day" className="text-xs" tick={{ fontSize: 10 }} />
              <YAxis className="text-xs" />
              <Tooltip />
              <Bar dataKey="active" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3">New Signups (14d)</h3>
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={signupVelocity || []}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="day" className="text-xs" tick={{ fontSize: 10 }} />
              <YAxis className="text-xs" />
              <Tooltip />
              <Line type="monotone" dataKey="signups" stroke="hsl(var(--chart-2, var(--primary)))" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* DB Table Stats */}
      <div>
        <h3 className="text-sm font-semibold mb-3">Database Table Sizes</h3>
        <ExecutiveDataTable
          data={tableStatsData}
          columns={tableStatsColumns}
          loading={!tableCounts}
          title="Table Row Counts"
        />
      </div>

      {/* System Event Log */}
      <div>
        <h3 className="text-sm font-semibold mb-3">System Event Log</h3>
        <ExecutiveDataTable
          data={systemEvents || []}
          columns={eventsColumns}
          loading={loadingEvents}
          title="System Events"
          filters={[{
            key: 'type',
            label: 'Type',
            options: [
              { value: 'error', label: 'Error' },
              { value: 'warning', label: 'Warning' },
              { value: 'info', label: 'Info' },
              { value: 'security', label: 'Security' },
            ],
          }]}
        />
      </div>
    </div>
  );
}
