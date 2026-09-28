import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Mail, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';

const fmt = (n: number) =>
  `UGX ${Math.round(n).toLocaleString('en-UG')}`;

const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleString('en-UG', { dateStyle: 'short', timeStyle: 'short' }) : '—';

interface BulkEmail {
  id: string;
  internal_date: string | null;
  subject: string | null;
  from_name: string | null;
  amount: number | null;
  bulk_payout_allocated_total: number | null;
  bulk_payout_settled_at: string | null;
  transaction_id: string | null;
}

interface Allocation {
  id: string;
  withdrawal_request_id: string;
  partner_id: string;
  proxy_agent_id: string;
  allocated_amount: number;
  remaining_after: number | null;
  status: string;
  created_at: string;
  metadata: Record<string, unknown> | null;
  partner_name?: string;
  proxy_name?: string;
}

export function BulkBankPayoutPanel() {
  const [emails, setEmails] = useState<BulkEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState<Record<string, Allocation[] | 'loading'>>({});

  const load = async () => {
    setLoading(true);
    const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const { data } = await supabase
      .from('gmail_transactions')
      .select('id, internal_date, subject, from_name, amount, bulk_payout_allocated_total, bulk_payout_settled_at, transaction_id')
      .eq('is_bulk_bank_payout', true)
      .gte('internal_date', since)
      .order('internal_date', { ascending: false })
      .limit(40);
    const rows = (data as BulkEmail[]) || [];
    setEmails(rows);
    setLoading(false);
    // Auto-expand the most recent batch so the allocation breakdown is
    // immediately visible under Bulk Bank Payouts without an extra click.
    if (rows.length) {
      void loadAllocations(rows[0].id);
    }
  };

  // Loads on mount; `load` is the manual-refresh handler. No polling: load()
  // auto-expands the newest batch, so a timer would keep collapsing whatever
  // the operator had open. The old Realtime listener was on
  // bulk_bank_payout_allocations, which is not published, so it never fired
  // (doc 147).
  useEffect(() => {
    load();
  }, []);

  const loadAllocations = async (emailId: string) => {
    setOpen((p) => ({ ...p, [emailId]: 'loading' }));
    const { data } = await supabase
      .from('bulk_bank_payout_allocations')
      .select('id, withdrawal_request_id, partner_id, proxy_agent_id, allocated_amount, remaining_after, status, created_at, metadata')
      .eq('gmail_transaction_id', emailId)
      .order('created_at', { ascending: true });
    const allocs = (data || []) as Allocation[];
    const ids = Array.from(new Set(allocs.flatMap((a) => [a.partner_id, a.proxy_agent_id]).filter(Boolean)));
    if (ids.length) {
      const { data: profs } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      const map = new Map((profs || []).map((p: any) => [p.id, p.full_name]));
      allocs.forEach((a) => {
        a.partner_name = map.get(a.partner_id) || a.partner_id.slice(0, 8);
        a.proxy_name = map.get(a.proxy_agent_id) || a.proxy_agent_id.slice(0, 8);
      });
    }
    setOpen((p) => ({ ...p, [emailId]: allocs }));
  };

  const toggle = async (emailId: string) => {
    if (open[emailId]) {
      setOpen((p) => { const n = { ...p }; delete n[emailId]; return n; });
      return;
    }
    await loadAllocations(emailId);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Mail className="h-4 w-4 text-primary" />
          Bulk Bank Payouts — auto-settled batches
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Detected bulk-payout emails (e.g. SKYBUBBLES). Auto-allocates same-day bank withdrawals to managed proxy agents.
        </p>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : emails.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4">No bulk payout emails in the last 14 days.</p>
        ) : (
          <div className="space-y-2">
            {emails.map((e) => {
              const total = Number(e.amount || 0);
              const allocated = Number(e.bulk_payout_allocated_total || 0);
              const remaining = Math.max(0, total - allocated);
              const isOpen = !!open[e.id];
              const allocs = open[e.id];
              return (
                <div key={e.id} className="border rounded-lg">
                  <button
                    onClick={() => toggle(e.id)}
                    className="w-full flex items-start gap-2 p-3 text-left hover:bg-muted/40 transition"
                  >
                    {isOpen ? <ChevronDown className="h-4 w-4 mt-1 shrink-0" /> : <ChevronRight className="h-4 w-4 mt-1 shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium truncate">{e.from_name || 'Bank email'}</span>
                        <Badge variant={e.bulk_payout_settled_at ? 'default' : 'secondary'}>
                          {e.bulk_payout_settled_at ? 'fully settled' : 'open'}
                        </Badge>
                        <span className="text-xs text-muted-foreground">{fmtDate(e.internal_date)}</span>
                      </div>
                      <div className="text-xs text-muted-foreground truncate mt-0.5">{e.subject}</div>
                      <div className="flex gap-4 mt-1.5 text-xs">
                        <span>Batch: <strong>{fmt(total)}</strong></span>
                        <span className="text-green-600">Allocated: {fmt(allocated)}</span>
                        <span className="text-amber-600">Remaining: {fmt(remaining)}</span>
                      </div>
                    </div>
                  </button>
                  {isOpen && (
                    <div className="border-t bg-muted/20 p-3">
                      {allocs === 'loading' ? (
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Loader2 className="h-3 w-3 animate-spin" /> Loading allocations…
                        </div>
                      ) : !allocs || allocs.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No allocations yet for this batch.</p>
                      ) : (
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead className="text-muted-foreground">
                              <tr className="text-left">
                                <th className="py-1 pr-2">Partner</th>
                                <th className="py-1 pr-2">Proxy agent</th>
                                <th className="py-1 pr-2 text-right">Allocated</th>
                                <th className="py-1 pr-2 text-right">Batch remaining after</th>
                                <th className="py-1 pr-2">Status</th>
                                <th className="py-1 pr-2">When</th>
                              </tr>
                            </thead>
                            <tbody>
                              {allocs.map((a) => (
                                <tr key={a.id} className="border-t">
                                  <td className="py-1 pr-2">{a.partner_name}</td>
                                  <td className="py-1 pr-2">{a.proxy_name}</td>
                                  <td className="py-1 pr-2 text-right font-medium">{fmt(a.allocated_amount)}</td>
                                  <td className="py-1 pr-2 text-right text-amber-700">
                                    {a.remaining_after != null ? fmt(a.remaining_after) : '—'}
                                  </td>
                                  <td className="py-1 pr-2">
                                    <Badge variant={a.status === 'settled' ? 'default' : 'destructive'}>{a.status}</Badge>
                                  </td>
                                  <td className="py-1 pr-2">{fmtDate(a.created_at)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="pt-2">
              <Button size="sm" variant="outline" onClick={load}>Refresh</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}