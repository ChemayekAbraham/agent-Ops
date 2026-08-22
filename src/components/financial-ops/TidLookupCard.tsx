/**
 * TID Lookup — "does this transaction reference exist anywhere in our system?"
 *
 * Calls the `lookup_transaction_id` backend function, which compares on the
 * DIGIT TAIL only (so `TID154530114386`, `154530114386` and `MP154530114386`
 * all resolve to the same record) across:
 *   • incoming receipt emails (gmail_transactions)
 *   • deposit submissions (deposit_requests)
 *   • money movements (general_ledger)
 *   • email routing / re-route history
 *   • withdrawal requests
 */
import { useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Loader2, Search, CheckCircle2, XCircle, ScanSearch } from 'lucide-react';
import { format } from 'date-fns';
import { useToast } from '@/hooks/use-toast';

const fmtUgx = (n: number | null | undefined) =>
  n === null || n === undefined ? '—' : `UGX ${Math.round(Number(n)).toLocaleString()}`;

const fmtWhen = (v: string | null | undefined) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '—' : format(d, 'd MMM yyyy HH:mm');
};

interface LookupResult {
  query: string;
  digits: string;
  found: boolean;
  error?: string;
  emails: Record<string, unknown>[];
  deposits: Record<string, unknown>[];
  ledger: Record<string, unknown>[];
  routing: Record<string, unknown>[];
  withdrawals: Record<string, unknown>[];
}

function Section({
  title,
  rows,
  render,
}: {
  title: string;
  rows: Record<string, unknown>[];
  render: (r: Record<string, unknown>) => React.ReactNode;
}) {
  return (
    <div className="rounded-lg border bg-muted/20 p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold">{title}</span>
        <Badge variant={rows.length ? 'default' : 'outline'} className="text-[10px]">
          {rows.length}
        </Badge>
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">No match</p>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r, i) => (
            <div key={String(r.id ?? i)} className="text-[11px] leading-snug border-t pt-1.5 first:border-0 first:pt-0">
              {render(r)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function TidLookupCard() {
  const { toast } = useToast();
  const [tid, setTid] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LookupResult | null>(null);

  const run = async () => {
    const value = tid.trim();
    if (!value) return;
    setLoading(true);
    setResult(null);
    const { data, error } = await supabase.rpc('lookup_transaction_id' as never, {
      p_tid: value,
    } as never);
    setLoading(false);
    if (error) {
      toast({
        title: 'Lookup failed',
        description: error.message.includes('not_authorized')
          ? 'Your role cannot run transaction lookups.'
          : error.message,
        variant: 'destructive',
      });
      return;
    }
    setResult(data as unknown as LookupResult);
  };

  return (
    <div className="rounded-xl border bg-card p-3 space-y-3">
      <div className="flex items-center gap-2">
        <ScanSearch className="h-4 w-4 text-primary" />
        <div className="min-w-0">
          <h3 className="text-sm font-semibold">Check a TID</h3>
          <p className="text-[11px] text-muted-foreground">
            Digit-exact search across receipt emails, deposits, ledger, routing history and withdrawals.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input
          value={tid}
          onChange={(e) => setTid(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') run();
          }}
          placeholder="e.g. TID154530114386"
          className="h-9 flex-1 min-w-[180px] font-mono text-xs"
        />
        <Button onClick={run} disabled={loading || !tid.trim()} className="h-9 gap-2">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          Check
        </Button>
      </div>

      {result && (
        <div className="space-y-2">
          <div
            className={`flex items-center gap-2 rounded-lg border p-2 text-xs ${
              result.found ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-destructive/40 bg-destructive/10'
            }`}
          >
            {result.found ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            ) : (
              <XCircle className="h-4 w-4 text-destructive" />
            )}
            <span className="font-medium">
              {result.error === 'tid_too_short'
                ? 'Enter at least 5 digits of the reference.'
                : result.found
                  ? `Found — digits ${result.digits}`
                  : `Not found anywhere — digits ${result.digits}`}
            </span>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <Section
              title="Receipt emails"
              rows={result.emails ?? []}
              render={(r) => (
                <>
                  <div className="font-mono">{String(r.transaction_id ?? '—')} · {fmtUgx(r.amount as number)}</div>
                  <div className="text-muted-foreground">
                    {String(r.channel ?? '—')} · {String(r.direction ?? '—')} · {fmtWhen(r.received_at as string)}
                  </div>
                  <div className="text-muted-foreground">
                    {r.linked_deposit_request_id ? `Linked to a deposit (${String(r.auto_match_method ?? 'manual')})` : 'Not linked to a deposit'}
                  </div>
                </>
              )}
            />
            <Section
              title="Deposit submissions"
              rows={result.deposits ?? []}
              render={(r) => (
                <>
                  <div className="font-medium">{String(r.user_name ?? 'Unknown user')} · {fmtUgx(r.amount as number)}</div>
                  <div className="text-muted-foreground">
                    {String(r.status ?? '—')} · {String(r.purpose ?? '—')} · {fmtWhen(r.created_at as string)}
                  </div>
                </>
              )}
            />
            <Section
              title="Money movements (ledger)"
              rows={result.ledger ?? []}
              render={(r) => (
                <>
                  <div className="font-medium">
                    {String(r.user_name ?? 'Platform')} · {String(r.direction ?? '—')} {fmtUgx(r.amount as number)}
                  </div>
                  <div className="text-muted-foreground">
                    {String(r.category ?? '—')} · {String(r.ledger_scope ?? '—')}
                    {r.wallet_bucket ? ` · ${String(r.wallet_bucket)}` : ''} · {fmtWhen(r.created_at as string)}
                  </div>
                  <div className="text-muted-foreground break-words">{String(r.description ?? '')}</div>
                </>
              )}
            />
            <Section
              title="Routing history"
              rows={result.routing ?? []}
              render={(r) => (
                <>
                  <div className="font-medium">
                    {String(r.route ?? '—')} → {String(r.target_user_name ?? '—')} · {fmtUgx(r.amount as number)}
                  </div>
                  <div className="text-muted-foreground">{fmtWhen(r.created_at as string)}</div>
                  <div className="text-muted-foreground break-words">{String(r.reason ?? '')}</div>
                </>
              )}
            />
            <Section
              title="Withdrawals"
              rows={result.withdrawals ?? []}
              render={(r) => (
                <>
                  <div className="font-medium">{String(r.user_name ?? '—')} · {fmtUgx(r.amount as number)}</div>
                  <div className="text-muted-foreground">
                    {String(r.status ?? '—')} · {fmtWhen(r.created_at as string)}
                  </div>
                </>
              )}
            />
          </div>
        </div>
      )}
    </div>
  );
}
