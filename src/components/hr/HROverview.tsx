import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import {
  Users, CalendarDays, Banknote, AlertTriangle, UserCog, ClipboardList,
  FileText, TrendingUp, Activity, ChevronRight, Building2
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { motion } from 'framer-motion';
import MyModuleSummary from '@/hr/components/MyModuleSummary';

import type { AppRole } from '@/hooks/auth/types';

const INTERNAL_ROLES: AppRole[] = ['manager', 'super_admin', 'employee', 'operations', 'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'hr'];

interface HROverviewProps {
  onNavigate?: (section: string) => void;
}

export default function HROverview({ onNavigate }: HROverviewProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const handleNav = (id: string) => {
    if (id === 'employees') {
      navigate('/hr/people');
    } else if (id === 'user-management') {
      navigate('/platform-users');
    } else if (id === 'payroll') {
      navigate('/hr/pay/runs');
    } else {
      onNavigate?.(id);
    }
  };
  const { data: staffCount = 0 } = useQuery({
    queryKey: ['hr-staff-count'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_active_employee_staff_count');
      if (error) throw new Error(error.message);
      return Number(data ?? 0);
    },
  });

  useEffect(() => {
    const channel = supabase
      .channel('hr-active-employee-role-count')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'user_roles', filter: 'role=eq.employee' },
        () => {
          void queryClient.invalidateQueries({ queryKey: ['hr-staff-count'] });
          void queryClient.invalidateQueries({ queryKey: ['hr-role-breakdown'] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const { data: pendingLeave = 0 } = useQuery({
    queryKey: ['hr-pending-leave'],
    queryFn: async () => {
      const { count } = await supabase
        .from('leave_requests')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'pending');
      return count || 0;
    },
  });

  const { data: activeDisciplinary = 0 } = useQuery({
    queryKey: ['hr-active-disciplinary'],
    queryFn: async () => {
      const { count } = await supabase
        .from('disciplinary_records')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'active');
      return count || 0;
    },
  });

  const { data: deptsStaffed = { count: 0, asOf: null as string | null } } = useQuery({
    queryKey: ['hr-departments-staffed'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('hr_metric_snapshots')
        .select('inputs_snapshot, period_end')
        .eq('subject_kind', 'org')
        .eq('metric_key', 'headcount')
        .order('period_start', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(error.message);
      const snap = data?.inputs_snapshot as { departments_staffed?: number; as_of?: string } | null;
      return {
        count: Number(snap?.departments_staffed ?? 0),
        asOf: (snap?.as_of ?? data?.period_end ?? null) as string | null,
      };
    },
  });

  const { data: deptTotal = 0 } = useQuery({
    queryKey: ['hr-departments-total'],
    queryFn: async () => {
      const { count } = await supabase
        .from('hr_departments')
        .select('*', { count: 'exact', head: true });
      return count || 0;
    },
  });

  const deptsStale = deptsStaffed.asOf
    ? deptsStaffed.asOf.slice(0, 7) !== new Date().toISOString().slice(0, 7)
    : false;

  const { data: openPayRuns = 0 } = useQuery({
    queryKey: ['hr-open-pay-runs'],
    queryFn: async () => {
      const { count } = await supabase
        .from('hr_pay_runs')
        .select('*', { count: 'exact', head: true })
        .not('status', 'in', '("paid","cancelled")');
      return count || 0;
    },
  });

  const { data: roleCounts = [] } = useQuery({
    queryKey: ['hr-role-breakdown'],
    queryFn: async () => {
      const { data } = await supabase
        .from('user_roles')
        .select('role')
        .in('role', INTERNAL_ROLES as any)
        .eq('enabled', true);
      if (!data) return [];
      const counts: Record<string, number> = {};
      data.forEach((r: any) => { counts[r.role] = (counts[r.role] || 0) + 1; });
      return Object.entries(counts)
        .map(([role, count]) => ({ role, count }))
        .sort((a, b) => b.count - a.count);
    },
  });

  const { data: recentEvents = [] } = useQuery({
    queryKey: ['hr-recent-events'],
    queryFn: async () => {
      const { data } = await supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(8);
      return data || [];
    },
  });

  const kpis = [
    { label: 'Staff Members', value: staffCount, icon: Users, color: 'bg-primary/10 text-primary' },
    { label: 'Pending Leave', value: pendingLeave, icon: CalendarDays, color: 'bg-warning/10 text-warning', alert: pendingLeave > 0 },
    { label: 'Active Cases', value: activeDisciplinary, icon: AlertTriangle, color: 'bg-destructive/10 text-destructive', alert: activeDisciplinary > 0 },
    { label: 'Departments Staffed', value: deptTotal > 0 ? `${deptsStaffed.count} of ${deptTotal}` : deptsStaffed.count, icon: Building2, color: 'bg-accent/50 text-accent-foreground', alert: deptsStale },
  ];

  const quickNavItems = [
    { id: 'employees', label: 'Employee Directory', icon: Users, description: 'View & manage staff', badge: staffCount, color: 'text-primary' },
    { id: 'user-management', label: 'User Management', icon: UserCog, description: 'Roles & permissions', color: 'text-accent-foreground' },
    { id: 'leave', label: 'Leave Requests', icon: CalendarDays, description: 'Approve / reject', badge: pendingLeave, color: 'text-warning' },
    { id: 'payroll', label: 'Payroll', icon: Banknote, description: 'Batches & salaries', badge: openPayRuns, color: 'text-success' },
    { id: 'disciplinary', label: 'Disciplinary', icon: AlertTriangle, description: 'Warnings & actions', badge: activeDisciplinary, color: 'text-destructive' },
    { id: 'audit', label: 'Audit Trail', icon: FileText, description: 'Activity logs', color: 'text-muted-foreground' },
  ];

  const container = {
    hidden: { opacity: 0 },
    show: { opacity: 1, transition: { staggerChildren: 0.04 } },
  };
  const item = {
    hidden: { opacity: 0, y: 8 },
    show: { opacity: 1, y: 0 },
  };

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h2 className="text-xl font-bold text-foreground">HR Command Center</h2>
        <p className="text-xs text-muted-foreground mt-0.5">People operations at a glance</p>
      </div>

      {/* Signed-in staff member's own figures, pulled from each sidebar tab */}
      <MyModuleSummary />

      {/* KPI Cards */}
      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="grid grid-cols-2 gap-2.5"
      >
        {kpis.map((kpi) => (
          <motion.div key={kpi.label} variants={item}>
            <Card className="border-border/40 overflow-hidden">
              <CardContent className="p-3.5">
                <div className="flex items-center gap-2.5">
                  <div className={`p-2 rounded-lg ${kpi.color}`}>
                    <kpi.icon className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">{kpi.label}</p>
                    <div className="flex items-baseline gap-1.5">
                      <p className="text-2xl font-bold text-foreground">{kpi.value}</p>
                      {kpi.alert && (
                        <span className="inline-block w-2 h-2 rounded-full bg-destructive animate-pulse" />
                      )}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </motion.div>

      {/* Quick Nav Grid */}
      <div>
        <p className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider px-0.5 mb-2">Quick Actions</p>
        <motion.div
          variants={container}
          initial="hidden"
          animate="show"
          className="grid grid-cols-2 gap-2"
        >
          {quickNavItems.map((nav) => (
            <motion.div key={nav.id} variants={item}>
              <button
                onClick={() => handleNav(nav.id)}
                className="w-full text-left rounded-xl border border-border/50 bg-card hover:bg-muted/40 p-3.5 transition-all active:scale-[0.97] touch-manipulation group"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className={`p-1.5 rounded-lg bg-muted/50 group-hover:bg-muted ${nav.color}`}>
                    <nav.icon className="h-4 w-4" />
                  </div>
                  {nav.badge !== undefined && nav.badge > 0 && (
                    <Badge variant="secondary" className="text-[10px] h-5 px-1.5 bg-primary/10 text-primary">
                      {nav.badge}
                    </Badge>
                  )}
                </div>
                <p className="text-sm font-semibold text-foreground leading-tight">{nav.label}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">{nav.description}</p>
              </button>
            </motion.div>
          ))}
        </motion.div>
      </div>

      {/* Role Breakdown */}
      {roleCounts.length > 0 && (() => {
        const totalAssigned = roleCounts.reduce((sum: number, rc: any) => sum + rc.count, 0);
        return (
        <Card className="border-border/40">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-3">
              <p className="text-sm font-semibold text-foreground">Role Distribution</p>
              <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
            <div className="space-y-2">
              {roleCounts.map((rc) => {
                const pct = totalAssigned > 0 ? (rc.count / totalAssigned) * 100 : 0;
                return (
                  <div key={rc.role} className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground w-20 capitalize truncate">{rc.role.replace('_', ' ')}</span>
                    <div className="flex-1 h-2 bg-muted/50 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary/60 rounded-full transition-all duration-500"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs font-semibold text-foreground w-6 text-right">{rc.count}</span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
        );
      })()}

      {/* Recent Activity */}
      <Card className="border-border/40">
        <CardContent className="p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="text-sm font-semibold text-foreground">Recent Activity</p>
            <button
              onClick={() => onNavigate?.('audit')}
              className="text-[10px] text-primary font-medium flex items-center gap-0.5 hover:underline"
            >
              View all <ChevronRight className="h-3 w-3" />
            </button>
          </div>
          {recentEvents.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4 text-center">No recent activity</p>
          ) : (
            <div className="space-y-1.5">
              {recentEvents.map((event: any) => (
                <div key={event.id} className="flex items-center gap-2.5 py-1.5 border-b border-border/20 last:border-0">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary/50 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-foreground truncate capitalize">
                      {(event.action_type as string).replace(/_/g, ' ')}
                    </p>
                  </div>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {new Date(event.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
