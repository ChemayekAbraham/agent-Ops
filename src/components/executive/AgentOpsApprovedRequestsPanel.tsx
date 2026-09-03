import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { CheckCircle2, Search, Calendar, User, Home, Briefcase } from 'lucide-react';
import { format } from 'date-fns';

/**
 * Requests that have cleared Agent Ops review. Everything downstream of the
 * Agent Ops desk counts as approved here, whichever stage it now sits at.
 */
const APPROVED_STATUSES = [
  'agent_ops_approved',
  'tenant_ops_approved',
  'landlord_ops_approved',
  'partner_ops_approved',
  'coo_approved',
  'approved',
  'funded',
  'disbursed',
  'repaying',
  'completed',
];

const STAGE_LABEL: Record<string, string> = {
  agent_ops_approved: 'Tenant Ops review',
  tenant_ops_approved: 'Landlord Ops review',
  landlord_ops_approved: 'Partner Ops review',
  partner_ops_approved: 'COO review',
  coo_approved: 'CFO funding',
  approved: 'Approved',
  funded: 'Funded',
  disbursed: 'Disbursed',
  repaying: 'Repaying',
  completed: 'Completed',
};

const SETTLED = new Set(['funded', 'disbursed', 'repaying', 'completed']);

interface ApprovedRow {
  id: string;
  status: string;
  rent_amount: number;
  approved_at: string | null;
  created_at: string;
  tenant_name: string;
  landlord_name: string;
  agent_name: string;
  haystack: string;
}

export function AgentOpsApprovedRequestsPanel() {
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['agent-ops-approved-requests'],
    queryFn: async (): Promise<ApprovedRow[]> => {
      const { data, error } = await supabase
        .from('rent_requests')
        .select(
          'id, status, rent_amount, created_at, agent_ops_reviewed_at, approved_at, tenant_id, agent_id, landlords(name)',
        )
        .in('status', APPROVED_STATUSES)
        .order('created_at', { ascending: false })
        .limit(500);
      if (error) throw error;

      const ids = Array.from(
        new Set(
          (data || []).flatMap((r: any) => [r.tenant_id, r.agent_id]).filter(Boolean),
        ),
      );
      const { data: people } = ids.length
        ? await supabase.from('profiles').select('id, full_name').in('id', ids)
        : { data: [] as any[] };
      const nameById = new Map((people || []).map((p: any) => [p.id, p.full_name || '—']));

      return (data || []).map((r: any) => {
        const tenant_name = nameById.get(r.tenant_id) || 'Unknown tenant';
        const landlord_name = r.landlords?.name || '—';
        const agent_name = nameById.get(r.agent_id) || '—';
        return {
          id: r.id,
          status: r.status,
          rent_amount: Number(r.rent_amount) || 0,
          approved_at: r.agent_ops_reviewed_at || r.approved_at || null,
          created_at: r.created_at,
          tenant_name,
          landlord_name,
          agent_name,
          haystack: `${tenant_name} ${landlord_name} ${agent_name}`.toLowerCase(),
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
      const ref = new Date(r.approved_at || r.created_at).getTime();
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
            placeholder="Search tenant, landlord or agent..."
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
            aria-label="Approved from"
          />
          <span className="text-xs text-muted-foreground">to</span>
          <Input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="h-8 text-xs"
            aria-label="Approved to"
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
        <span>{filtered.length} approved request{filtered.length !== 1 ? 's' : ''}</span>
        <span className="font-medium text-foreground">UGX {total.toLocaleString()}</span>
      </div>

      {isLoading && (
        <div className="text-center py-8 text-muted-foreground text-sm">Loading approved requests...</div>
      )}
      {!isLoading && filtered.length === 0 && (
        <div className="text-center py-8 text-muted-foreground text-sm">
          {rows.length === 0 ? 'No approved requests yet' : 'No requests match these filters'}
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
                  <Badge variant={SETTLED.has(r.status) ? 'primary' : 'outline'} size="sm">
                    {STAGE_LABEL[r.status] ?? r.status.replace(/_/g, ' ')}
                  </Badge>
                </div>
              </div>
              <div className="flex items-center gap-3 pt-1 border-t text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                  Approved{' '}
                  {r.approved_at ? format(new Date(r.approved_at), 'dd MMM yyyy') : 'date not recorded'}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  Submitted {format(new Date(r.created_at), 'dd MMM yyyy')}
                </span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
