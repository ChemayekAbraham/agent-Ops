import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Clock, Copy, Inbox, Loader2, RefreshCw, Search } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useToast } from '@/hooks/use-toast';

interface PendingRow {
  id: string;
  user_id: string;
  amount: number;
  provider: string | null;
  transaction_id: string | null;
  created_at: string;
  deposit_purpose: string | null;
  notes: string | null;
  full_name?: string | null;
  phone?: string | null;
}

const fmtUgx = (n: number | null | undefined) =>
  n == null ? '—' : `UGX ${Math.round(n).toLocaleString()}`;

/**
 * Live queue of every user deposit request still sitting on `pending`.
 *
 * Previously the User Deposits tab only surfaced deposits once a Gmail
 * receipt arrived, so a submitted TID with no matching receipt yet was
 * invisible to Financial Ops. This panel is the raw truth: it lists all
 * pending requests regardless of whether the auto-matcher has seen them.
 */
export function PendingUserDepositsPanel() {
  const { toast } = useToast();
  const [rows, setRows] = useState<PendingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('deposit_requests')
      .select('id,user_id,amount,provider,transaction_id,created_at,deposit_purpose,notes')
      .eq('status', 'pending')
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) {
      setLoading(false);
      toast({ title: 'Could not load pending deposits', description: error.message, variant: 'destructive' });
      return;
    }
    const list = (data ?? []) as PendingRow[];
    const ids = Array.from(new Set(list.map((r) => r.user_id).filter(Boolean)));
    if (ids.length > 0) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id,full_name,phone')
        .in('id', ids);
      const map = new Map((profs ?? []).map((p: any) => [p.id, p]));
      for (const r of list) {
        const p = map.get(r.user_id);
        r.full_name = p?.full_name ?? null;
        r.phone = p?.phone ?? null;
      }
    }
    setRows(list);
    setLoading(false);
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const term = search.trim().toLowerCase();
  const filtered = term
    ? rows.filter((r) =>
        [r.transaction_id, r.full_name, r.phone, String(r.amount), r.provider]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(term)),
      )
    : rows;

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: 'Transaction ID copied' });
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  };

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-3 sm:p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="secondary" className="rounded-full">
          {loading ? '…' : `${filtered.length} pending`}
        </Badge>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          <span className="ml-1.5">Refresh</span>
        </Button>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search TID, name, phone or amount"
          className="pl-9"
        />
      </div>

      {!loading && filtered.length === 0 && (
        <div className="py-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
          <Inbox className="h-5 w-5" />
          No pending user deposits.
        </div>
      )}

      <div className="space-y-2">
        {filtered.map((r) => (
          <div
            key={r.id}
            className="rounded-xl border border-border/60 p-3 flex flex-col gap-1.5"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-sm truncate">
                  {r.full_name || 'Unknown depositor'}
                </p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {r.phone || '—'} · {(r.provider || 'unknown').toUpperCase()}
                  {r.deposit_purpose ? ` · ${r.deposit_purpose.replace(/_/g, ' ')}` : ''}
                </p>
              </div>
              <p className="font-bold text-sm shrink-0">{fmtUgx(r.amount)}</p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-mono text-muted-foreground truncate">
                TID {r.transaction_id || '—'}
              </span>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}
                </span>
                {r.transaction_id && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2"
                    onClick={() => copy(r.transaction_id as string)}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
