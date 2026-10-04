import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUGX } from '@/lib/rentCalculations';
import { downloadPayoutReceiptPdf, receiptMethodLabel, type PayoutReceiptData } from '@/lib/payoutReceiptPdf';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { format } from 'date-fns';
import { toast } from 'sonner';
import {
  ArrowLeft, ReceiptText, Search, Loader2, Download, ExternalLink,
  Banknote, Smartphone, Landmark, FileX,
} from 'lucide-react';

type PayoutRow = {
  id: string;
  amount: number;
  payout_method: string | null;
  processed_at: string | null;
  user_id: string;
  customer_name: string;
};

const PAGE = 20;

/**
 * Receipt History — every payout this merchant agent has processed, each with a
 * one-tap PDF download and a link to the public receipt page. Receipts are the
 * customer-facing document, so no commission is shown here. Lists withdrawals
 * where processed_by = this agent (stamped by approve-withdrawal on payout).
 */
export default function PayoutReceiptHistory() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [visible, setVisible] = useState(PAGE);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const { data: rows, isLoading } = useQuery({
    queryKey: ['merchant-receipt-history', user?.id],
    queryFn: async () => {
      if (!user) return [] as PayoutRow[];
      const { data: wrs, error } = await supabase
        .from('withdrawal_requests')
        .select('id, amount, payout_method, processed_at, user_id')
        .eq('processed_by', user.id)
        .eq('status', 'completed')
        .not('processed_at', 'is', null)
        .order('processed_at', { ascending: false })
        .limit(300);
      if (error) throw error;
      const list = (wrs || []) as any[];
      const ids = Array.from(new Set(list.map((r) => r.user_id).filter(Boolean)));
      const nameById = new Map<string, string>();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', ids);
        for (const p of (profs || []) as any[]) nameById.set(p.id, p.full_name);
      }
      return list.map((r) => ({
        id: String(r.id),
        amount: Number(r.amount || 0),
        payout_method: r.payout_method ?? null,
        processed_at: r.processed_at ?? null,
        user_id: r.user_id,
        customer_name: nameById.get(r.user_id) || 'Customer',
      })) as PayoutRow[];
    },
    enabled: !!user,
    staleTime: 30_000,
  });

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return rows || [];
    return (rows || []).filter((r) =>
      r.customer_name.toLowerCase().includes(q) ||
      String(r.amount).includes(q) ||
      (r.payout_method || '').toLowerCase().includes(q),
    );
  }, [rows, debouncedSearch]);

  const methodIcon = (method?: string | null) => {
    const { isBank, isMoMo } = receiptMethodLabel(method || undefined);
    if (isBank) return <Landmark className="h-4 w-4 text-primary" />;
    if (isMoMo) return <Smartphone className="h-4 w-4 text-primary" />;
    return <Banknote className="h-4 w-4 text-primary" />;
  };

  const handleDownload = async (id: string) => {
    setDownloadingId(id);
    try {
      const { data: res, error } = await supabase.rpc('get_payout_receipt', { p_withdrawal_id: id });
      if (error) throw error;
      const receipt = res as unknown as PayoutReceiptData;
      if (!receipt || !receipt.paid) {
        toast.error('Receipt not available for this payout yet.');
        return;
      }
      await downloadPayoutReceiptPdf(receipt);
    } catch (e: any) {
      toast.error(e?.message || 'Could not prepare the receipt PDF.');
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="min-h-[100dvh] bg-background flex flex-col">
      <header className="sticky top-0 z-20 bg-background/90 backdrop-blur-md border-b border-border">
        <div className="mx-auto w-full max-w-md px-4 py-3 flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate(-1)}
            aria-label="Go back"
            className="h-11 w-11 shrink-0 rounded-full"
          >
            <ArrowLeft className="h-6 w-6" />
          </Button>
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10">
              <ReceiptText className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold leading-tight truncate">Receipt History</h1>
              <p className="text-sm text-muted-foreground leading-tight">Every payout you have processed</p>
            </div>
          </div>
        </div>
      </header>

      <main className="flex-1 mx-auto w-full max-w-md px-4 py-4 pb-24 space-y-4">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by customer, amount or method"
            className="pl-9 rounded-xl"
          />
        </div>

        {(authLoading || isLoading) ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <FileX className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-sm font-semibold">No receipts yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              {debouncedSearch ? 'No payouts match your search.' : 'Payouts you confirm will appear here with download links.'}
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {filtered.slice(0, visible).map((r) => {
                const { methodLabel } = receiptMethodLabel(r.payout_method || undefined);
                return (
                  <div key={r.id} className="rounded-2xl border border-border bg-card px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2.5 min-w-0">
                        <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                          {methodIcon(r.payout_method)}
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">{r.customer_name}</p>
                          <p className="text-xs text-muted-foreground truncate">
                            {methodLabel} · {r.processed_at ? format(new Date(r.processed_at), 'MMM d, yyyy HH:mm') : '—'}
                          </p>
                        </div>
                      </div>
                      <p className="text-sm font-bold tabular-nums text-foreground shrink-0">{formatUGX(r.amount)}</p>
                    </div>
                    <div className="mt-2.5 grid grid-cols-2 gap-2">
                      <Button
                        variant="default"
                        size="sm"
                        onClick={() => handleDownload(r.id)}
                        disabled={downloadingId === r.id}
                        className="rounded-xl h-9"
                      >
                        {downloadingId === r.id
                          ? <Loader2 className="h-4 w-4 animate-spin" />
                          : <Download className="h-4 w-4" />}
                        <span className="ml-1.5">PDF</span>
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => navigate(`/receipt/${r.id}`)}
                        className="rounded-xl h-9"
                      >
                        <ExternalLink className="h-4 w-4" />
                        <span className="ml-1.5">View</span>
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
            {visible < filtered.length && (
              <div className="flex justify-center pt-1">
                <button
                  type="button"
                  onClick={() => setVisible((v) => v + PAGE)}
                  className="text-sm font-semibold text-primary hover:underline"
                >
                  Show more
                </button>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
