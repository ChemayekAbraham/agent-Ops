import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth, type AppRole } from '@/hooks/useAuth';
import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { UserAvatar } from '@/components/UserAvatar';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { ArrowLeft, Mail, Phone, Building2, Briefcase, IdCard, Shield, Plus, Clock, Wallet, CalendarDays, User, Activity, CheckCircle2, XCircle, Edit2, Snowflake } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';

const ALL_ROLES: AppRole[] = ['manager', 'super_admin', 'employee', 'operations', 'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'hr'];

const roleColors: Record<string, string> = {
  manager: 'bg-primary/15 text-primary border-primary/20',
  super_admin: 'bg-destructive/15 text-destructive border-destructive/20',
  ceo: 'bg-warning/15 text-warning border-warning/20',
  coo: 'bg-success/15 text-success border-success/20',
  cfo: 'bg-accent/40 text-accent-foreground border-accent/30',
  cto: 'bg-primary/15 text-primary border-primary/20',
  cmo: 'bg-warning/15 text-warning border-warning/20',
  crm: 'bg-muted text-muted-foreground border-border',
  hr: 'bg-primary/10 text-primary border-primary/15',
  employee: 'bg-muted text-muted-foreground border-border',
  operations: 'bg-success/15 text-success border-success/20',
};

interface RoleRecord { id: string; role: string; enabled: boolean; }

function DetailRow({ label, value, icon: Icon }: { label: string; value: string; icon?: any }) {
  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border/30 last:border-0">
      {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />}
      <div className="flex-1 min-w-0">
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="text-sm font-medium text-foreground mt-0.5 truncate">{value || '—'}</p>
      </div>
    </div>
  );
}

