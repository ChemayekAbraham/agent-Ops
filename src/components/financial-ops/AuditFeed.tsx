import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { format, formatDistanceToNow } from 'date-fns';
import { Shield, Search, Loader2 } from 'lucide-react';

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

export function AuditFeed() {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

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
          const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', batch);
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

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-primary" /> Audit Trail
          </CardTitle>
          <div className="flex gap-2">
            <div className="relative flex-1 min-w-[150px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input placeholder="Filter logs…" value={search} onChange={e => setSearch(e.target.value)} className="pl-9 h-8 text-xs" />
            </div>
            <Select value={filter} onValueChange={setFilter}>
              <SelectTrigger className="w-[130px] h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Actions</SelectItem>
                <SelectItem value="approve">Approvals</SelectItem>
                <SelectItem value="reject">Rejections</SelectItem>
                <SelectItem value="bulk">Bulk Actions</SelectItem>
                <SelectItem value="deposit">Deposits</SelectItem>
                <SelectItem value="withdrawal">Withdrawals</SelectItem>
                <SelectItem value="role">Role Changes</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <ScrollArea className="max-h-[500px]">
          {isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>
          ) : filtered.length === 0 ? (
            <div className="py-10 text-center text-sm text-muted-foreground">No audit logs found</div>
          ) : (
            <div className="space-y-1">
              {filtered.map(log => {
                const meta = (log.metadata as any) || {};
                const color = getActionColor(log.action_type);
                return (
                  <div key={log.id} className="flex items-start gap-3 p-2.5 rounded-lg hover:bg-muted/30 transition-colors">
                    <div className="mt-0.5">
                      <Badge className={`text-[10px] px-1.5 py-0 ${color} border-0`}>
                        {log.action_type.replace(/_/g, ' ')}
                      </Badge>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm">
                        <span className="font-medium">{(log as any).actor_name}</span>
                        {meta.count && <span className="text-muted-foreground"> ({meta.count} items)</span>}
                      </p>
                      {meta.reason && (
                        <p className="text-[11px] text-muted-foreground truncate italic">"{meta.reason}"</p>
                      )}
                      {log.table_name && (
                        <p className="text-[10px] text-muted-foreground/70">
                          Table: {log.table_name} {log.record_id && `· Record: ${log.record_id.slice(0, 8)}…`}
                        </p>
                      )}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[11px] text-muted-foreground">
                        {formatDistanceToNow(new Date(log.created_at!), { addSuffix: true })}
                      </p>
                      <p className="text-[10px] text-muted-foreground/60">
                        {format(new Date(log.created_at!), 'HH:mm')}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
