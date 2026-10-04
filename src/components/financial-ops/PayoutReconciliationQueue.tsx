import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import {
  AlertTriangle, Loader2, RefreshCw, ShieldAlert, Clock, ChevronLeft, ChevronRight,
} from 'lucide-react';

/**
 * PHASE 8 — Queue visibility.
 *
 * The Merchant Agent queue stays strictly actionable (see
 * `src/lib/merchantPayoutQueue.ts`). This panel is the *separate* FinOps/CFO
 * reconciliation surface where nothing can hide: every payout that is still
 * processing, failed mid-settlement, marked paid with no money records, only
 * partly recorded, or missing the customer wallet debit shows up here.
 *
 * Read-only by design: it is a visibility guarantee, not a second payout tool.
 */

type Bucket =
  | 'all'
  | 'ledger_gap'
  | 'paid_without_settlement'
  | 'partial_settlement'
  | 'settlement_failed'
  | 'processing';

const BUCKETS: { key: Bucket; label: string; hint: string }[] = [
  { key: 'all', label: 'All', hint: 'Every payout that is not fully settled' },
  { key: 'ledger_gap', label: 'Ledger gap', hint: 'Paid but the customer wallet was never debited' },
  { key: 'paid_without_settlement', label: 'Paid, nothing recorded', hint: 'Marked paid with no money records at all' },
  { key: 'partial_settlement', label: 'Partly recorded', hint: 'Some money records exist, some are missing' },
  { key: 'settlement_failed', label: 'Settlement failed', hint: 'Attempted payout that broke mid-settlement' },
  { key: 'processing', label: 'Processing', hint: 'Claimed and still being paid out' },
];

const BUCKET_TONE: Record<string, string> = {
  ledger_gap: 'bg-destructive/15 text-destructive border-destructive/30',
  paid_without_settlement: 'bg-destructive/10 text-destructive border-destructive/25',
  partial_settlement: 'bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30',
  settlement_failed: 'bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/25',
  processing: 'bg-muted text-muted-foreground border-border',
};

const LEG_LABEL: Record<string, string> = {
  customer_wallet_debit: 'Customer wallet deduction',
  merchant_float_or_out_of_pocket: 'Desk float / own cash',
  merchant_telecom_charge: 'Telecom charge',
  merchant_commission: 'Desk commission',
  withdrawal_not_found: 'Record not found',
};

interface Row {
  withdrawal_id: string;
  bucket: string;
  amount: number;
  status: string;
  settlement_state: string;
  settlement_missing_legs: string[] | null;
  settlement_checked_at: string | null;
  settlement_attempts: number;
  user_id: string | null;
  user_name: string | null;
  user_phone: string | null;
  merchant_id: string | null;
  merchant_name: string | null;
  payout_method: string | null;
  fin_ops_reference: string | null;
  has_payment_evidence: boolean;
  created_at: string;
  processed_at: string | null;
  age_hours: number | null;
  total_count: number;
}

const PAGE_SIZE = 25;

export function PayoutReconciliationQueue() {
  const [bucket, setBucket] = useState<Bucket>('all');
  const [page, setPage] = useState(0);
  const queryClient = useQueryClient();

  const counts = useQuery({
    queryKey: ['payout-recon-counts'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_payout_reconciliation_counts');
      if (error) throw error;
      return (data || {}) as Record<string, number>;
    },
    staleTime: 60_000,
  });

  const rows = useQuery({
    queryKey: ['payout-recon-queue', bucket, page],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_payout_reconciliation_queue', {
        p_bucket: bucket,
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
      });
      if (error) throw error;
      return (data || []) as unknown as Row[];
    },
  });

  const total = rows.data?.[0]?.total_count ? Number(rows.data[0].total_count) : 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['payout-recon-queue'] });
    queryClient.invalidateQueries({ queryKey: ['payout-recon-counts'] });
  };

  const notAuthorized = (rows.error as any)?.message?.includes('not_authorized');

  return (
    <Card className="p-4 sm:p-5 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base sm:text-lg font-bold flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-destructive" />
            Payout reconciliation
          </h3>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1">
            Payouts that are incomplete or unsafe. These never appear in the desk queue —
            they need a finance decision, not another payout attempt.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={refresh} disabled={rows.isFetching}>
          {rows.isFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        {BUCKETS.map((b) => {
          const n = b.key === 'all'
            ? Object.values(counts.data || {}).reduce((s, v) => s + Number(v || 0), 0)
            : Number(counts.data?.[b.key] || 0);
          return (
            <button
              key={b.key}
              onClick={() => { setBucket(b.key); setPage(0); }}
              title={b.hint}
              className={cn(
                'px-3 h-9 rounded-md border text-xs sm:text-sm font-medium transition-colors',
                bucket === b.key
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background hover:bg-muted border-border',
              )}
            >
              {b.label}
              <span className="ml-1.5 opacity-80">{n}</span>
            </button>
          );
        })}
      </div>

      {notAuthorized && (
        <p className="text-sm text-muted-foreground">
          This surface is limited to Finance Ops, CFO and executive roles.
        </p>
      )}

      {rows.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading reconciliation queue…
        </div>
      )}

      {!rows.isLoading && !notAuthorized && (rows.data?.length || 0) === 0 && (
        <p className="text-sm text-muted-foreground py-6">
          Nothing outstanding in this category. Every payout here is fully recorded.
        </p>
      )}

      <div className="space-y-3">
        {(rows.data || []).map((r) => {
          const missing = Array.isArray(r.settlement_missing_legs) ? r.settlement_missing_legs : [];
          return (
            <div key={r.withdrawal_id} className="rounded-lg border p-3 sm:p-4 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="outline" className={cn('text-[11px]', BUCKET_TONE[r.bucket] || '')}>
                    {BUCKETS.find((b) => b.key === r.bucket)?.label || r.bucket}
                  </Badge>
                  <span className="font-bold">{formatUGX(Number(r.amount || 0))}</span>
                  <span className="text-xs text-muted-foreground">
                    status: {r.status} · settlement: {r.settlement_state}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  {r.age_hours != null ? `${r.age_hours}h old` : ''}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs sm:text-sm">
                <div>
                  <span className="text-muted-foreground">Customer: </span>
                  {r.user_name || '—'}{r.user_phone ? ` · ${r.user_phone}` : ''}
                </div>
                <div>
                  <span className="text-muted-foreground">Handled by: </span>
                  {r.merchant_name || 'Not claimed'}
                </div>
                <div>
                  <span className="text-muted-foreground">Method: </span>
                  {r.payout_method || '—'}
                </div>
                <div>
                  <span className="text-muted-foreground">Payment evidence: </span>
                  {r.has_payment_evidence ? 'Yes' : 'None'}
                  {r.fin_ops_reference ? ` · ref ${r.fin_ops_reference}` : ''}
                </div>
                <div>
                  <span className="text-muted-foreground">Requested: </span>
                  {format(new Date(r.created_at), 'dd MMM yyyy HH:mm')}
                </div>
                <div>
                  <span className="text-muted-foreground">Last checked: </span>
                  {r.settlement_checked_at
                    ? `${format(new Date(r.settlement_checked_at), 'dd MMM HH:mm')} (${r.settlement_attempts} checks)`
                    : 'Never'}
                </div>
              </div>

              {missing.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 pt-1">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                  <span className="text-xs text-muted-foreground">Missing:</span>
                  {missing.map((m) => (
                    <Badge key={m} variant="outline" className="text-[11px]">
                      {LEG_LABEL[m] || m}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground">
            Page {page + 1} of {pages} · {total} records
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export default PayoutReconciliationQueue;