export default function HREmployeeProfile() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('overview');
  const [addRoleDialog, setAddRoleDialog] = useState(false);
  const [newRole, setNewRole] = useState<string>('employee');
  const [auditReason, setAuditReason] = useState('');
  const [toggleTarget, setToggleTarget] = useState<RoleRecord | null>(null);
  const [toggleReason, setToggleReason] = useState('');

  // Edit state
  const [editDialog, setEditDialog] = useState(false);
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [editDept, setEditDept] = useState('');
  const [editPosition, setEditPosition] = useState('');
  const [editReason, setEditReason] = useState('');

  // Freeze state
  const [freezeDialog, setFreezeDialog] = useState(false);
  const [freezeReason, setFreezeReason] = useState('');

  const { data: employee, isLoading } = useQuery({
    queryKey: ['hr-employee-profile', userId],
    enabled: !!userId,
    queryFn: async () => {
      const [{ data: roleData }, { data: profile }, { data: staffProfile }] = await Promise.all([
        supabase.from('user_roles').select('id, user_id, role, enabled').eq('user_id', userId!),
        supabase.from('profiles').select('*').eq('id', userId!).maybeSingle(),
        supabase.from('staff_profiles').select('*').eq('user_id', userId!).maybeSingle(),
      ]);
      const roles = (roleData || []).map((r: any) => r.role);
      const roleRecords = (roleData || []).map((r: any) => ({ id: r.id, role: r.role, enabled: r.enabled }));
      const enabled = roleRecords.length > 0 ? roleRecords.some(r => r.enabled) : true;
      return { user_id: userId!, roles, roleRecords, enabled, profile, staffProfile };
    },
  });

  const { data: roleHistory = [] } = useQuery({
    queryKey: ['hr-role-history', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data } = await supabase.from('audit_logs').select('*').eq('record_id', userId!)
        .in('action_type', ['hr_role_assigned', 'hr_role_toggled', 'hr_role_removed', 'role_assigned', 'role_toggled'])
        .order('created_at', { ascending: false }).limit(50);
      return data || [];
    },
  });

  const { data: leaveRequests = [] } = useQuery({
    queryKey: ['hr-employee-leaves', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data } = await supabase.from('leave_requests').select('*').eq('employee_id', userId!)
        .order('created_at', { ascending: false }).limit(30);
      return data || [];
    },
  });

  const { data: payrollItems = [] } = useQuery({
    queryKey: ['hr-employee-payroll', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data } = await supabase.from('payroll_items').select('*, batch:payroll_batches(batch_month, status)')
        .eq('employee_id', userId!).order('created_at', { ascending: false }).limit(50);
      return data || [];
    },
  });

  const { data: auditLogs = [] } = useQuery({
    queryKey: ['hr-employee-audit', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data } = await supabase.from('audit_logs').select('*').eq('record_id', userId!)
        .order('created_at', { ascending: false }).limit(50);
      return data || [];
    },
  });

  // hr_departments is the authoritative department directory (the legacy
  // `departments` table only ever held a single seed row).
  const { data: departments = [] } = useQuery({
    queryKey: ['hr-departments-list'],
    queryFn: async () => {
      const { data } = await supabase.from('hr_departments').select('name').eq('active', true).order('name');
      return (data || []).map((d: any) => d.name);
    },
  });

  const assignRoleMutation = useMutation({
    mutationFn: async () => {
      if (!userId || !user) throw new Error('No user selected');
      if (auditReason.length < 10) throw new Error('Audit reason must be at least 10 characters');
      const { error } = await supabase.from('user_roles').insert({ user_id: userId, role: newRole as any });
      if (error) throw error;
      await supabase.from('audit_logs').insert({
        user_id: user.id, action_type: 'hr_role_assigned', record_id: userId, table_name: 'user_roles',
        metadata: { role: newRole, reason: auditReason, assigned_by: user.id },
      });
    },
    onSuccess: () => {
      toast.success(`Role "${newRole}" assigned`);
      setAddRoleDialog(false); setAuditReason('');
      queryClient.invalidateQueries({ queryKey: ['hr-employee-profile', userId] });
      queryClient.invalidateQueries({ queryKey: ['hr-role-history', userId] });
    },
    onError: (err: any) => toast.error(err.message),
  });

  const toggleRoleMutation = useMutation({
    mutationFn: async () => {
      if (!toggleTarget || !user || !userId) throw new Error('No target');
      if (toggleReason.length < 10) throw new Error('Audit reason must be at least 10 characters');
      const { error } = await supabase.from('user_roles').update({ enabled: !toggleTarget.enabled }).eq('id', toggleTarget.id);
      if (error) throw error;
      await supabase.from('audit_logs').insert({
        user_id: user.id, action_type: 'hr_role_toggled', record_id: userId, table_name: 'user_roles',
        metadata: { role: toggleTarget.role, new_status: !toggleTarget.enabled ? 'enabled' : 'disabled', reason: toggleReason, toggled_by: user.id },
      });
    },
    onSuccess: () => {
      toast.success('Role status updated');
      setToggleTarget(null); setToggleReason('');
      queryClient.invalidateQueries({ queryKey: ['hr-employee-profile', userId] });
      queryClient.invalidateQueries({ queryKey: ['hr-role-history', userId] });
    },
    onError: (err: any) => toast.error(err.message),
  });

  // Edit employee mutation
  const editMutation = useMutation({
    mutationFn: async () => {
      if (!userId || !user) throw new Error('Missing data');
      if (editReason.length < 10) throw new Error('Audit reason must be at least 10 characters');

      // Update profile
      const profileUpdate: any = {};
      if (editName.trim()) profileUpdate.full_name = editName.trim();
      if (editPhone.trim()) profileUpdate.phone = editPhone.trim();

      if (Object.keys(profileUpdate).length > 0) {
        const { error } = await supabase.from('profiles').update(profileUpdate).eq('id', userId);
        if (error) throw error;
      }

      // Update staff profile
      if (editDept || editPosition) {
        const staffUpdate: any = {};
        if (editDept) staffUpdate.department = editDept;
        if (editPosition.trim()) staffUpdate.position = editPosition.trim();

        if (employee?.staffProfile) {
          const { error } = await supabase.from('staff_profiles').update(staffUpdate).eq('user_id', userId);
          if (error) throw error;
        }
      }

      await supabase.from('audit_logs').insert({
        user_id: user.id, action_type: 'hr_employee_edited', record_id: userId, table_name: 'profiles',
        metadata: { changes: { ...profileUpdate, department: editDept || undefined, position: editPosition || undefined }, reason: editReason },
      });
    },
    onSuccess: () => {
      toast.success('Employee information updated');
      setEditDialog(false); setEditReason('');
      queryClient.invalidateQueries({ queryKey: ['hr-employee-profile', userId] });
    },
    onError: (err: any) => toast.error(err.message),
  });

  // Freeze/unfreeze mutation
  const freezeMutation = useMutation({
    mutationFn: async () => {
      if (!userId || !user) throw new Error('Missing data');
      if (freezeReason.length < 10) throw new Error('Audit reason must be at least 10 characters');
      const newFrozen = !employee?.profile?.is_frozen;

      const { error } = await supabase.from('profiles').update({
        is_frozen: newFrozen,
        frozen_reason: newFrozen ? freezeReason : null,
      }).eq('id', userId);
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        user_id: user.id, action_type: newFrozen ? 'hr_account_frozen' : 'hr_account_unfrozen',
        record_id: userId, table_name: 'profiles',
        metadata: { reason: freezeReason },
      });
    },
    onSuccess: () => {
      toast.success(employee?.profile?.is_frozen ? 'Account unfrozen' : 'Account frozen');
      setFreezeDialog(false); setFreezeReason('');
      queryClient.invalidateQueries({ queryKey: ['hr-employee-profile', userId] });
    },
    onError: (err: any) => toast.error(err.message),
  });

  const openEditDialog = () => {
    setEditName(employee?.profile?.full_name || '');
    setEditPhone(employee?.profile?.phone || '');
    setEditDept(employee?.staffProfile?.department || '');
    setEditPosition(employee?.staffProfile?.position || '');
    setEditReason('');
    setEditDialog(true);
  };

  const existingRoles = employee?.roleRecords.map(r => r.role) || [];
  const availableRoles = ALL_ROLES.filter(r => !existingRoles.includes(r));
  const approvedLeaves = leaveRequests.filter((l: any) => l.status === 'approved').length;
  const pendingLeaves = leaveRequests.filter((l: any) => l.status === 'pending').length;
  const totalPayroll = payrollItems.reduce((s: number, p: any) => s + Number(p.amount || 0), 0);

  return (
    <ExecutiveDashboardLayout role="hr" activeTab="employees" onTabChange={() => {}}>
      <div className="space-y-5">
        <Button variant="ghost" size="sm" onClick={() => navigate('/hr/dashboard')} className="gap-1.5 text-muted-foreground -ml-2">
          <ArrowLeft className="h-4 w-4" /> Back to Directory
        </Button>

        {isLoading ? (
          <div className="space-y-4">
            <div className="h-36 rounded-xl bg-muted/30 animate-pulse" />
            <div className="h-10 rounded-lg bg-muted/30 animate-pulse w-1/2" />
            <div className="h-64 rounded-xl bg-muted/30 animate-pulse" />
          </div>
        ) : !employee ? (
          <div className="text-center py-20">
            <User className="h-12 w-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-sm font-medium text-muted-foreground">Employee not found</p>
          </div>
        ) : (
          <>
            {/* Profile Header */}
            <Card className={cn("border-border/40 overflow-hidden", employee.profile?.is_frozen && "border-destructive/40")}>
              <div className={cn("h-16 bg-gradient-to-r from-primary/20 via-primary/10 to-transparent", employee.profile?.is_frozen && "from-destructive/20 via-destructive/10")} />
              <CardContent className="px-5 pb-5 -mt-8">
                <div className="flex flex-col sm:flex-row gap-4">
                  <div className="shrink-0">
                    <div className="rounded-full border-4 border-background">
                      <UserAvatar avatarUrl={employee.profile?.avatar_url} fullName={employee.profile?.full_name} size="lg" />
                    </div>
                  </div>
                  <div className="flex-1 min-w-0 pt-2">
                    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                      <div>
                        <h1 className="text-xl font-bold text-foreground">{employee.profile?.full_name || 'Unknown'}</h1>
                        <p className="text-sm text-muted-foreground mt-0.5">{employee.staffProfile?.position || 'No position'} · {employee.staffProfile?.department || 'No department'}</p>
                        <div className="flex flex-wrap gap-1.5 mt-2">
                          {employee.roleRecords.map(rr => (
                            <Badge key={rr.id} variant="outline" className={cn("text-[10px] capitalize", roleColors[rr.role] || '')}>
                              {rr.role.replace('_', ' ')} {!rr.enabled && '(off)'}
                            </Badge>
                          ))}
                          <Badge variant={employee.enabled ? 'default' : 'destructive'} className="text-[10px]">
                            {employee.enabled ? 'Active' : 'Disabled'}
                          </Badge>
                          {employee.profile?.is_frozen && (
                            <Badge variant="destructive" className="text-[10px] gap-1"><Snowflake className="h-3 w-3" /> Frozen</Badge>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={openEditDialog}>
                          <Edit2 className="h-3 w-3" /> Edit
                        </Button>
                        <Button size="sm" variant="outline" className="h-8 text-xs gap-1" onClick={() => setAddRoleDialog(true)} disabled={availableRoles.length === 0}>
                          <Plus className="h-3 w-3" /> Add Role
                        </Button>
                        <Button size="sm" variant={employee.profile?.is_frozen ? 'default' : 'destructive'} className="h-8 text-xs gap-1" onClick={() => setFreezeDialog(true)}>
                          <Snowflake className="h-3 w-3" /> {employee.profile?.is_frozen ? 'Unfreeze' : 'Freeze'}
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Quick Insight Cards */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              <Card className="border-border/40">
                <CardContent className="p-3.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Total Payroll</p>
                  <p className="text-lg font-bold mt-0.5">UGX {totalPayroll.toLocaleString()}</p>
                </CardContent>
              </Card>
              <Card className="border-border/40">
                <CardContent className="p-3.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Active Roles</p>
                  <p className="text-lg font-bold mt-0.5">{employee.roleRecords.filter(r => r.enabled).length} / {employee.roleRecords.length}</p>
                </CardContent>
              </Card>
              <Card className="border-border/40">
                <CardContent className="p-3.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Leaves Taken</p>
                  <p className="text-lg font-bold mt-0.5">{approvedLeaves}</p>
                  {pendingLeaves > 0 && <p className="text-[10px] text-warning">{pendingLeaves} pending</p>}
                </CardContent>
              </Card>
              <Card className="border-border/40">
                <CardContent className="p-3.5">
                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Audit Events</p>
                  <p className="text-lg font-bold mt-0.5">{auditLogs.length}</p>
                </CardContent>
              </Card>
            </div>

            {/* Tabs - removed Roles tab */}
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <div className="overflow-x-auto">
                <TabsList className="inline-flex w-auto min-w-full sm:min-w-0">
                  <TabsTrigger value="overview" className="gap-1 text-xs"><User className="h-3 w-3" /> Overview</TabsTrigger>
                  <TabsTrigger value="personal" className="gap-1 text-xs"><IdCard className="h-3 w-3" /> Personal</TabsTrigger>
                  <TabsTrigger value="employment" className="gap-1 text-xs"><Briefcase className="h-3 w-3" /> Employment</TabsTrigger>
                  <TabsTrigger value="payroll" className="gap-1 text-xs"><Wallet className="h-3 w-3" /> Payroll</TabsTrigger>
                  <TabsTrigger value="leaves" className="gap-1 text-xs"><CalendarDays className="h-3 w-3" /> Leaves</TabsTrigger>
                  <TabsTrigger value="audit" className="gap-1 text-xs"><Activity className="h-3 w-3" /> Activity</TabsTrigger>
                </TabsList>
              </div>

              {/* Overview */}
              <TabsContent value="overview" className="space-y-4 mt-4">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <Card className="border-border/40">
                    <CardHeader className="pb-2"><CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Contact Information</CardTitle></CardHeader>
                    <CardContent className="space-y-0">
                      <DetailRow label="Email" value={employee.profile?.email || ''} icon={Mail} />
                      <DetailRow label="Phone" value={employee.profile?.phone || ''} icon={Phone} />
                      <DetailRow label="Employee ID" value={employee.staffProfile?.employee_id || ''} icon={IdCard} />
                    </CardContent>
                  </Card>
                  <Card className="border-border/40">
                    <CardHeader className="pb-2"><CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Work Information</CardTitle></CardHeader>
                    <CardContent className="space-y-0">
                      <DetailRow label="Department" value={employee.staffProfile?.department || ''} icon={Building2} />
                      <DetailRow label="Position" value={employee.staffProfile?.position || ''} icon={Briefcase} />
                      <DetailRow label="Verified" value={employee.profile?.verified ? 'Yes' : 'No'} icon={CheckCircle2} />
                    </CardContent>
                  </Card>
                </div>

                {/* Recent activity */}
                <Card className="border-border/40">
                  <CardHeader className="pb-2"><CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Recent Activity</CardTitle></CardHeader>
                  <CardContent>
                    {auditLogs.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-4 text-center">No recent activity</p>
                    ) : (
                      <div className="space-y-2">
                        {auditLogs.slice(0, 5).map((log: any) => (
                          <div key={log.id} className="flex items-start gap-2.5 text-xs">
                            <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <span className="font-medium capitalize">{log.action_type.replace(/_/g, ' ')}</span>
                              {log.metadata?.reason && <span className="text-muted-foreground ml-1">— {log.metadata.reason}</span>}
                            </div>
                            <span className="text-muted-foreground shrink-0">{format(new Date(log.created_at), 'dd MMM HH:mm')}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Personal */}
              <TabsContent value="personal" className="space-y-4 mt-4">
                <Card className="border-border/40">
                  <CardHeader><CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Personal Details</CardTitle></CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-0">
                      <DetailRow label="Full Name" value={employee.profile?.full_name || ''} icon={User} />
                      <DetailRow label="Email" value={employee.profile?.email || ''} icon={Mail} />
                      <DetailRow label="Phone" value={employee.profile?.phone || ''} icon={Phone} />
                      <DetailRow label="Verified" value={employee.profile?.verified ? 'Yes' : 'No'} icon={CheckCircle2} />
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Employment */}
              <TabsContent value="employment" className="space-y-4 mt-4">
                <Card className="border-border/40">
                  <CardHeader><CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Employment Details</CardTitle></CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-0">
                      <DetailRow label="Employee ID" value={employee.staffProfile?.employee_id || ''} icon={IdCard} />
                      <DetailRow label="Department" value={employee.staffProfile?.department || ''} icon={Building2} />
                      <DetailRow label="Position" value={employee.staffProfile?.position || ''} icon={Briefcase} />
                      <DetailRow label="Status" value={employee.enabled ? 'Active' : 'Disabled'} icon={employee.enabled ? CheckCircle2 : XCircle} />
                    </div>
                  </CardContent>
                </Card>

                <Card className="border-border/40">
                  <CardHeader><CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Role History</CardTitle></CardHeader>
                  <CardContent>
                    {roleHistory.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-4 text-center">No role changes recorded</p>
                    ) : (
                      <div className="space-y-2">
                        {roleHistory.map((log: any) => (
                          <div key={log.id} className="flex items-start gap-2.5 p-2.5 rounded-lg bg-muted/20 text-xs">
                            <Clock className="h-3 w-3 text-muted-foreground mt-0.5 shrink-0" />
                            <div className="flex-1">
                              <span className="font-medium capitalize">{log.action_type.replace(/_/g, ' ')}</span>
                              {log.metadata?.role && <span className="text-muted-foreground ml-1">({log.metadata.role})</span>}
                              {log.metadata?.reason && <p className="text-muted-foreground italic mt-0.5">"{log.metadata.reason}"</p>}
                            </div>
                            <span className="text-muted-foreground shrink-0">{format(new Date(log.created_at), 'dd MMM yyyy')}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Payroll - now shows payroll_items not earnings */}
              <TabsContent value="payroll" className="space-y-4 mt-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Card className="border-border/40">
                    <CardContent className="p-3.5">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Total Payroll</p>
                      <p className="text-lg font-bold mt-0.5">UGX {totalPayroll.toLocaleString()}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/40">
                    <CardContent className="p-3.5">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Entries</p>
                      <p className="text-lg font-bold mt-0.5">{payrollItems.length}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/40">
                    <CardContent className="p-3.5">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Paid</p>
                      <p className="text-lg font-bold text-success mt-0.5">{payrollItems.filter((p: any) => p.status === 'paid').length}</p>
                    </CardContent>
                  </Card>
                </div>

                <Card className="border-border/40">
                  <CardHeader><CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Payroll History</CardTitle></CardHeader>
                  <CardContent>
                    {payrollItems.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-6 text-center">No payroll records</p>
                    ) : (
                      <div className="rounded-lg border border-border overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-muted/30 hover:bg-muted/30">
                              <TableHead className="text-xs">Batch</TableHead>
                              <TableHead className="text-xs">Category</TableHead>
                              <TableHead className="text-xs">Description</TableHead>
                              <TableHead className="text-xs text-right">Amount</TableHead>
                              <TableHead className="text-xs">Status</TableHead>
                              <TableHead className="text-xs text-right">Date</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {payrollItems.map((p: any) => (
                              <TableRow key={p.id}>
                                <TableCell className="text-xs font-medium">{p.batch?.batch_month || '—'}</TableCell>
                                <TableCell className="text-xs capitalize">{p.category}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">{p.description || '—'}</TableCell>
                                <TableCell className="text-xs font-semibold text-right">UGX {Number(p.amount).toLocaleString()}</TableCell>
                                <TableCell>
                                  <Badge variant={p.status === 'paid' ? 'default' : p.status === 'failed' ? 'destructive' : 'secondary'} className="text-[10px]">{p.status}</Badge>
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground text-right">{format(new Date(p.created_at), 'dd MMM yyyy')}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Leaves */}
              <TabsContent value="leaves" className="space-y-4 mt-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Card className="border-border/40">
                    <CardContent className="p-3.5">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Total Requests</p>
                      <p className="text-lg font-bold mt-0.5">{leaveRequests.length}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/40">
                    <CardContent className="p-3.5">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Approved</p>
                      <p className="text-lg font-bold text-success mt-0.5">{approvedLeaves}</p>
                    </CardContent>
                  </Card>
                  <Card className="border-border/40">
                    <CardContent className="p-3.5">
                      <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">Pending</p>
                      <p className="text-lg font-bold text-warning mt-0.5">{pendingLeaves}</p>
                    </CardContent>
                  </Card>
                </div>

                <Card className="border-border/40">
                  <CardHeader><CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Leave History</CardTitle></CardHeader>
                  <CardContent>
                    {leaveRequests.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-6 text-center">No leave requests</p>
                    ) : (
                      <div className="rounded-lg border border-border overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow className="bg-muted/30 hover:bg-muted/30">
                              <TableHead className="text-xs">Type</TableHead>
                              <TableHead className="text-xs">Period</TableHead>
                              <TableHead className="text-xs">Status</TableHead>
                              <TableHead className="text-xs text-right">Requested</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {leaveRequests.map((l: any) => (
                              <TableRow key={l.id}>
                                <TableCell className="text-xs font-medium capitalize">{l.leave_type?.replace(/_/g, ' ') || 'Leave'}</TableCell>
                                <TableCell className="text-xs text-muted-foreground">{l.start_date} → {l.end_date}</TableCell>
                                <TableCell>
                                  <Badge variant={l.status === 'approved' ? 'default' : l.status === 'rejected' ? 'destructive' : 'secondary'} className="text-[10px]">{l.status}</Badge>
                                </TableCell>
                                <TableCell className="text-xs text-muted-foreground text-right">{format(new Date(l.created_at), 'dd MMM yyyy')}</TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              {/* Activity / Audit */}
              <TabsContent value="audit" className="space-y-4 mt-4">
                <Card className="border-border/40">
                  <CardHeader><CardTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Activity Log</CardTitle></CardHeader>
                  <CardContent>
                    {auditLogs.length === 0 ? (
                      <p className="text-xs text-muted-foreground py-6 text-center">No activity recorded</p>
                    ) : (
                      <div className="space-y-0 max-h-[600px] overflow-y-auto">
                        {auditLogs.map((log: any, i: number) => (
                          <div key={log.id} className="flex items-start gap-3 py-3 border-b border-border/30 last:border-0">
                            <div className="flex flex-col items-center gap-1 pt-0.5">
                              <div className={cn("w-2 h-2 rounded-full shrink-0",
                                log.action_type.includes('assigned') ? 'bg-success' :
                                log.action_type.includes('toggled') ? 'bg-warning' :
                                log.action_type.includes('removed') || log.action_type.includes('deleted') || log.action_type.includes('frozen') ? 'bg-destructive' :
                                'bg-primary'
                              )} />
                              {i < auditLogs.length - 1 && <div className="w-px flex-1 bg-border/40 min-h-[20px]" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-xs font-medium capitalize">{log.action_type.replace(/_/g, ' ')}</span>
                                <span className="text-[10px] text-muted-foreground shrink-0">{format(new Date(log.created_at), 'dd MMM yyyy HH:mm')}</span>
                              </div>
                              {log.table_name && <p className="text-[10px] text-muted-foreground mt-0.5">Table: {log.table_name}</p>}
                              {log.metadata?.role && <p className="text-[10px] text-muted-foreground">Role: {log.metadata.role}</p>}
                              {log.metadata?.reason && <p className="text-[10px] text-muted-foreground italic mt-0.5">"{log.metadata.reason}"</p>}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>

      {/* Add Role Dialog */}
      <Dialog open={addRoleDialog} onOpenChange={setAddRoleDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Assign New Role</DialogTitle>
            <DialogDescription>Add a role to {employee?.profile?.full_name || 'this user'}. This action is audited.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Role</Label>
              <Select value={newRole} onValueChange={setNewRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {availableRoles.map(r => <SelectItem key={r} value={r} className="capitalize">{r.replace('_', ' ')}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Audit Reason <span className="text-muted-foreground">(min 10 chars)</span></Label>
              <Input value={auditReason} onChange={e => setAuditReason(e.target.value)} placeholder="Reason for assigning this role..." />
              <p className="text-[10px] text-muted-foreground mt-1">{auditReason.length}/10 characters</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddRoleDialog(false)}>Cancel</Button>
            <Button onClick={() => assignRoleMutation.mutate()} disabled={auditReason.length < 10 || assignRoleMutation.isPending}>
              {assignRoleMutation.isPending ? 'Assigning...' : 'Assign Role'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Toggle Role Dialog */}
      <Dialog open={!!toggleTarget} onOpenChange={() => setToggleTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{toggleTarget?.enabled ? 'Disable' : 'Enable'} Role: <span className="capitalize">{toggleTarget?.role?.replace('_', ' ')}</span></DialogTitle>
            <DialogDescription>This action will be logged in the audit trail.</DialogDescription>
          </DialogHeader>
          <div>
            <Label>Audit Reason <span className="text-muted-foreground">(min 10 chars)</span></Label>
            <Input value={toggleReason} onChange={e => setToggleReason(e.target.value)} placeholder="Reason for this change..." />
            <p className="text-[10px] text-muted-foreground mt-1">{toggleReason.length}/10 characters</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setToggleTarget(null); setToggleReason(''); }}>Cancel</Button>
            <Button variant={toggleTarget?.enabled ? 'destructive' : 'default'} onClick={() => toggleRoleMutation.mutate()} disabled={toggleReason.length < 10 || toggleRoleMutation.isPending}>
              {toggleRoleMutation.isPending ? 'Updating...' : toggleTarget?.enabled ? 'Disable Role' : 'Enable Role'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Employee Dialog */}
      <Dialog open={editDialog} onOpenChange={setEditDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Edit2 className="h-4 w-4" /> Edit Employee</DialogTitle>
            <DialogDescription>Update employee information. All changes are audited.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Full Name</Label>
              <Input value={editName} onChange={e => setEditName(e.target.value)} />
            </div>
            <div>
              <Label>Phone</Label>
              <Input value={editPhone} onChange={e => setEditPhone(e.target.value)} />
            </div>
            <div>
              <Label>Department</Label>
              <Select value={editDept} onValueChange={setEditDept}>
                <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
                <SelectContent>
                  {departments.map((d: string) => <SelectItem key={d} value={d}>{d}</SelectItem>)}
                  {editDept && !departments.includes(editDept) && <SelectItem value={editDept}>{editDept}</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Position</Label>
              <Input value={editPosition} onChange={e => setEditPosition(e.target.value)} />
            </div>
            <div>
              <Label>Audit Reason <span className="text-muted-foreground">(min 10 chars)</span></Label>
              <Textarea value={editReason} onChange={e => setEditReason(e.target.value)} placeholder="Why is this information being changed..." className="min-h-[60px] text-xs" />
              <p className="text-[10px] text-muted-foreground mt-1">{editReason.length}/10 characters</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialog(false)}>Cancel</Button>
            <Button onClick={() => editMutation.mutate()} disabled={editReason.length < 10 || editMutation.isPending}>
              {editMutation.isPending ? 'Saving...' : 'Save Changes'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Freeze/Unfreeze Dialog */}
      <Dialog open={freezeDialog} onOpenChange={setFreezeDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Snowflake className="h-4 w-4" />
              {employee?.profile?.is_frozen ? 'Unfreeze Account' : 'Freeze Account'}
            </DialogTitle>
            <DialogDescription>
              {employee?.profile?.is_frozen
                ? 'This will restore access for this user. The action is audited.'
                : 'This will block all platform access for this user. The action is audited.'
              }
            </DialogDescription>
          </DialogHeader>
          <div>
            <Label>Audit Reason <span className="text-muted-foreground">(min 10 chars)</span></Label>
            <Textarea value={freezeReason} onChange={e => setFreezeReason(e.target.value)} placeholder="Reason for freezing/unfreezing..." className="min-h-[60px] text-xs" />
            <p className="text-[10px] text-muted-foreground mt-1">{freezeReason.length}/10 characters</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setFreezeDialog(false); setFreezeReason(''); }}>Cancel</Button>
            <Button variant={employee?.profile?.is_frozen ? 'default' : 'destructive'} onClick={() => freezeMutation.mutate()} disabled={freezeReason.length < 10 || freezeMutation.isPending}>
              {freezeMutation.isPending ? 'Processing...' : employee?.profile?.is_frozen ? 'Unfreeze Account' : 'Freeze Account'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ExecutiveDashboardLayout>
  );
}
