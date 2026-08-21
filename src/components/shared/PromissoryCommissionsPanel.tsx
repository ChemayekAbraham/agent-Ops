import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUGX } from '@/lib/rentCalculations';
import { AlertTriangle, HandCoins, PlusCircle, Wallet } from 'lucide-react';

type Filter = 'all' | 'portfolio_creation' | 'portfolio_topup' | 'failed';

interface CommissionRow {
  id: string;
  created_at: string;
  kind: string;
  status: string;
  base_amount: number;
  rate: number;
  amount: number;
  source_table: string;
  source_id: string;
  ledger_group_id: string | null;
  note_id: string | null;
  note_partner_name: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  partner_id: string | null;
  partner_name: string | null;
  error_message: string | null;
}

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'portfolio_creation', label: 'Portfolio (2%)' },
  { key: 'portfolio_topup', label: 'Top-ups (1%)' },
  { key: 'failed', label: 'Needs attention' },
];

const KIND_LABEL: Record<string, string> = {
  portfolio_creation: 'Portfolio deployed',
  portfolio_topup: 'Top-up',
};

const dateLabel = (iso?: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : '—';

/**
 * Audit register of proxy-agent commissions earned on promissory-linked partners.
 * 2% of portfolio principal on deployment, 1% of every top-up increase.
 * Read-only: rows are written by the ledger-backed commission engine.
 * One query carries the page; KPIs are derived client-side (no N+1).
 */
export function PromissoryCommissionsPanel() {
  const [filter, setFilter] = useState<Filter>('all');

  const { data, isLoading } = useQuery({
    queryKey: ['promissory-agent-commissions'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_promissory_agent_commissions')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      return (data || []) as unknown as CommissionRow[];
    },
    staleTime: 60_000,
  });

  const rows = data ?? [];

  const kpi = useMemo(() => {
    let creationCount = 0;
    let creationAmount = 0;
    let topupCount = 0;
    let topupAmount = 0;
    let failed = 0;
    for (const r of rows) {
      if (r.status === 'failed') {
        failed += 1;
        continue;
      }
      if (r.status !== 'paid') continue;
      if (r.kind === 'portfolio_creation') {
        creationCount += 1;
        creationAmount += Number(r.amount || 0);
      } else if (r.kind === 'portfolio_topup') {
        topupCount += 1;
        topupAmount += Number(r.amount || 0);
      }
    }
    return {
      creationCount,
      creationAmount,
      topupCount,
      topupAmount,
      failed,
      total: creationAmount + topupAmount,
    };
  }, [rows]);

  const visible = useMemo(() => {
    if (filter === 'all') return rows;
    if (filter === 'failed') return rows.filter((r) => r.status === 'failed');
    return rows.filter((r) => r.kind === filter && r.status === 'paid');
  }, [rows, filter]);

  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <HandCoins className="h-4 w-4 text-primary" />
          Promissory Agent Commissions
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Ledger-backed register of proxy-agent earnings on promissory-linked partners:
          2% of portfolio principal at deployment and 1% of every top-up increase.
          Each row carries its ledger group for CFO and Partner Ops reconciliation.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border bg-muted/30 p-3">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Wallet className="h-3.5 w-3.5" /> Portfolio commissions (2%)
                </p>
                <p className="mt-1 text-lg font-semibold">{formatUGX(kpi.creationAmount)}</p>
                <p className="text-xs text-muted-foreground">{kpi.creationCount} paid</p>
              </div>
              <div className="rounded-xl border bg-muted/30 p-3">
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <PlusCircle className="h-3.5 w-3.5" /> Top-up commissions (1%)
                </p>
                <p className="mt-1 text-lg font-semibold">{formatUGX(kpi.topupAmount)}</p>
                <p className="text-xs text-muted-foreground">{kpi.topupCount} paid</p>
              </div>
              <div className="rounded-xl border bg-muted/30 p-3">
                <p className="text-xs text-muted-foreground">Total paid to agents</p>
                <p className="mt-1 text-lg font-semibold">{formatUGX(kpi.total)}</p>
                {kpi.failed > 0 ? (
                  <p className="flex items-center gap-1 text-xs text-destructive">
                    <AlertTriangle className="h-3.5 w-3.5" /> {kpi.failed} need attention
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">No failures recorded</p>
                )}
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              {FILTERS.map((f) => (
                <Button
                  key={f.key}
                  size="sm"
                  variant={filter === f.key ? 'default' : 'outline'}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </Button>
              ))}
            </div>

            {visible.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No commissions recorded for this filter yet.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="py-2 pr-3">Date</th>
                      <th className="py-2 pr-3">Agent</th>
                      <th className="py-2 pr-3">Partner</th>
                      <th className="py-2 pr-3">Event</th>
                      <th className="py-2 pr-3 text-right">Base</th>
                      <th className="py-2 pr-3 text-right">Rate</th>
                      <th className="py-2 pr-3 text-right">Commission</th>
                      <th className="py-2 pr-3">Ledger</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((r) => (
                      <tr key={r.id} className="border-b last:border-0">
                        <td className="py-2 pr-3 whitespace-nowrap">{dateLabel(r.created_at)}</td>
                        <td className="py-2 pr-3">
                          <span className="font-medium">{r.agent_name || '—'}</span>
                          {r.agent_phone ? (
                            <span className="block text-xs text-muted-foreground">{r.agent_phone}</span>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3">
                          {r.partner_name || r.note_partner_name || '—'}
                        </td>
                        <td className="py-2 pr-3">
                          <Badge variant={r.status === 'paid' ? 'secondary' : 'destructive'}>
                            {KIND_LABEL[r.kind] || r.kind}
                          </Badge>
                          {r.status === 'failed' && r.error_message ? (
                            <span className="block max-w-[220px] truncate text-xs text-destructive">
                              {r.error_message}
                            </span>
                          ) : null}
                        </td>
                        <td className="py-2 pr-3 text-right whitespace-nowrap">
                          {formatUGX(Number(r.base_amount || 0))}
                        </td>
                        <td className="py-2 pr-3 text-right">
                          {(Number(r.rate || 0) * 100).toFixed(0)}%
                        </td>
                        <td className="py-2 pr-3 text-right font-semibold whitespace-nowrap">
                          {formatUGX(Number(r.amount || 0))}
                        </td>
                        <td className="py-2 pr-3 font-mono text-xs text-muted-foreground">
                          {r.ledger_group_id ? r.ledger_group_id.slice(0, 8) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export default PromissoryCommissionsPanel;
