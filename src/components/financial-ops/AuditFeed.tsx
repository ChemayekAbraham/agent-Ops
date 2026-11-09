import { withUuidIds } from '@/lib/isUuid';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { format } from 'date-fns';
import { Shield, Search, Loader2 } from 'lucide-react';
import { PageHeader, Pager } from './FinopsKit';

const ACTION_COLORS: Record<string, string> = {
  approve: 'bg-emerald-500/10 text-emerald-600',
  reject: 'bg-destructive/10 text-destructive',
  bulk: 'bg-amber-500/10 text-amber-600',
  deposit: 'bg-primary/10 text-primary',
  withdrawal: 'bg-violet-500/10 text-violet-600',
  role: 'bg-blue-500/10 text-blue-600',
};

function getActionColor(actionType: string) {
  for (const [key, val] of Object.entries(ACTION_COLORS)) {
    if (actionType.toLowerCase().includes(key)) return val;
  }
  return 'bg-muted text-muted-foreground';
}

const PAGE_SIZE = 25;

export function AuditFeed() {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);

  const { data: logs = [], isLoading } = useQuery({
    queryKey: ['audit-feed', filter],
    queryFn: async () => {
      let query = supabase
        .from('audit_logs')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(200);

      if (filter !== 'all') {
        query = query.ilike('action_type', `%${filter}%`);
      }

      const { data } = await query;
      if (!data?.length) return [];

      // Resolve user names
      const userIds = [...new Set(data.filter(l => l.user_id).map(l => l.user_id!))];
      const profileMap = new Map<string, string>();
      if (userIds.length) {
        const batches: string[][] = [];
        for (let i = 0; i < userIds.length; i += 50) batches.push(userIds.slice(i, i + 50));
        for (const batch of batches) {
          const { data: profiles } = await withUuidIds(batch, (validIds) => supabase.from('profiles').select('id, full_name').in('id', validIds));
          profiles?.forEach(p => profileMap.set(p.id, p.full_name || 'Unknown'));
        }
      }

      return data.map(l => ({
        ...l,
        actor_name: l.user_id ? profileMap.get(l.user_id) || 'Unknown' : 'System',
      }));
    },
    staleTime: 30000,
  });

  const filtered = search
    ? logs.filter(l =>
        (l as any).actor_name?.toLowerCase().includes(search.toLowerCase()) ||
        l.action_type.toLowerCase().includes(search.toLowerCase()) ||
        JSON.stringify(l.metadata || {}).toLowerCase().includes(search.toLowerCase())
      )
    : logs;

  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <section className="space-y-5">
      <PageHeader
        icon={Shield}
        title="Audit Trail"
        description="Track system events, user actions and data changes across the platform."
      />

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[14rem]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <Input
            placeholder="Filter logs…"
            aria-label="Filter logs"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(0); }}
            className="pl-9 h-11 rounded-xl"
          />
        </div>
        <Select value={filter} onValueChange={(v) => { setFilter(v); setPage(0); }}>
          <SelectTrigger className="w-[180px] h-11 rounded-xl" aria-label="Event type"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All event types</SelectItem>
            <SelectItem value="approve">Approvals</SelectItem>
            <SelectItem value="reject">Rejections</SelectItem>
            <SelectItem value="bulk">Bulk actions</SelectItem>
            <SelectItem value="deposit">Deposits</SelectItem>
            <SelectItem value="withdrawal">Withdrawals</SelectItem>
            <SelectItem value="role">Role changes</SelectItem>
          </SelectContent>
        </Select>
        {(search || filter !== 'all') && (
          <button
            type="button"
            onClick={() => { setSearch(''); setFilter('all'); setPage(0); }}
            className="h-11 rounded-xl px-3 text-sm font-semibold text-muted-foreground hover:text-foreground"
          >
            Clear filters
          </button>
        )}
      </div>

      <div className="rounded-2xl border bg-card shadow-2xs overflow-hidden">
        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
        ) : filtered.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">No audit logs found</div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[780px] border-collapse text-sm">
                <thead>
                  <tr className="text-left text-xs font-semibold text-muted-foreground">
                    <th className="px-4 py-3">Date &amp; time</th>
                    <th className="px-2 py-3">User</th>
                    <th className="px-2 py-3">Event type</th>
                    <th className="px-2 py-3">Entity</th>
                    <th className="px-4 py-3">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map(log => {
                    const meta = (log.metadata as any) || {};
                    const color = getActionColor(log.action_type);
                    return (
                      <tr key={log.id} className="border-t align-top">
                        <td className="px-4 py-3.5 whitespace-nowrap text-muted-foreground">
                          {format(new Date(log.created_at!), 'dd MMM yyyy, HH:mm')}
                        </td>
                        <td className="px-2 py-3.5 font-medium">{(log as any).actor_name}</td>
                        <td className="px-2 py-3.5">
                          <Badge className={`text-xs px-2 py-0.5 ${color} border-0`}>
                            {log.action_type.replace(/_/g, ' ')}
                          </Badge>
                        </td>
                        <td className="px-2 py-3.5">
                          {log.table_name ? (
                            <>
                              <p>{log.table_name}</p>
                              {log.record_id && <p className="text-xs font-mono text-muted-foreground">{log.record_id.slice(0, 8)}…</p>}
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3.5 max-w-[360px]">
                          {meta.reason ? <p className="italic text-muted-foreground">"{meta.reason}"</p> : <span className="text-muted-foreground">—</span>}
                          {meta.count && <p className="text-xs text-muted-foreground">{meta.count} items</p>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t px-4 py-3">
              <Pager page={page} pageSize={PAGE_SIZE} total={filtered.length} onPage={setPage} noun="events" />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
