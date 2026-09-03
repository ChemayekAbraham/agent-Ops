import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { XCircle, Search, Calendar, User, Home, Briefcase } from 'lucide-react';
import { format } from 'date-fns';

/**
 * Complete historical record of every rejected rent request, across all
 * stages. Read-only history — corrections/reopens live in the per-stage
 * correction desks.
 */
const STAGE_LABEL: Record<string, string> = {
  pending: 'Agent Ops',
  agent_ops_approved: 'Tenant Ops',
  tenant_ops_approved: 'Landlord Ops',
  agent_verified: 'Landlord Ops (legacy)',
  landlord_ops_approved: 'Partner Ops',
  partner_ops_approved: 'COO',
  coo_approved: 'CFO',
};

interface RejectedRow {
  id: string;
  rent_amount: number;
  rejected_at: string | null;
  rejected_at_stage: string | null;
  rejected_reason: string | null;
  reopen_count: number;
  created_at: string;
  tenant_name: string;
  landlord_name: string;
  agent_name: string;
  haystack: string;
}

export function AgentOpsRejectedRequestsPanel() {
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['agent-ops-rejected-history'],
    queryFn: async (): Promise<RejectedRow[]> => {
      // Complete history: page through every rejected request (no cap).
      const PAGE = 1000;
      const data: any[] = [];
      for (let fromIdx = 0; ; fromIdx += PAGE) {
        const { data: chunk, error } = await supabase
          .from('rent_requests')
          .select(
            'id, rent_amount, rejected_at, rejected_at_stage, rejected_reason, reopen_count, created_at, tenant_id, agent_id, assigned_agent_id, landlord_id',
          )
          .eq('status', 'rejected')
          .order('rejected_at', { ascending: false, nullsFirst: false })
          .range(fromIdx, fromIdx + PAGE - 1);
        if (error) throw error;
        data.push(...(chunk || []));
        if (!chunk || chunk.length < PAGE) break;
      }

      const profileIds = Array.from(
        new Set(
          data.flatMap((r: any) => [r.tenant_id, r.agent_id, r.assigned_agent_id]).filter(Boolean),
        ),
      );
      const landlordIds = Array.from(
        new Set(data.map((r: any) => r.landlord_id).filter(Boolean)),
      );

      const nameById = new Map<string, string>();
      for (let i = 0; i < profileIds.length; i += 500) {
        const { data: people } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', profileIds.slice(i, i + 500));
        (people || []).forEach((p: any) => nameById.set(p.id, p.full_name || '—'));
      }

      const landlordNameById = new Map<string, string>();
      for (let i = 0; i < landlordIds.length; i += 500) {
        const { data: landlords } = await supabase
          .from('landlords')
          .select('id, name')
          .in('id', landlordIds.slice(i, i + 500));
        (landlords || []).forEach((l: any) => landlordNameById.set(l.id, l.name || '—'));
      }

      return data.map((r: any) => {
        const tenant_name = nameById.get(r.tenant_id) || 'Unknown tenant';
        const landlord_name = landlordNameById.get(r.landlord_id) || '—';
        const agent_name = nameById.get(r.assigned_agent_id || r.agent_id) || '—';
        return {
          id: r.id,
          rent_amount: Number(r.rent_amount) || 0,
          rejected_at: r.rejected_at || null,
          rejected_at_stage: r.rejected_at_stage || null,
          rejected_reason: r.rejected_reason || null,
          reopen_count: r.reopen_count ?? 0,
          created_at: r.created_at,
          tenant_name,
          landlord_name,
          agent_name,
          haystack: `${tenant_name} ${landlord_name} ${agent_name} ${r.rejected_reason || ''}`.toLowerCase(),
        };
      });
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const fromTs = from ? new Date(`${from}T00:00:00`).getTime() : null;
    const toTs = to ? new Date(`${to}T23:59:59`).getTime() : null;
    return rows.filter((r) => {
      if (q && !r.haystack.includes(q)) return false;
      const ref = new Date(r.rejected_at || r.created_at).getTime();
      if (fromTs != null && ref < fromTs) return false;
      if (toTs != null && ref > toTs) return false;
      return true;
    });
  }, [rows, search, from, to]);

  const total = filtered.reduce((sum, r) => sum + r.rent_amount, 0);
  const hasFilters = !!(search || from || to);

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder="Search tenant, landlord, agent or reason..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8 h-8 text-xs"
          />
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="h-8 text-xs"
            aria-label="Rejected from"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-8 text-xs"
            aria-label="Rejected to"
          />
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              onClick={() => {
                setSearch('');
                setFrom('');
                setTo('');
              }}
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{filtered.length} rejected request{filtered.length !== 1 ? 's' : ''}</span>
        <span className="font-medium text-foreground">UGX {total.toLocaleString()}</span>
      </div>

      {isLoading && (
        <div className="text-center py-8 text-muted-foreground text-sm">Loading rejected requests...</div>
      )}
      {!isLoading && filtered.length === 0 && (
        <div className="text-center py-8 text-muted-foreground text-sm">
          {rows.length === 0 ? 'No rejected requests yet' : 'No requests match these filters'}
        </div>
      )}

      <div className="space-y-2">
        {filtered.map((r) => (
          <Card key={r.id} className="border">
            <CardContent className="p-3 space-y-1.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    <User className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="font-medium text-sm truncate">{r.tenant_name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Home className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{r.landlord_name}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Briefcase className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{r.agent_name}</span>
                  </div>
                </div>
                <div className="text-right shrink-0 space-y-1">
                  <p className="font-bold text-sm">UGX {r.rent_amount.toLocaleString()}</p>
                  <Badge variant="outline" size="sm" className="bg-amber-500/10 text-amber-700 border-amber-500/30">
                    Rejected at {STAGE_LABEL[r.rejected_at_stage ?? 'pending'] ?? r.rejected_at_stage}
                  </Badge>
                </div>
              </div>
              {r.rejected_reason && (
                <p className="text-xs text-muted-foreground line-clamp-2" title={r.rejected_reason}>
                  {r.rejected_reason}
                </p>
              )}
              <div className="flex items-center gap-3 pt-1 border-t text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <XCircle className="h-3 w-3 text-destructive" />
                  Rejected{' '}
                  {r.rejected_at ? format(new Date(r.rejected_at), 'dd MMM yyyy') : 'date not recorded'}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  Submitted {format(new Date(r.created_at), 'dd MMM yyyy')}
                </span>
                {r.reopen_count > 0 && (
                  <span>Reopened {r.reopen_count}×</span>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
