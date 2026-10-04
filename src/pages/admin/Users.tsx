import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowLeft, Search, UserPlus, RefreshCw, Users, Printer, Home } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import RegisterEmployeeDialog from '@/components/admin/RegisterEmployeeDialog';
import UserDetailsDialog from '@/components/manager/UserDetailsDialog';
import JobApplicationsPanel from '@/components/admin/JobApplicationsPanel';
import ShareCareersLink from '@/components/admin/ShareCareersLink';
import CareersAnalyticsPanel from '@/components/admin/CareersAnalyticsPanel';

interface StaffUser {
  id: string;
  full_name: string;
  email: string;
  phone: string;
  avatar_url: string | null;
  created_at: string;
  verified: boolean;
  roles: string[];
  roleEnabledStatus: Record<string, boolean>;
  employee_id: string | null;
  department: string | null;
  position: string | null;
  // fields needed by UserDetailsDialog
  rent_discount_active: boolean;
  monthly_rent: number | null;
  average_rating: number | null;
  rating_count: number;
  country: string | null;
  city: string | null;
  country_code: string | null;
  subagent_count: number;
  last_active_at: string | null;
}

const STAFF_ROLES = ['manager', 'employee', 'operations', 'super_admin'];

const roleColors: Record<string, string> = {
  super_admin: 'bg-destructive/15 text-destructive border-destructive/30',
  manager: 'bg-primary/15 text-primary border-primary/30',
  employee: 'bg-muted text-muted-foreground border-border',
  operations: 'bg-accent/15 text-accent-foreground border-accent/30',
};

