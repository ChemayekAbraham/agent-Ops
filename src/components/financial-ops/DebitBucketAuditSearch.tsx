import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Loader2, Search, ArrowRight, CheckCircle2, XCircle, AlertCircle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

type Attempt = {
  id: string;
  target_user_id: string;
  target_user_name: string | null;
  attempted_bucket: 'withdrawable' | 'float' | 'proxy_withdrawable';
  amount: number;
  available_at_attempt: number;
  outcome: 'insufficient_funds_blocked' | 'switched' | 'succeeded' | 'failed_other';
  switched_to_bucket: 'withdrawable' | 'float' | 'proxy_withdrawable' | null;
  failure_reason: string | null;
  gmail_transaction_id: string | null;
  transaction_reference: string | null;
  created_by_name: string | null;
  created_at: string;
};

function OutcomePill({ outcome }: { outcome: Attempt['outcome'] }) {
  const map: Record<Attempt['outcome'], { cls: string; Icon: any; label: string }> = {
    succeeded: { cls: 'bg-emerald-100 text-emerald-900 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-800', Icon: CheckCircle2, label: 'Succeeded' },
    switched: { cls: 'bg-amber-100 text-amber-900 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-800', Icon: ArrowRight, label: 'Switched' },
    insufficient_funds_blocked: { cls: 'bg-destructive/15 text-destructive border-destructive/30', Icon: XCircle, label: 'Blocked' },
    failed_other: { cls: 'bg-muted text-muted-foreground border-border', Icon: AlertCircle, label: 'Failed' },
  };
  const { cls, Icon, label } = map[outcome];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cls}`}>
      <Icon className="h-3 w-3" />{label}
    </span>
  );
}

/**
 * Search wallet_debit_bucket_attempts by transaction_reference (e.g. MTN
 * TID) or gmail_transaction_id and surface the full per-attempt history
 * so Financial Ops can trace exactly which bucket was tried, why it
 * failed, and what was switched to.
 */
export function DebitBucketAuditSearch() {
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');

  const q = useQuery({
    queryKey: ['debit-bucket-attempts-search', query],
    enabled: query.length > 0,
    queryFn: async () => {
      const term = query.trim();
      const { data, error } = await (supabase.from('wallet_debit_bucket_attempts') as any)
        .select('id, target_user_id, target_user_name, attempted_bucket, amount, available_at_attempt, outcome, switched_to_bucket, failure_reason, gmail_transaction_id, transaction_reference, created_by_name, created_at')
        .or(`transaction_reference.eq.${term},gmail_transaction_id.eq.${term}`)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      return (data ?? []) as Attempt[];
    },
    staleTime: 5_000,
  });

  return (
    <div className="rounded-xl border bg-card p-3 sm:p-4 space-y-3">
      <div>
        <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Debit attempt audit search
        </Label>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Find every bucket attempt for a transaction reference (TID) or Gmail transaction ID.
        </p>
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(input.trim());
        }}
      >
        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="TID or Gmail transaction ID…"
          className="h-10 text-sm"
          autoComplete="off"
        />
        <Button type="submit" className="h-10 gap-1.5" disabled={!input.trim() || q.isFetching}>
          {q.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Search
        </Button>
      </form>

      {query && (
        <div className="space-y-2">
          {q.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : q.error ? (
            <p className="text-xs text-destructive">Search failed: {(q.error as any)?.message ?? 'unknown error'}</p>
          ) : !q.data?.length ? (
            <p className="text-xs text-muted-foreground">No audit rows for <span className="font-mono">{query}</span>.</p>
          ) : (
            <>
              <p className="text-[11px] text-muted-foreground">
                {q.data.length} attempt{q.data.length === 1 ? '' : 's'} for <span className="font-mono">{query}</span>
              </p>
              <ul className="space-y-2">
                {q.data.map((a) => (
                  <li key={a.id} className="rounded-lg border bg-background p-2.5 text-xs space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <OutcomePill outcome={a.outcome} />
                        <span className="font-semibold truncate">{a.target_user_name ?? a.target_user_id}</span>
                      </div>
                      <span className="text-muted-foreground tabular-nums text-[11px]">
                        {new Date(a.created_at).toLocaleString()}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                      <div>
                        <p className="text-muted-foreground">Attempted</p>
                        <p className="font-medium capitalize">{a.attempted_bucket.replace('_', ' ')}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Amount</p>
                        <p className="font-mono font-semibold">{formatUGX(Number(a.amount) || 0)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Available</p>
                        <p className={`font-mono ${Number(a.available_at_attempt) < Number(a.amount) ? 'text-destructive' : ''}`}>
                          {formatUGX(Number(a.available_at_attempt) || 0)}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Switched to</p>
                        <p className="font-medium capitalize">{a.switched_to_bucket?.replace('_', ' ') ?? '—'}</p>
                      </div>
                    </div>
                    {a.failure_reason && (
                      <p className="text-[11px] text-muted-foreground bg-muted/50 rounded px-2 py-1">
                        {a.failure_reason}
                      </p>
                    )}
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                      <span>By {a.created_by_name ?? '—'}</span>
                      {a.transaction_reference && <span className="font-mono">TID {a.transaction_reference}</span>}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}