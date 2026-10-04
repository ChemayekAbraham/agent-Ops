import { useState, useCallback, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogCancel,
  AlertDialogAction,
} from '@/components/ui/alert-dialog';
import { Search, ShieldCheck, UserCog, Plus, X, Loader2, ArrowLeft, Users, History, RefreshCw, ArrowRight } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import type { AppRole } from '@/hooks/auth/types';
import { roleLabels } from '@/components/layout/executiveSidebarConfig';

const ALL_ROLES: AppRole[] = [
  'tenant', 'agent', 'landlord', 'supporter',
  'manager', 'super_admin', 'employee', 'operations',
  'ceo', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'hr',
];

const roleColor = (r: string) => {
  if (r === 'super_admin' || r === 'ceo') return 'bg-destructive/15 text-destructive border-destructive/30';
  if (['manager', 'coo', 'cfo', 'cto', 'cmo', 'crm', 'hr', 'operations', 'employee'].includes(r))
    return 'bg-primary/15 text-primary border-primary/30';
  return 'bg-muted text-muted-foreground border-border';
};

interface FoundUser {
  id: string;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  avatar_url: string | null;
}

interface AuditEntry {
  id: string;
  action_type: string;
  created_at: string | null;
  actor_id: string | null;
  target_id: string | null;
  role: string | null;
  before: string[];
  after: string[];
  actorName: string;
  targetName: string;
}

interface PendingAction {
  type: 'add' | 'remove';
  role: AppRole;
  before: AppRole[];
  after: AppRole[];
}

