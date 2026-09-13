"use client";
import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Clock, CheckCircle2, XCircle, AlertCircle, Receipt, Download } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { useCurrency } from '@/hooks/useCurrency';
import { toast } from 'sonner';
import { generateProxyRecentPayoutsPdf } from '@/lib/proxyRecentPayoutsPdf';

const PAGE_SIZE = 20;

interface PayoutRow {
  id: string;
  amount: number;
  status: string;
  payout_method: string | null;
  processed_at: string | null;
  created_at: string;
  partnerId: string | null;
  destinationLabel: string;
  destinationValue: string;
}

const statusPill = (status: string) => {
  const s = (status || '').toLowerCase();
  if (s === 'completed' || s === 'paid' || s === 'disbursed') {
    return (
      <Badge variant="success" size="sm" className="gap-1">
        <CheckCircle2 className="h-3 w-3" />
        Completed
      </Badge>
    );
  }
  if (s === 'rejected' || s === 'cancelled' || s === 'expired' || s === 'failed') {
    return (
      <Badge variant="destructive" size="sm" className="gap-1">
        <XCircle className="h-3 w-3" />
        {s.charAt(0).toUpperCase() + s.slice(1)}
      </Badge>
    );
  }
  if (s === 'pending' || s === 'requested') {
    return (
      <Badge variant="warning" size="sm" className="gap-1">
        <Clock className="h-3 w-3" />
        Pending
      </Badge>
    );
  }
  return (
    <Badge variant="outline" size="sm" className="gap-1">
      <AlertCircle className="h-3 w-3" />
      {status ? status.replace(/_/g, ' ') : 'Unknown'}
    </Badge>
  );
};

export function ProxyRecentPayouts() {
  const { user } = useAuth();
  const { formatAmount } = useCurrency();
  const [rows, setRows] = useState<PayoutRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, { full_name: string; phone: string }>>({});
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async (offset: number) => {
    if (!user?.id) return;
    try {
      const { data, error: qErr } = await supabase
        .from('withdrawal_requests')
        .select(
          'id, amount, status, payout_method, processed_at, created_at, proxy_partner_id, linked_party, user_id, mobile_money_number, mobile_money_provider, mobile_money_name, bank_name, bank_account_number, bank_account_name',
        )
        .not('proxy_partner_id', 'is', null)
        .or(`agent_id.eq.${user.id},initiated_by.eq.${user.id}`)
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);

      if (qErr) throw qErr;

      const list = data || [];
      const mapped: PayoutRow[] = list.map((w: any) => {
        const isBank = (w.payout_method || '').toLowerCase().includes('bank');
        return {
          id: w.id,
          amount: Number(w.amount) || 0,
          status: w.status,
          payout_method: w.payout_method,
          processed_at: w.processed_at,
          created_at: w.created_at,
          partnerId: w.proxy_partner_id || w.linked_party || w.user_id || null,
          destinationLabel: isBank ? 'Bank account' : 'Mobile money',
          destinationValue: isBank
            ? [w.bank_name, w.bank_account_number, w.bank_account_name].filter(Boolean).join(' · ')
            : [w.mobile_money_provider, w.mobile_money_number, w.mobile_money_name].filter(Boolean).join(' · '),
        };
      });

      const partnerIds = Array.from(new Set(mapped.map(r => r.partnerId).filter(Boolean))) as string[];
      const missing = partnerIds.filter(id => !profiles[id]);
      if (missing.length) {
        const { data: profRows } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', missing);
        if (profRows?.length) {
          setProfiles(prev => {
            const next = { ...prev };
            profRows.forEach((p: any) => {
              next[p.id] = { full_name: p.full_name || '', phone: p.phone || '' };
            });
            return next;
          });
        }
      }

      setRows(prev => (offset === 0 ? mapped : [...prev, ...mapped]));
      setHasMore(list.length === PAGE_SIZE);
      setError(null);
    } catch (e: any) {
      setError(e?.message || 'Unable to load recent payouts');
    }
  }, [user?.id, profiles]);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      await load(0);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  const handleLoadMore = async () => {
    setLoadingMore(true);
    await load(rows.length);
    setLoadingMore(false);
  };

  const handleExportPdf = async () => {
    if (!rows.length) return;
    setExporting(true);
    try {
      const blob = await generateProxyRecentPayoutsPdf({
        agentName: (user as any)?.user_metadata?.full_name || undefined,
        rows: rows.map((row) => {
          const profile = row.partnerId ? profiles[row.partnerId] : undefined;
          return {
            name: profile?.full_name || 'Name not available',
            phone: profile?.phone || '',
            destinationLabel: row.destinationLabel,
            destinationValue: row.destinationValue,
            amount: row.amount,
            status: row.status,
            date: row.processed_at || row.created_at,
          };
        }),
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const filename = `welile-proxy-payouts-${new Date().toISOString().slice(0, 10)}.pdf`;
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success('Payout list exported');

      // Exports many recipients' names, phones and payout destinations at
      // once, not logged before this. Plain client-side insert so the
      // audit_logs IP-capture trigger sees the real browser IP directly.
      // Never blocks the actual download.
      (async () => {
        try {
          const { data: { user: actor } } = await supabase.auth.getUser();
          await supabase.from('audit_logs').insert({
            user_id: actor?.id ?? null,
            action_type: 'pdf_report_exported',
            table_name: 'export',
            record_id: null,
            metadata: { filename, row_count: rows.length },
          });
        } catch (e) {
          console.warn('[ProxyRecentPayouts] audit log insert failed:', e);
        }
      })();
    } catch (e: any) {
      toast.error(e?.message || 'Could not export the payout list');
    } finally {
      setExporting(false);
    }
  };

  if (loading) {
    return (
      <Card className="border-border/50">
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1">
        <Receipt className="h-4 w-4 text-muted-foreground" />
        <h3 className="text-sm font-semibold text-foreground">Recent payouts</h3>
        <span className="text-xs text-muted-foreground">({rows.length})</span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto h-7 gap-1 px-2 text-xs"
          onClick={handleExportPdf}
          disabled={exporting || rows.length === 0}
        >
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          PDF
        </Button>
      </div>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="py-4 text-xs text-destructive">{error}</CardContent>
        </Card>
      )}

      {!error && rows.length === 0 && (
        <Card className="border-border/50">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No proxy payouts yet.
          </CardContent>
        </Card>
      )}

      {rows.map((row) => {
        const profile = row.partnerId ? profiles[row.partnerId] : undefined;
        const name = profile?.full_name || 'Name not available';
        const phone = profile?.phone || '';
        const when = row.processed_at || row.created_at;
        return (
          <Card key={row.id} className="border-border/50 shadow-sm">
            <CardContent className="p-4 space-y-2">
              <div className="w-full">
                <p className="text-sm font-semibold text-foreground break-words">{name}</p>
                {phone && (
                  <p className="text-xs text-muted-foreground break-all tabular-nums">{phone}</p>
                )}
              </div>

              <div className="w-full rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
                <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {row.destinationLabel}
                </p>
                <p className="text-xs font-medium text-foreground break-all">
                  {row.destinationValue || 'Not recorded'}
                </p>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-bold tabular-nums text-foreground">{formatAmount(row.amount)}</p>
                <div className="flex items-center gap-2">
                  {statusPill(row.status)}
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {new Date(when).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}

      {hasMore && (
        <Button
          variant="outline"
          size="sm"
          className="w-full gap-1"
          onClick={handleLoadMore}
          disabled={loadingMore}
        >
          {loadingMore && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          Load more
        </Button>
      )}
    </div>
  );
}
