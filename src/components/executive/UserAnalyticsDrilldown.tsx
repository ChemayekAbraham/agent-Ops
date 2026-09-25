import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Search, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';

export type DrilldownScope =
  | { kind: 'signups'; start: string; end: string }
  | { kind: 'dau'; start: string; end: string }
  | { kind: 'login_attempts'; start: string; end: string }
  | { kind: 'login_success'; start: string; end: string }
  | { kind: 'login_failed'; start: string; end: string }
  | { kind: 'total_users' }
  | { kind: 'role'; role: string };

const PAGE_SIZE = 25;

function scopeTitle(scope: DrilldownScope) {
  switch (scope.kind) {
    case 'signups': return 'New Signups';
    case 'dau': return 'Active Users (distinct logins)';
    case 'login_attempts': return 'Users with Login Attempts';
    case 'login_success': return 'Users with Successful Logins';
    case 'login_failed': return 'Users with Failed Logins';
    case 'total_users': return 'All Users';
    case 'role': return `Users with role: ${scope.role}`;
  }
}

async function fetchUserIds(scope: DrilldownScope): Promise<string[] | null> {
  // null => no id filter (all users)
  if (scope.kind === 'total_users') return null;

  if (scope.kind === 'signups') return null; // filter directly on profiles.created_at

  if (scope.kind === 'role') {
    const { data } = await supabase
      .from('user_roles')
      .select('user_id')
      .eq('role', scope.role as any)
      .limit(50000);
    return Array.from(new Set((data || []).map((r: any) => r.user_id).filter(Boolean)));
  }

  // DAU drilldown sources from login_phase_events to match the chart.
  if (scope.kind === 'dau') {
    const { data } = await supabase
      .from('login_phase_events')
      .select('user_id')
      .not('user_id', 'is', null)
      .gte('created_at', scope.start)
      .lte('created_at', scope.end)
      .limit(200000);
    return Array.from(new Set((data || []).map((r: any) => r.user_id).filter(Boolean)));
  }

  // Login funnel scopes stay on otp_login_audit (OTP challenge audit).
  // Column is resolved_user_id (falls back to actual_user_id).
  let q = supabase
    .from('otp_login_audit')
    .select('resolved_user_id, actual_user_id, outcome')
    .gte('created_at', scope.start)
    .lte('created_at', scope.end)
    .limit(50000);
  if (scope.kind === 'login_success') q = q.eq('outcome', 'success');
  if (scope.kind === 'login_failed') q = q.neq('outcome', 'success');
  const { data } = await q;
  return Array.from(
    new Set(
      (data || [])
        .map((r: any) => r.resolved_user_id || r.actual_user_id)
        .filter(Boolean),
    ),
  );
}

export function UserAnalyticsDrilldown({
  open,
  onOpenChange,
  scope,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  scope: DrilldownScope | null;
}) {
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const idQuery = useQuery({
    queryKey: ['drill-ids', scope],
    queryFn: () => (scope ? fetchUserIds(scope) : Promise.resolve([] as string[])),
    enabled: open && !!scope,
    staleTime: 60000,
  });

  const ids = idQuery.data ?? null;
  const term = search.trim();

  const usersQuery = useQuery({
    queryKey: ['drill-users', scope, ids?.length, term, page],
    queryFn: async () => {
      if (!scope) return { rows: [], total: 0 };
      const from = page * PAGE_SIZE;
      const to = from + PAGE_SIZE - 1;
      let q = supabase
        .from('profiles')
        .select('id, full_name, email, phone, created_at', { count: 'exact' })
        .is('deleted_at', null)
        .order('created_at', { ascending: false })
        .range(from, to);

      if (scope.kind === 'signups') {
        q = q.gte('created_at', scope.start).lte('created_at', scope.end);
      }
      if (ids && ids.length > 0) {
        // Supabase .in() supports up to ~1000 items reliably.
        q = q.in('id', ids.slice(0, 1000));
      } else if (ids && ids.length === 0 && scope.kind !== 'signups' && scope.kind !== 'total_users') {
        return { rows: [], total: 0 };
      }
      if (term) {
        const like = `%${term}%`;
        q = q.or(`full_name.ilike.${like},email.ilike.${like},phone.ilike.${like}`);
      }
      const { data, count } = await q;
      return { rows: data || [], total: count || 0 };
    },
    enabled: open && !!scope && !idQuery.isLoading,
    staleTime: 30000,
  });

  const total = usersQuery.data?.total ?? 0;
  const rows = usersQuery.data?.rows ?? [];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const loading = idQuery.isLoading || usersQuery.isLoading;

  const cappedNotice = useMemo(() => {
    if (!ids) return null;
    if (ids.length > 1000) return `Showing matches from the first 1,000 of ${ids.length.toLocaleString()} eligible users.`;
    return null;
  }, [ids]);

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) { setSearch(''); setPage(0); } }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="text-base">{scope ? scopeTitle(scope) : 'Users'}</DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 absolute left-2 top-2.5 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              placeholder="Search name, email, or phone…"
              className="pl-8"
            />
          </div>
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {total.toLocaleString()} match{total === 1 ? '' : 'es'}
          </span>
        </div>

        {cappedNotice && (
          <p className="text-[11px] text-amber-600">{cappedNotice}</p>
        )}

        <div className="border rounded-lg overflow-hidden">
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-muted/50 sticky top-0">
                <tr>
                  <th className="text-left p-2 font-medium">Name</th>
                  <th className="text-left p-2 font-medium">Contact</th>
                  <th className="text-left p-2 font-medium">Joined</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={3} className="p-6 text-center text-muted-foreground">
                    <Loader2 className="w-4 h-4 inline animate-spin mr-2" /> Loading…
                  </td></tr>
                ) : rows.length === 0 ? (
                  <tr><td colSpan={3} className="p-6 text-center text-muted-foreground">No users found.</td></tr>
                ) : rows.map((u: any) => (
                  <tr key={u.id} className="border-t hover:bg-muted/30">
                    <td className="p-2">
                      <div className="font-medium">{u.full_name || '—'}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">{u.id.slice(0, 8)}…</div>
                    </td>
                    <td className="p-2">
                      <div>{u.email || '—'}</div>
                      <div className="text-muted-foreground">{u.phone || '—'}</div>
                    </td>
                    <td className="p-2 whitespace-nowrap">
                      {u.created_at ? format(new Date(u.created_at), 'MMM d, yyyy') : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {pageCount}
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0}
              onClick={() => setPage((p) => Math.max(0, p - 1))}>
              <ChevronLeft className="w-3.5 h-3.5 mr-1" /> Prev
            </Button>
            <Button size="sm" variant="outline" disabled={page + 1 >= pageCount}
              onClick={() => setPage((p) => p + 1)}>
              Next <ChevronRight className="w-3.5 h-3.5 ml-1" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}