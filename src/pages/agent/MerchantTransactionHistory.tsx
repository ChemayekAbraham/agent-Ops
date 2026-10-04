import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUGX } from '@/lib/rentCalculations';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { format } from 'date-fns';
import { ArrowLeft, History, Search, Loader2, FileX, Copy } from 'lucide-react';
import { toast } from 'sonner';

type Row = {
  id: string;
  amount: number;
  processed_at: string | null;
  transaction_id: string | null;
  payout_method: string | null;
  user_id: string;
  customer_name: string;
  customer_phone: string | null;
};

const PAGE = 25;

/**
 * Merchant Agent Transaction History — every payout this merchant has processed
 * with customer name, phone, amount, date/time and telecom TID.
 */
export default function MerchantTransactionHistory() {
  const navigate = useNavigate();
  const { user, loading: authLoading } = useAuth();
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const [visible, setVisible] = useState(PAGE);

  const { data: rows, isLoading } = useQuery({
    queryKey: ['merchant-transaction-history', user?.id],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async () => {
      if (!user) return [] as Row[];
      const { data: wrs, error } = await supabase
        .from('withdrawal_requests')
        .select('id, amount, processed_at, transaction_id, payout_method, user_id')
        .eq('processed_by', user.id)
        .eq('status', 'completed')
        .not('processed_at', 'is', null)
        .order('processed_at', { ascending: false })
        .limit(500);
      if (error) throw error;
      const list = (wrs || []) as any[];
      const ids = Array.from(new Set(list.map((r) => r.user_id).filter(Boolean)));
      const byId = new Map<string, { name: string; phone: string | null }>();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        for (const p of (profs || []) as any[]) {
          byId.set(p.id, { name: p.full_name || 'Customer', phone: p.phone ?? null });
        }
      }
      return list.map((r) => {
        const p = byId.get(r.user_id);
        return {
          id: String(r.id),
          amount: Number(r.amount || 0),
          processed_at: r.processed_at ?? null,
          transaction_id: r.transaction_id ?? null,
          payout_method: r.payout_method ?? null,
          user_id: r.user_id,
          customer_name: p?.name || 'Customer',
          customer_phone: p?.phone ?? null,
        } as Row;
      });
    },
  });

  const filtered = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    if (!q) return rows || [];
    return (rows || []).filter((r) =>
      r.customer_name.toLowerCase().includes(q) ||
      (r.customer_phone || '').toLowerCase().includes(q) ||
      (r.transaction_id || '').toLowerCase().includes(q) ||
      String(r.amount).includes(q),
    );
  }, [rows, debouncedSearch]);

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(`${label} copied`);
    } catch {
      toast.error('Copy failed');
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
              <History className="h-5 w-5 text-primary" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-bold leading-tight truncate">Transaction History</h1>
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
            placeholder="Search by name, phone, TID or amount"
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
            <p className="text-sm font-semibold">No transactions yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              {debouncedSearch ? 'No transactions match your search.' : 'Payouts you confirm will appear here.'}
            </p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {filtered.slice(0, visible).map((r) => {
                const dt = r.processed_at ? new Date(r.processed_at) : null;
                return (
                  <div key={r.id} className="rounded-2xl border border-border bg-card px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground truncate">{r.customer_name}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {r.customer_phone || 'No phone on file'}
                        </p>
                      </div>
                      <p className="text-sm font-bold tabular-nums text-foreground shrink-0">
                        {formatUGX(r.amount)}
                      </p>
                    </div>
                    <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                      <div className="text-muted-foreground">
                        <span className="uppercase tracking-wider font-semibold">Date</span>
                        <p className="text-foreground font-medium">
                          {dt ? format(dt, 'MMM d, yyyy') : '—'}
                        </p>
                      </div>
                      <div className="text-muted-foreground">
                        <span className="uppercase tracking-wider font-semibold">Time</span>
                        <p className="text-foreground font-medium">
                          {dt ? format(dt, 'HH:mm') : '—'}
                        </p>
                      </div>
                      <div className="col-span-2 text-muted-foreground">
                        <span className="uppercase tracking-wider font-semibold">TID</span>
                        {r.transaction_id ? (
                          <button
                            type="button"
                            onClick={() => copy(r.transaction_id!, 'TID')}
                            className="mt-0.5 flex items-center gap-1.5 text-foreground font-mono font-medium hover:text-primary"
                          >
                            <span className="truncate">{r.transaction_id}</span>
                            <Copy className="h-3 w-3 shrink-0" />
                          </button>
                        ) : (
                          <p className="text-foreground/70 italic">Not recorded</p>
                        )}
                      </div>
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