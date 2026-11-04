import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { searchProfilesTypeahead } from '@/lib/profileTypeahead';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import {
  COMPOUND_REQUEST_MIN_REASON, useCompoundCandidates, useCompoundRequests, useFileCompoundRequest,
  type CompoundRequestRow,
} from '@/hooks/useCompoundReversal';

interface PortfolioHit { id: string; portfolio_code: string | null; investment_amount: number; investor_id: string; partner_name: string | null }

function usePortfolioSearch(term: string) {
  return useQuery({
    queryKey: ['compound-portfolio-search', term],
    enabled: term.trim().length >= 3,
    queryFn: async (): Promise<PortfolioHit[]> => {
      const t = term.trim();
      const { rows: people } = await searchProfilesTypeahead(t, { limit: 20, columns: 'id, full_name' });
      const ids = (people || []).map((p) => p.id);
      const byCode = await supabase.from('investor_portfolios')
        .select('id, portfolio_code, investment_amount, investor_id').ilike('portfolio_code', `%${t}%`).limit(20);
      const byPartner = ids.length
        ? await supabase.from('investor_portfolios').select('id, portfolio_code, investment_amount, investor_id')
            .in('investor_id', ids).limit(40)
        : { data: [] as any[] };
      const rows = [...(byCode.data || []), ...(byPartner.data || [])];
      const seen = new Set<string>();
      const uniq = rows.filter((r: any) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
      const missing = uniq.map((r: any) => r.investor_id).filter((id: string) => !ids.includes(id));
      const extra = missing.length
        ? (await supabase.from('profiles').select('id, full_name').in('id', missing)).data || []
        : [];
      const names = new Map([...(people || []), ...extra].map((p: any) => [p.id, p.full_name]));
      return uniq.map((r: any) => ({ ...r, partner_name: names.get(r.investor_id) ?? null }));
    },
  });
}

const STATUS_LABEL: Record<CompoundRequestRow['status'], string> = {
  pending_cfo: 'Waiting for CFO', approved: 'Approved – in Nearing Payout', rejected: 'Rejected',
};

export function CompoundRequestStatus({ status }: { status: CompoundRequestRow['status'] }) {
  const variant = status === 'approved' ? 'default' : status === 'rejected' ? 'destructive' : 'secondary';
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>;
}

export function CompoundRequestsPanel() {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [portfolio, setPortfolio] = useState<PortfolioHit | null>(null);
  const [ledgerId, setLedgerId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(term), 350); return () => clearTimeout(t); }, [term]);

  const search = usePortfolioSearch(debounced);
  const candidates = useCompoundCandidates(portfolio?.id ?? null);
  const requests = useCompoundRequests();
  const file = useFileCompoundRequest();

  const submit = async () => {
    if (!portfolio || !ledgerId) return;
    try {
      await file.mutateAsync({ portfolioId: portfolio.id, ledgerId, reason });
      toast.success('Compound request sent to the CFO');
      setLedgerId(null); setReason('');
    } catch (e: any) { toast.error(e?.message || 'Could not send the request'); }
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Compound Request</CardTitle>
          <p className="text-sm text-muted-foreground">
            Ask the CFO to take a reinvested Return back out of a portfolio. Once approved, the Return goes to
            Nearing Payout to be paid through the normal steps. Nothing is sent to the partner's wallet directly.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">1. Find the partner or portfolio</label>
            <Input placeholder="Partner name or portfolio code" value={term}
              onChange={(e) => { setTerm(e.target.value); setPortfolio(null); setLedgerId(null); }} />
            {!portfolio && search.data && (
              <ul className="max-h-60 divide-y overflow-auto rounded-md border">
                {search.data.length === 0 && <li className="p-3 text-sm text-muted-foreground">No matches</li>}
                {search.data.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => setPortfolio(p)}
                      className="flex w-full items-center justify-between gap-3 p-3 text-left text-sm hover:bg-muted">
                      <span><span className="font-medium">{p.partner_name || 'Unknown partner'}</span>
                        <span className="ml-2 text-muted-foreground">{p.portfolio_code}</span></span>
                      <span className="tabular-nums">{formatUGX(Number(p.investment_amount))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {portfolio && (
            <div className="space-y-2">
              <label className="text-sm font-medium">
                2. Choose the reinvestment for {portfolio.partner_name} · {portfolio.portfolio_code}
              </label>
              {candidates.isLoading && <p className="text-sm text-muted-foreground">Loading reinvestments…</p>}
              {candidates.error && <p className="text-sm text-destructive">{(candidates.error as Error).message}</p>}
              {candidates.data?.length === 0 && (
                <p className="text-sm text-muted-foreground">No reinvested Returns in the last 120 days.</p>
              )}
              <div className="space-y-2">
                {candidates.data?.map((c) => (
                  <button key={c.ledger_id} type="button" onClick={() => setLedgerId(c.ledger_id)}
                    className={`flex w-full items-center justify-between rounded-md border p-3 text-left text-sm ${
                      ledgerId === c.ledger_id ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}>
                    <span>{new Date(c.reinvested_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                      <span className="ml-2 text-muted-foreground">{c.reference_id}</span></span>
                    <span className="font-semibold tabular-nums">{formatUGX(Number(c.amount))}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {ledgerId && (
            <div className="space-y-2">
              <label className="text-sm font-medium">3. Reason</label>
              <Textarea value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. October Return was meant to be paid as cash, not reinvested" />
              <p className="text-xs text-muted-foreground">At least {COMPOUND_REQUEST_MIN_REASON} characters.</p>
              <Button onClick={submit} disabled={file.isPending || reason.trim().length < COMPOUND_REQUEST_MIN_REASON}>
                {file.isPending ? 'Sending…' : 'Send to CFO'}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <CompoundRequestsTable rows={requests.data} loading={requests.isLoading} error={requests.error as Error | null} />
    </div>
  );
}

export function CompoundRequestsTable({ rows, loading, error, actions }: {
  rows?: CompoundRequestRow[]; loading: boolean; error: Error | null;
  actions?: (r: CompoundRequestRow) => React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Compound requests</CardTitle></CardHeader>
      <CardContent>
        {loading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {error && <p className="text-sm text-destructive">{error.message}</p>}
        {rows && rows.length === 0 && <p className="text-sm text-muted-foreground">No compound requests yet.</p>}
        {rows && rows.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr><th className="p-2">Partner</th><th className="p-2">Portfolio</th><th className="p-2">Reinvested</th>
                  <th className="p-2 text-right">Amount</th><th className="p-2">Reason</th><th className="p-2">Requested by</th>
                  <th className="p-2">Status</th>{actions && <th className="p-2" />}</tr>
              </thead>
              <tbody className="divide-y">
                {rows.map((r) => (
                  <tr key={r.id} className="align-top">
                    <td className="p-2 font-medium">{r.partner_name}</td>
                    <td className="p-2">{r.portfolio_code}</td>
                    <td className="p-2">{new Date(r.reinvested_at).toLocaleDateString('en-GB')}</td>
                    <td className="p-2 text-right tabular-nums">{formatUGX(Number(r.amount))}</td>
                    <td className="p-2 max-w-xs">{r.reason}{r.decision_note &&
                      <div className="mt-1 text-xs text-muted-foreground">CFO: {r.decision_note}</div>}</td>
                    <td className="p-2">{r.requested_by_name}</td>
                    <td className="p-2"><CompoundRequestStatus status={r.status} />
                      {r.status === 'approved' && r.cycle_date &&
                        <div className="mt-1 text-xs text-muted-foreground">Queue the payout within 24 hours of approval</div>}</td>
                    {actions && <td className="p-2">{actions(r)}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