export function RoleManagementPanel() {
  const { user } = useAuth();
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<FoundUser[]>([]);
  const [selected, setSelected] = useState<FoundUser | null>(null);
  const [userRoles, setUserRoles] = useState<AppRole[]>([]);
  const [loadingRoles, setLoadingRoles] = useState(false);
  const [busyRole, setBusyRole] = useState<AppRole | null>(null);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  const fetchAuditLog = useCallback(async () => {
    setLoadingAudit(true);
    try {
      const { data, error } = await supabase
        .from('audit_logs')
        .select('id, action_type, created_at, user_id, record_id, metadata')
        .in('action_type', ['role_added', 'role_removed'])
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      const rows = data || [];

      const ids = new Set<string>();
      rows.forEach(r => {
        if (r.user_id) ids.add(r.user_id);
        if (r.record_id) ids.add(r.record_id);
      });
      const nameMap = new Map<string, string>();
      if (ids.size > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', Array.from(ids));
        profs?.forEach(p => nameMap.set(p.id, p.full_name || 'Unnamed user'));
      }

      const entries: AuditEntry[] = rows.map(r => {
        const m = (r.metadata || {}) as Record<string, any>;
        return {
          id: r.id,
          action_type: r.action_type,
          created_at: r.created_at,
          actor_id: r.user_id,
          target_id: r.record_id,
          role: m.role ?? null,
          before: Array.isArray(m.before) ? m.before : [],
          after: Array.isArray(m.after) ? m.after : [],
          actorName: (r.user_id && nameMap.get(r.user_id)) || 'System',
          targetName: (r.record_id && nameMap.get(r.record_id)) || m.target_user || 'Unknown user',
        };
      });
      setAuditEntries(entries);
    } catch (err: any) {
      console.error('Fetch audit log error:', err);
    } finally {
      setLoadingAudit(false);
    }
  }, []);

  useEffect(() => { fetchAuditLog(); }, [fetchAuditLog]);

  const runSearch = useCallback(async (raw?: string, notifyEmpty = false) => {
    const q = (raw ?? query).trim();
    if (q.length < 2) { setResults([]); return; }
    setSearching(true);
    setSelected(null);
    try {
      const filters = [
        `full_name.ilike.%${q}%`,
        `email.ilike.%${q}%`,
        `phone.ilike.%${q}%`,
      ];
      // Phone-friendly matching: strip spaces, dashes, +, brackets and also try
      // the local form (drop a leading country code / leading zero) so "0772…",
      // "+256772…" and "772…" all find the same user.
      const digits = q.replace(/[^0-9]/g, '');
      if (digits.length >= 3) {
        filters.push(`phone.ilike.%${digits}%`);
        const local = digits.replace(/^(00?256|256|0)/, '');
        if (local && local !== digits) filters.push(`phone.ilike.%${local}%`);
      }
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, email, phone, avatar_url')
        .or(filters.join(','))
        .limit(25);
      if (error) throw error;
      setResults(data || []);
      if (notifyEmpty && (data || []).length === 0) toast.info('No users match that search');
    } catch (err: any) {
      console.error('User search error:', err);
      toast.error('Failed to search users');
    } finally {
      setSearching(false);
    }
  }, [query]);

  // Debounced live search as the CEO types (name or phone).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults([]); return; }
    const t = setTimeout(() => { runSearch(q); }, 300);
    return () => clearTimeout(t);
  }, [query, runSearch]);

  const loadRoles = useCallback(async (u: FoundUser) => {
    setSelected(u);
    setLoadingRoles(true);
    try {
      const { data, error } = await supabase
        .from('user_roles')
        .select('role')
        .eq('user_id', u.id);
      if (error) throw error;
      setUserRoles(((data || []).map(r => r.role)) as AppRole[]);
    } catch (err: any) {
      console.error('Load roles error:', err);
      toast.error('Failed to load roles');
      setUserRoles([]);
    } finally {
      setLoadingRoles(false);
    }
  }, []);

  const addRole = async (role: AppRole) => {
    if (!selected) return;
    setBusyRole(role);
    try {
      const before = [...userRoles];
      const after = [...userRoles, role];
      const { error } = await supabase
        .from('user_roles')
        .insert({ user_id: selected.id, role });
      if (error) {
        if (error.code === '23505') { toast.error('User already has this role'); return; }
        throw error;
      }
      setUserRoles(prev => [...prev, role]);
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'role_added',
        table_name: 'user_roles',
        record_id: selected.id,
        metadata: { role, target_user: selected.full_name, before, after, reason: 'CEO role grant' },
      });
      toast.success(`Added "${roleLabels[role]}" to ${selected.full_name || 'user'}`);
      fetchAuditLog();
    } catch (err: any) {
      console.error('Add role error:', err);
      toast.error('Failed to add role');
    } finally {
      setBusyRole(null);
    }
  };

  const removeRole = async (role: AppRole) => {
    if (!selected) return;
    if (userRoles.length <= 1) { toast.error('User must keep at least one role'); return; }
    setBusyRole(role);
    try {
      const before = [...userRoles];
      const after = userRoles.filter(r => r !== role);
      const { error } = await supabase
        .from('user_roles')
        .delete()
        .eq('user_id', selected.id)
        .eq('role', role);
      if (error) throw error;
      setUserRoles(prev => prev.filter(r => r !== role));
      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'role_removed',
        table_name: 'user_roles',
        record_id: selected.id,
        metadata: { role, target_user: selected.full_name, before, after, reason: 'CEO role revoke' },
      });
      toast.success(`Removed "${roleLabels[role]}" from ${selected.full_name || 'user'}`);
      fetchAuditLog();
    } catch (err: any) {
      console.error('Remove role error:', err);
      toast.error('Failed to remove role');
    } finally {
      setBusyRole(null);
    }
  };

  const availableToAdd = ALL_ROLES.filter(r => !userRoles.includes(r));

  const requestAdd = (role: AppRole) => {
    setConfirmed(false);
    setPending({ type: 'add', role, before: [...userRoles], after: [...userRoles, role] });
  };

  const requestRemove = (role: AppRole) => {
    if (userRoles.length <= 1) { toast.error('User must keep at least one role'); return; }
    setConfirmed(false);
    setPending({ type: 'remove', role, before: [...userRoles], after: userRoles.filter(r => r !== role) });
  };

  const confirmPending = async () => {
    if (!pending) return;
    const { type, role } = pending;
    setPending(null);
    setConfirmed(false);
    if (type === 'add') await addRole(role);
    else await removeRole(role);
  };

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="flex items-center gap-2">
        <div className="p-2 rounded-lg bg-primary/10">
          <ShieldCheck className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Role Management</h2>
          <p className="text-xs text-muted-foreground">Search any user, then add or remove their roles.</p>
        </div>
      </div>

      {!selected && (
        <>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or phone number…"
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') runSearch(query, true); }}
                className="pl-9 h-10"
                autoFocus
              />
            </div>
            <Button onClick={() => runSearch(query, true)} disabled={searching || query.trim().length < 2} className="h-10">
              {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Search'}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground -mt-1">Type at least 2 characters — results appear as you type.</p>

          {searching ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
            </div>
          ) : results.length > 0 ? (
            <div className="space-y-2">
              {results.map(u => (
                <button
                  key={u.id}
                  onClick={() => loadRoles(u)}
                  className="w-full text-left border border-border rounded-xl p-3 bg-card hover:border-primary hover:bg-primary/5 transition-colors flex items-center gap-3"
                >
                  <div className="h-9 w-9 rounded-full bg-secondary flex items-center justify-center shrink-0">
                    <UserCog className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-sm text-foreground truncate">{u.full_name || 'Unnamed user'}</p>
                    <p className="text-xs text-muted-foreground truncate">{[u.phone, u.email].filter(Boolean).join(' · ') || u.id}</p>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <Card className="p-8 text-center text-muted-foreground">
              <Users className="h-10 w-10 mx-auto mb-2 opacity-40" />
              <p className="text-sm">
                {query.trim().length >= 2
                  ? `No users match "${query.trim()}".`
                  : 'Start typing a name or phone number to find a user.'}
              </p>
            </Card>
          )}
        </>
      )}

      {selected && (
        <div className="space-y-4">
          <Button variant="ghost" size="sm" onClick={() => setSelected(null)} className="gap-1.5 -ml-2">
            <ArrowLeft className="h-4 w-4" /> Back to results
          </Button>

          <Card className="p-4">
            <div className="flex items-center gap-3">
              <div className="h-11 w-11 rounded-full bg-secondary flex items-center justify-center shrink-0">
                <UserCog className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="min-w-0">
                <p className="font-semibold text-foreground truncate">{selected.full_name || 'Unnamed user'}</p>
                <p className="text-xs text-muted-foreground truncate">{selected.email || selected.phone || selected.id}</p>
              </div>
            </div>
          </Card>

          <div>
            <p className="text-sm font-semibold text-foreground mb-2">Current roles</p>
            {loadingRoles ? (
              <Skeleton className="h-8 w-full rounded-lg" />
            ) : userRoles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No roles assigned.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {userRoles.map(r => (
                  <span key={r} className={cn('inline-flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-full border text-xs font-medium capitalize', roleColor(r))}>
                    {roleLabels[r] || r}
                    <button
                      onClick={() => requestRemove(r)}
                      disabled={busyRole === r || userRoles.length <= 1}
                      title="Remove role"
                      className="h-5 w-5 rounded-full inline-flex items-center justify-center hover:bg-background/60 disabled:opacity-40"
                    >
                      {busyRole === r ? <Loader2 className="h-3 w-3 animate-spin" /> : <X className="h-3 w-3" />}
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>

          <div>
            <p className="text-sm font-semibold text-foreground mb-2">Add a role</p>
            <div className="flex flex-wrap gap-2">
              {availableToAdd.map(r => (
                <Button
                  key={r}
                  variant="outline"
                  size="sm"
                  onClick={() => requestAdd(r)}
                  disabled={busyRole === r}
                  className="gap-1.5 h-8"
                >
                  {busyRole === r ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                  {roleLabels[r] || r}
                </Button>
              ))}
              {availableToAdd.length === 0 && (
                <p className="text-sm text-muted-foreground">User already has every role.</p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Audit log */}
      <div className="pt-2">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <History className="h-4 w-4 text-muted-foreground" />
            <p className="text-sm font-semibold text-foreground">Role change audit log</p>
          </div>
          <Button variant="ghost" size="sm" onClick={fetchAuditLog} disabled={loadingAudit} className="gap-1.5 h-8">
            <RefreshCw className={cn('h-3.5 w-3.5', loadingAudit && 'animate-spin')} />
            Refresh
          </Button>
        </div>

        {loadingAudit ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}
          </div>
        ) : auditEntries.length === 0 ? (
          <Card className="p-6 text-center text-muted-foreground">
            <History className="h-8 w-8 mx-auto mb-2 opacity-40" />
            <p className="text-sm">No role changes recorded yet.</p>
          </Card>
        ) : (
          <div className="space-y-2">
            {auditEntries.map(e => {
              const added = e.action_type === 'role_added';
              return (
                <Card key={e.id} className="p-3">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge
                        variant="outline"
                        className={cn('text-[10px] capitalize shrink-0',
                          added ? 'bg-success/15 text-success border-success/30' : 'bg-destructive/15 text-destructive border-destructive/30')}
                      >
                        {added ? 'Added' : 'Removed'} {e.role ? (roleLabels[e.role as AppRole] || e.role) : 'role'}
                      </Badge>
                      <span className="text-sm font-medium text-foreground truncate">{e.targetName}</span>
                    </div>
                    <span className="text-xs text-muted-foreground shrink-0">
                      {e.created_at ? format(new Date(e.created_at), 'dd MMM yyyy, HH:mm') : '—'}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">By {e.actorName}</p>
                  {(e.before.length > 0 || e.after.length > 0) && (
                    <div className="flex items-center gap-2 mt-2 text-[11px] flex-wrap">
                      <span className="text-muted-foreground">Before:</span>
                      {e.before.length ? e.before.map(r => (
                        <span key={`b-${r}`} className={cn('px-1.5 py-0.5 rounded border capitalize', roleColor(r))}>{roleLabels[r as AppRole] || r}</span>
                      )) : <span className="text-muted-foreground italic">none</span>}
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <span className="text-muted-foreground">After:</span>
                      {e.after.length ? e.after.map(r => (
                        <span key={`a-${r}`} className={cn('px-1.5 py-0.5 rounded border capitalize', roleColor(r))}>{roleLabels[r as AppRole] || r}</span>
                      )) : <span className="text-muted-foreground italic">none</span>}
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {/* Confirmation dialog */}
      <AlertDialog open={!!pending} onOpenChange={(o) => { if (!o) { setPending(null); setConfirmed(false); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.type === 'add' ? 'Add role' : 'Remove role'}
              {pending ? ` — ${roleLabels[pending.role] || pending.role}` : ''}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.type === 'add'
                ? `Grant the "${pending ? (roleLabels[pending.role] || pending.role) : ''}" role to ${selected?.full_name || 'this user'}.`
                : `Revoke the "${pending ? (roleLabels[pending.role] || pending.role) : ''}" role from ${selected?.full_name || 'this user'}.`}
              {' '}Review the exact before/after roles below and confirm they are correct.
            </AlertDialogDescription>
          </AlertDialogHeader>

          {pending && (
            <div className="space-y-3 py-1">
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-1.5">Before</p>
                <div className="flex flex-wrap gap-1.5">
                  {pending.before.length ? pending.before.map(r => (
                    <span key={`pb-${r}`} className={cn('px-2 py-0.5 rounded-full border text-xs capitalize', roleColor(r))}>{roleLabels[r] || r}</span>
                  )) : <span className="text-xs text-muted-foreground italic">none</span>}
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <ArrowRight className="h-4 w-4" />
                <span className="text-xs">changes to</span>
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-1.5">After</p>
                <div className="flex flex-wrap gap-1.5">
                  {pending.after.length ? pending.after.map(r => (
                    <span
                      key={`pa-${r}`}
                      className={cn('px-2 py-0.5 rounded-full border text-xs capitalize', roleColor(r),
                        pending.type === 'add' && r === pending.role && 'ring-2 ring-success/50')}
                    >
                      {roleLabels[r] || r}
                    </span>
                  )) : <span className="text-xs text-muted-foreground italic">none</span>}
                </div>
              </div>

              <label className="flex items-start gap-2 pt-1 cursor-pointer">
                <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} className="mt-0.5" />
                <span className="text-xs text-muted-foreground">
                  I confirm the before/after roles shown above are correct.
                </span>
              </label>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!confirmed}
              onClick={confirmPending}
              className={cn(pending?.type === 'remove' && 'bg-destructive text-destructive-foreground hover:bg-destructive/90')}
            >
              {pending?.type === 'add' ? 'Add role' : 'Remove role'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