export default function AdminUsersPage() {
  const navigate = useNavigate();
  const { roles, role } = useAuth();
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [registerOpen, setRegisterOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<StaffUser | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);

  const canAccess = roles.some(r => ['super_admin', 'manager', 'cto'].includes(r));

  useEffect(() => {
    if (!canAccess) navigate(roleToSlug(role));
  }, [canAccess, navigate]);

  const fetchStaff = useCallback(async () => {
    setLoading(true);
    try {
      // Get user IDs with staff roles
      const { data: roleRows } = await supabase
        .from('user_roles')
        .select('user_id, role, enabled')
        .in('role', STAFF_ROLES as any);

      if (!roleRows || roleRows.length === 0) {
        setStaff([]);
        setLoading(false);
        return;
      }

      const staffUserIds = [...new Set(roleRows.map(r => r.user_id))];

      // Fetch profiles + staff_profiles in parallel
      const [profilesRes, staffProfilesRes] = await Promise.all([
        supabase.from('profiles').select('id, full_name, email, phone, avatar_url, created_at, verified, last_active_at').in('id', staffUserIds),
        supabase.from('staff_profiles').select('user_id, employee_id, department, position').in('user_id', staffUserIds),
      ]);

      const staffMap = new Map<string, { employee_id: string; department: string; position: string }>();
      staffProfilesRes.data?.forEach(sp => staffMap.set(sp.user_id, sp));

      const rolesMap = new Map<string, { roles: string[]; enabledMap: Record<string, boolean> }>();
      roleRows.forEach(r => {
        if (!rolesMap.has(r.user_id)) rolesMap.set(r.user_id, { roles: [], enabledMap: {} });
        const entry = rolesMap.get(r.user_id)!;
        entry.roles.push(r.role);
        entry.enabledMap[r.role] = r.enabled;
      });

      const users: StaffUser[] = (profilesRes.data || []).map(p => {
        const sp = staffMap.get(p.id);
        const rm = rolesMap.get(p.id);
        return {
          ...p,
          roles: rm?.roles || [],
          roleEnabledStatus: rm?.enabledMap || {},
          employee_id: sp?.employee_id || null,
          department: sp?.department || null,
          position: sp?.position || null,
          rent_discount_active: false,
          monthly_rent: null,
          average_rating: null,
          rating_count: 0,
          country: null,
          city: null,
          country_code: null,
          subagent_count: 0,
          last_active_at: p.last_active_at || null,
        };
      });

      setStaff(users);
    } catch (err) {
      console.error('Error fetching staff:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchStaff(); }, [fetchStaff]);

  const filtered = staff.filter(u => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      u.full_name?.toLowerCase().includes(q) ||
      u.email?.toLowerCase().includes(q) ||
      u.phone?.includes(q) ||
      u.employee_id?.toLowerCase().includes(q)
    );
  });

  const getStatusBadge = (u: StaffUser) => {
    if (!u.verified) return <Badge variant="outline" className="text-[10px] border-warning/40 text-warning">Pending</Badge>;
    return <Badge variant="outline" className="text-[10px] border-success/40 text-success">Active</Badge>;
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Print styles */}
      <style>{`
        @media print {
          body * { visibility: hidden; }
          .print-area, .print-area * { visibility: visible; }
          .print-area { position: absolute; left: 0; top: 0; width: 100%; }
          .no-print { display: none !important; }
          table { border-collapse: collapse; width: 100%; font-size: 11px; }
          th, td { border: 1px solid #ccc; padding: 6px 8px; text-align: left; }
          th { background: #f5f5f5; font-weight: 600; }
          .print-header { display: block !important; text-align: center; margin-bottom: 16px; }
          .print-header h1 { font-size: 18px; font-weight: bold; }
          .print-header p { font-size: 12px; color: #666; }
        }
      `}</style>

      {/* Header */}
      <div className="sticky top-0 z-40 bg-card border-b border-border safe-area-top no-print">
        <div className="flex items-center gap-3 px-4 py-3">
          <button onClick={() => navigate(roleToSlug(role))} className="p-1.5 rounded-lg hover:bg-muted transition-colors">
            <Home className="h-5 w-5 text-muted-foreground" />
          </button>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-foreground">Company Staff</h1>
            <p className="text-xs text-muted-foreground">{staff.length} staff member{staff.length !== 1 ? 's' : ''}</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => window.print()} className="gap-1.5 h-9">
            <Printer className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Print</span>
          </Button>
          <ShareCareersLink />
          <Button size="sm" onClick={() => setRegisterOpen(true)} className="gap-1.5 h-9">
            <UserPlus className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Register</span>
          </Button>
          <button onClick={fetchStaff} className="p-2 rounded-lg hover:bg-muted transition-colors">
            <RefreshCw className={cn("h-4 w-4 text-muted-foreground", loading && "animate-spin")} />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 pb-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, phone, or employee ID..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="pl-9 h-10"
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="px-4 py-4 print-area">
        {/* Priority: incoming job applications */}
        <JobApplicationsPanel />

        {/* Careers link share analytics (which platform drives sign-ups) */}
        <CareersAnalyticsPanel />

        {/* Print-only header */}
        <div className="hidden print-header">
          <h1>Welile Technologies — Company Staff List</h1>
          <p>Printed on {format(new Date(), 'dd MMMM yyyy, HH:mm')} · {filtered.length} staff members</p>
        </div>

        {loading ? (
          <div className="space-y-3 no-print">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-xl" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20">
            <Users className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
            <p className="font-semibold text-foreground">No staff found</p>
            <p className="text-sm text-muted-foreground mt-1">
              {search ? 'Try a different search term' : 'Register your first employee'}
            </p>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block border border-border rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/50 border-b border-border">
                      <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Employee ID</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Full Name</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Email</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Phone</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Role</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Department</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Status</th>
                      <th className="px-3 py-2.5 text-left font-semibold text-muted-foreground">Date Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map(u => (
                      <tr
                        key={u.id}
                        onClick={() => { setSelectedUser(u); setDetailOpen(true); }}
                        className="border-b border-border last:border-0 hover:bg-muted/30 transition-colors cursor-pointer"
                      >
                        <td className="px-3 py-2.5 font-mono text-xs font-medium">{u.employee_id || '—'}</td>
                        <td className="px-3 py-2.5 font-medium">{u.full_name}</td>
                        <td className="px-3 py-2.5 text-muted-foreground">{u.email}</td>
                        <td className="px-3 py-2.5 text-muted-foreground">{u.phone}</td>
                        <td className="px-3 py-2.5">
                          <div className="flex flex-wrap gap-1">
                            {u.roles.filter(r => STAFF_ROLES.includes(r)).map(r => (
                              <Badge key={r} variant="outline" className={cn('text-[10px] capitalize', roleColors[r] || '')}>
                                {r.replace('_', ' ')}
                              </Badge>
                            ))}
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-muted-foreground">{u.department || '—'}</td>
                        <td className="px-3 py-2.5">{getStatusBadge(u)}</td>
                        <td className="px-3 py-2.5 text-muted-foreground text-xs">{format(new Date(u.created_at), 'dd MMM yyyy')}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Mobile cards */}
            <div className="md:hidden space-y-2">
              {filtered.map(u => (
                <div
                  key={u.id}
                  onClick={() => { setSelectedUser(u); setDetailOpen(true); }}
                  className="border border-border rounded-xl p-3 bg-card active:bg-muted/50 transition-colors cursor-pointer"
                >
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-foreground truncate">{u.full_name}</p>
                      <p className="text-xs text-muted-foreground font-mono">{u.employee_id || 'No ID'}</p>
                    </div>
                    {getStatusBadge(u)}
                  </div>
                  <div className="flex flex-wrap gap-1 mb-2">
                    {u.roles.filter(r => STAFF_ROLES.includes(r)).map(r => (
                      <Badge key={r} variant="outline" className={cn('text-[10px] capitalize', roleColors[r] || '')}>
                        {r.replace('_', ' ')}
                      </Badge>
                    ))}
                  </div>
                  <div className="grid grid-cols-2 gap-1 text-xs text-muted-foreground">
                    <span className="truncate">{u.email}</span>
                    <span className="text-right">{u.department || '—'}</span>
                    <span>{u.phone}</span>
                    <span className="text-right">{format(new Date(u.created_at), 'dd MMM yy')}</span>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <RegisterEmployeeDialog open={registerOpen} onOpenChange={setRegisterOpen} onSuccess={fetchStaff} />
      <UserDetailsDialog
        open={detailOpen}
        onOpenChange={setDetailOpen}
        user={selectedUser}
        onRolesUpdated={fetchStaff}
        onUserDeleted={fetchStaff}
        onUserUpdated={fetchStaff}
      />
    </div>
  );
}
