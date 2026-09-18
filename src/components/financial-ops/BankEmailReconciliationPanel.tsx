import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronUp, Clock, Mail, Minus, Plus, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { format } from 'date-fns';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

interface EmailMovement {
  id: string;
  direction: 'in' | 'out';
  amount: number;
  extracted_at: string | null;
  transaction_id: string | null;
  subject: string | null;
  from_name: string | null;
  from_email: string | null;
  snippet: string | null;
  match_reason: string;
}

interface BankReconciliation {
  extracted_received: number;
  extracted_sent: number;
  extracted_net: number;
  money_at_bank_total: number;
  received_count: number;
  sent_count: number;
  qualifying_emails: EmailMovement[];
  computed_at: string;
}

function fmtDate(value: string | null) {
  if (!value) return 'No timestamp';
  return format(new Date(value), 'd MMM yyyy, HH:mm');
}

export function BankEmailReconciliationPanel() {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['money-at-bank-reconciliation'],
    queryFn: async (): Promise<BankReconciliation> => {
      const { data: result, error: rpcError } = await supabase.rpc('get_money_at_bank_reconciliation' as any);
      if (rpcError) throw rpcError;
      const value = (result ?? {}) as any;
      return {
        extracted_received: Number(value.extracted_received ?? 0),
        extracted_sent: Number(value.extracted_sent ?? 0),
        extracted_net: Number(value.extracted_net ?? 0),
        money_at_bank_total: Number(value.money_at_bank_total ?? 0),
        received_count: Number(value.received_count ?? 0),
        sent_count: Number(value.sent_count ?? 0),
        qualifying_emails: Array.isArray(value.qualifying_emails) ? value.qualifying_emails : [],
        computed_at: String(value.computed_at ?? new Date().toISOString()),
      };
    },
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: false,
  });

  const mismatch = data ? data.money_at_bank_total - data.extracted_net : 0;
  const hasMismatch = Math.abs(mismatch) >= 1;
  const latestMovementAt = data?.qualifying_emails.length
    ? data.qualifying_emails.reduce<string | null>((latest, email) => {
        if (!email.extracted_at) return latest;
        return !latest || email.extracted_at > latest ? email.extracted_at : latest;
      }, null)
    : null;

  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Mail className="h-4 w-4 text-primary shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-semibold text-foreground">Bayo Mercy account reconciliation</p>
            <p className="text-[11px] text-muted-foreground truncate">
              Account balance: credits in less debits out
            </p>
            <Badge variant="secondary" className="mt-1 gap-1 px-1.5 py-0.5 text-[10px] font-normal">
              <Clock className="h-3 w-3" />
              {latestMovementAt ? `Latest movement: ${fmtDate(latestMovementAt)}` : 'No movements found yet'}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => refetch()}
            disabled={isFetching}
            aria-label="Refresh bank email reconciliation"
            title="Refresh reconciliation"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setExpanded((value) => !value)}
            aria-label={expanded ? 'Hide bank email reconciliation' : 'Show bank email reconciliation'}
            title={expanded ? 'Hide audit details' : 'Show audit details'}
          >
            {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
        </div>
      </div>

      {isLoading && <p className="mt-3 text-xs text-muted-foreground">Loading extracted email reconciliation…</p>}
      {error && <p className="mt-3 text-xs text-destructive">Unable to load extracted bank emails.</p>}

      {data && (
        <>
           <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
             <Metric label="Credits into account" value={data.extracted_received} tone="success" />
             <Metric label="Debits out of account" value={data.extracted_sent} tone="destructive" />
             <Metric label="Money at Bank" value={data.money_at_bank_total} tone={data.money_at_bank_total < 0 ? 'destructive' : 'primary'} />
           </div>

          <div className={cn(
            'mt-3 flex items-start gap-2 rounded-lg border px-3 py-2.5',
            hasMismatch ? 'border-destructive/30 bg-destructive/5' : 'border-success/25 bg-success/5',
          )}>
            {hasMismatch ? <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive shrink-0" /> : <CheckCircle2 className="mt-0.5 h-4 w-4 text-success shrink-0" />}
            <div className="min-w-0">
              <p className={cn('text-xs font-semibold', hasMismatch ? 'text-destructive' : 'text-success')}>
                {hasMismatch ? 'Mismatch detected' : 'Reconciled'}
              </p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                 {hasMismatch
                   ? `The bucket differs from the extracted Bayo Mercy account balance by ${formatUGX(Math.abs(mismatch))}.`
                   : 'Money at Bank equals qualifying credits into Bayo Mercy’s account less debits out.'}
              </p>
            </div>
          </div>

          {expanded && (
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                 <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Bayo Mercy account alerts</p>
                 <Badge variant="outline" className="text-[10px]">
                   {data.qualifying_emails.length} records
                 </Badge>
               </div>
               <div className="max-h-80 overflow-y-auto divide-y divide-border rounded-lg border border-border">
                 {data.qualifying_emails.length === 0 && (
                   <p className="p-4 text-center text-xs text-muted-foreground">No qualifying Bayo Mercy account alerts found.</p>
                )}
                {data.qualifying_emails.map((email) => {
                  const incoming = email.direction === 'in';
                  return (
                    <div key={email.id} className="p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-2">
                          <span className={cn('mt-0.5 rounded-md p-1.5', incoming ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive')}>
                            {incoming ? <Plus className="h-3.5 w-3.5" /> : <Minus className="h-3.5 w-3.5" />}
                          </span>
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-foreground">
                              {incoming ? 'Credit into Bayo Mercy account' : 'Debit from Bayo Mercy account'}
                            </p>
                            <p className="text-[11px] text-muted-foreground">{fmtDate(email.extracted_at)}</p>
                          </div>
                        </div>
                        <p className={cn('shrink-0 font-mono text-xs font-semibold tabular-nums', incoming ? 'text-success' : 'text-destructive')}>
                          {incoming ? '+' : '-'}{formatUGX(email.amount)}
                        </p>
                      </div>
                      <div className="mt-2 pl-8">
                        <p className="text-[10px] text-muted-foreground">{email.match_reason}{email.transaction_id ? ` • ${email.transaction_id}` : ''}</p>
                        {email.subject && <p className="mt-1 truncate text-[11px] text-foreground">{email.subject}</p>}
                        {email.snippet && <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{email.snippet}</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <p className="text-[10px] text-muted-foreground">Extracted {fmtDate(data.computed_at)} • Money at Bank is the Bayo Mercy account balance: credits in less debits out.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'success' | 'destructive' | 'primary' }) {
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-2.5 py-2">
      <p className="truncate text-[10px] text-muted-foreground">{label}</p>
      <p className={cn(
        'mt-0.5 truncate font-mono text-[11px] font-semibold tabular-nums',
        tone === 'success' && 'text-success',
        tone === 'destructive' && 'text-destructive',
        tone === 'primary' && 'text-primary',
        tone === 'default' && 'text-foreground',
      )}>{formatUGX(value)}</p>
    </div>
  );
}
