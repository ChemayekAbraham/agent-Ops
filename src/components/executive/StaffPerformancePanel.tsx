import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { KPICard } from './KPICard';
import { Users, Trophy, AlertTriangle, Clock, Activity, CheckCircle } from 'lucide-react';
import { format, subDays, differenceInHours, differenceInDays } from 'date-fns';
import { cn } from '@/lib/utils';

interface StaffAction {
  user_id: string;
  action_type: string;
  created_at: string;
  metadata: any;
}

interface StaffMember {
  id: string;
  name: string;
  actions: number;
  lastActive: string | null;
  avgResponseHrs: number | null;
  depositsProcessed: number;
  payoutsProcessed: number;
  withdrawalsProcessed: number;
}

export function StaffPerformancePanel() {
  // Fetch audit logs for staff actions (last 30 days)
  const { data: auditLogs, isLoading: loadingLogs } = useQuery({
    queryKey: ['staff-perf-audit-logs'],
    queryFn: async () => {
      const since = subDays(new Date(), 30).toISOString();
      const { data } = await supabase
        .from('audit_logs')
        .select('user_id, action_type, created_at, metadata')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(200);
      return (data || []) as StaffAction[];
    },
    staleTime: 600000,
  });

  // Fetch staff profiles (managers, super_admins, employees, operations, C-level)
  const staffRoles = ['manager', 'super_admin', 'employee', 'operations', 'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm'];
  const { data: staffRoleMap } = useQuery({
    queryKey: ['staff-perf-roles'],
    queryFn: async () => {
      const { data } = await supabase
        .from('user_roles')
        .select('user_id, role')
        .eq('enabled', true)
        .in('role', staffRoles as any);
      const ids = [...new Set((data || []).map(r => r.user_id))];
      return ids;
    },
    staleTime: 600000,
  });

  const { data: staffProfiles } = useQuery({
    queryKey: ['staff-perf-profiles', (staffRoleMap || []).sort().join(',')],
    queryFn: async () => {
      if (!staffRoleMap?.length) return {};
      const { data } = await supabase.from('profiles').select('id, full_name').in('id', staffRoleMap.slice(0, 100));
      const map: Record<string, string> = {};
      (data || []).forEach(p => { map[p.id] = p.full_name || 'Unknown'; });
      return map;
    },
    enabled: (staffRoleMap || []).length > 0,
    staleTime: 600000,
  });

  // Fetch deposit processing stats
  const { data: depositStats } = useQuery({
    queryKey: ['staff-perf-deposits'],
    queryFn: async () => {
      const since = subDays(new Date(), 30).toISOString();
      const { data } = await supabase
        .from('deposit_requests')
        .select('processed_by, created_at, approved_at, status')
        .gte('created_at', since)
        .not('processed_by', 'is', null)
        .limit(500);
      return data || [];
    },
    staleTime: 600000,
  });

  // Fetch commission payout processing
  const { data: payoutStats } = useQuery({
    queryKey: ['staff-perf-payouts'],
    queryFn: async () => {
      const since = subDays(new Date(), 30).toISOString();
      const { data } = await supabase
        .from('agent_commission_payouts')
        .select('processed_by, requested_at, processed_at, status')
        .gte('created_at', since)
        .not('processed_by', 'is', null)
        .limit(500);
      return data || [];
    },
    staleTime: 600000,
  });

  // Fetch withdrawal processing
  const { data: withdrawalStats } = useQuery({
    queryKey: ['staff-perf-withdrawals'],
    queryFn: async () => {
      const since = subDays(new Date(), 30).toISOString();
      const { data } = await supabase
        .from('investment_withdrawal_requests')
        .select('processed_by, requested_at, processed_at, status')
        .gte('created_at', since)
        .not('processed_by', 'is', null)
        .limit(500);
      return data || [];
    },
    staleTime: 600000,
  });

  // Build staff members list
  const staffMembers: StaffMember[] = (() => {
    if (!staffProfiles || !auditLogs) return [];

    const memberMap: Record<string, StaffMember> = {};

    // Initialize from known staff
    Object.entries(staffProfiles).forEach(([id, name]) => {
      memberMap[id] = {
        id,
        name,
        actions: 0,
        lastActive: null,
        avgResponseHrs: null,
        depositsProcessed: 0,
        payoutsProcessed: 0,
        withdrawalsProcessed: 0,
      };
    });

    // Count audit log actions
    auditLogs.forEach(log => {
      if (!log.user_id || !memberMap[log.user_id]) return;
      memberMap[log.user_id].actions++;
      if (!memberMap[log.user_id].lastActive || log.created_at > memberMap[log.user_id].lastActive!) {
        memberMap[log.user_id].lastActive = log.created_at;
      }
    });

    // Count deposits processed
    (depositStats || []).forEach(d => {
      if (d.processed_by && memberMap[d.processed_by]) {
        memberMap[d.processed_by].depositsProcessed++;
      }
    });

    // Count payouts processed
    (payoutStats || []).forEach(p => {
      if (p.processed_by && memberMap[p.processed_by]) {
        memberMap[p.processed_by].payoutsProcessed++;
      }
    });

    // Count withdrawals processed
    (withdrawalStats || []).forEach(w => {
      if (w.processed_by && memberMap[w.processed_by]) {
        memberMap[w.processed_by].withdrawalsProcessed++;
      }
    });

    // Calculate avg response hours from deposits (created_at → approved_at)
    const responseByStaff: Record<string, number[]> = {};
    (depositStats || []).forEach(d => {
      if (d.processed_by && d.approved_at && d.created_at) {
        if (!responseByStaff[d.processed_by]) responseByStaff[d.processed_by] = [];
        responseByStaff[d.processed_by].push(
          differenceInHours(new Date(d.approved_at), new Date(d.created_at))
        );
      }
    });
    (payoutStats || []).forEach(p => {
      if (p.processed_by && p.processed_at && p.requested_at) {
        if (!responseByStaff[p.processed_by]) responseByStaff[p.processed_by] = [];
        responseByStaff[p.processed_by].push(
          differenceInHours(new Date(p.processed_at), new Date(p.requested_at))
        );
      }
    });

    Object.entries(responseByStaff).forEach(([id, hours]) => {
      if (memberMap[id] && hours.length > 0) {
        memberMap[id].avgResponseHrs = Math.round(hours.reduce((a, b) => a + b, 0) / hours.length);
      }
    });

    return Object.values(memberMap).sort((a, b) => b.actions - a.actions);
  })();

  const _totalActions = staffMembers.reduce((s, m) => s + m.actions, 0);
  const activeStaff = staffMembers.filter(m => m.actions > 0).length;
  const idleStaff = staffMembers.filter(m => {
    if (!m.lastActive) return true;
    return differenceInDays(new Date(), new Date(m.lastActive)) >= 3;
  });
  const avgSLA = (() => {
    const withSLA = staffMembers.filter(m => m.avgResponseHrs !== null);
    if (withSLA.length === 0) return null;
    return Math.round(withSLA.reduce((s, m) => s + (m.avgResponseHrs || 0), 0) / withSLA.length);
  })();

  const loading = loadingLogs;

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Staff Performance</h1>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPICard title="Total Staff" value={staffMembers.length} icon={Users} loading={loading} />
        <KPICard title="Active (30d)" value={activeStaff} icon={Activity} loading={loading} color="bg-green-500/10 text-green-600" />
        <KPICard 
          title="Idle (3d+)" 
          value={idleStaff.length} 
          icon={AlertTriangle} 
          loading={loading} 
          color={idleStaff.length > 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground'} 
        />
        <KPICard 
          title="Avg Response" 
          value={avgSLA !== null ? `${avgSLA}h` : '—'} 
          icon={Clock} 
          loading={loading} 
          color="bg-blue-500/10 text-blue-600" 
          subtitle="Approval SLA"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Leaderboard */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <Trophy className="h-4 w-4 text-amber-500" />
            Staff Leaderboard (30 Days)
          </h3>
          <div className="space-y-1.5 max-h-[360px] overflow-y-auto">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-12 bg-muted animate-pulse rounded-lg" />
              ))
            ) : staffMembers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No staff data available</p>
            ) : (
              staffMembers.slice(0, 15).map((member, i) => {
                const maxActions = staffMembers[0]?.actions || 1;
                const pct = Math.round((member.actions / maxActions) * 100);
                return (
                  <div key={member.id} className="flex items-center gap-3 p-2.5 rounded-lg hover:bg-muted/50 transition-colors">
                    <span className={cn(
                      "w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
                      i === 0 ? 'bg-amber-500/20 text-amber-600' :
                      i === 1 ? 'bg-slate-300/30 text-muted-foreground' :
                      i === 2 ? 'bg-orange-400/20 text-orange-600' :
                      'bg-muted text-muted-foreground'
                    )}>
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{member.name}</p>
                      <div className="flex items-center gap-2 mt-0.5">
                        <div className="h-1.5 flex-1 bg-muted rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-primary rounded-full transition-all" 
                            style={{ width: `${pct}%` }} 
                          />
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">{member.actions}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Activity Breakdown */}
        <div className="rounded-2xl border border-border bg-card p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <CheckCircle className="h-4 w-4 text-green-500" />
            Processing Breakdown (30 Days)
          </h3>
          <div className="space-y-1.5 max-h-[360px] overflow-y-auto">
            {loading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-14 bg-muted animate-pulse rounded-lg" />
              ))
            ) : staffMembers.filter(m => m.depositsProcessed + m.payoutsProcessed + m.withdrawalsProcessed > 0).length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No processing activity yet</p>
            ) : (
              staffMembers
                .filter(m => m.depositsProcessed + m.payoutsProcessed + m.withdrawalsProcessed > 0)
                .map((member) => (
                  <div key={member.id} className="p-2.5 rounded-lg hover:bg-muted/50 transition-colors">
                    <div className="flex items-center justify-between mb-1">
                      <p className="text-sm font-medium truncate">{member.name}</p>
                      {member.avgResponseHrs !== null && (
                        <span className={cn(
                          "text-[10px] font-medium px-1.5 py-0.5 rounded-full",
                          member.avgResponseHrs <= 24 ? 'bg-green-500/10 text-green-600' :
                          member.avgResponseHrs <= 48 ? 'bg-amber-500/10 text-amber-600' :
                          'bg-destructive/10 text-destructive'
                        )}>
                          ~{member.avgResponseHrs}h SLA
                        </span>
                      )}
                    </div>
                    <div className="flex gap-3 text-[11px] text-muted-foreground">
                      <span>📥 {member.depositsProcessed} deposits</span>
                      <span>💰 {member.payoutsProcessed} payouts</span>
                      <span>🏦 {member.withdrawalsProcessed} withdrawals</span>
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>
      </div>

      {/* Idle Staff Alert */}
      {idleStaff.length > 0 && (
        <div className="rounded-2xl border border-destructive/30 bg-destructive/5 p-4">
          <h3 className="text-sm font-semibold mb-2 flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-4 w-4" />
            Idle Staff — No Activity in 3+ Days
          </h3>
          <div className="flex flex-wrap gap-2">
            {idleStaff.map(member => (
              <div key={member.id} className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-background border border-border text-sm">
                <span className="font-medium">{member.name}</span>
                <span className="text-[10px] text-muted-foreground">
                  {member.lastActive 
                    ? `Last: ${format(new Date(member.lastActive), 'dd MMM')}`
                    : 'Never active'
                  }
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
