import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { Bike, CheckCircle2, ChevronDown, ChevronUp, Clock, XCircle } from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { formatUGX } from '@/lib/rentCalculations';
import BikeRepaymentTracker from '@/components/merchandise/BikeRepaymentTracker';


const db = supabase as any;

interface BikeLeaseRow {
  id: string;
  model_type: string | null;
  valuation_amount: number | null;
  total_amount: number | null;
  amount_outstanding: number | null;
  lease_term_months: number | null;
  lease_daily_rate: number | null;
  order_status: string | null;
  rejection_reason: string | null;
  created_at: string;
  coo_approved_at: string | null;
  cfo_disbursed_at: string | null;
  lease_activated_at: string | null;
  tracking_reference: string | null;
}

const STAGES = ['Submitted', 'Approved', 'Bike Disbursed & Active Lease'] as const;

const stageIndex = (status: string) => {
  if (status === 'approved' || status === 'completed' || status === 'processing') return 2;
  if (status === 'coo_approved') return 1;
  return 0;
};

interface Props {
  userId?: string;
  onRequestNewOrder?: () => void;
}

/**
 * Agent-facing realtime tracker for the Spiro electric bike lease:
 * Submitted → Approved → Bike Disbursed & Active Lease.
 */
export default function BikeLeaseStatus({ userId, onRequestNewOrder }: Props) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(true);

  const { data: orders = [] } = useQuery<BikeLeaseRow[]>({
    queryKey: ['my-bike-lease-orders', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await db
        .from('merchandise_sales')
        .select(
          'id, model_type, valuation_amount, total_amount, amount_outstanding, lease_term_months, lease_daily_rate, order_status, rejection_reason, created_at, coo_approved_at, cfo_disbursed_at, lease_activated_at, tracking_reference',
        )
        .eq('customer_id', userId)
        .ilike('item_name', '%Spiro%')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data || []) as BikeLeaseRow[];
    },
  });

  /** Realtime: internal approval and bike release both update this agent's row. */
  useEffect(() => {
    if (!userId) return;
    const channel = supabase
      .channel(`my-bike-lease-${userId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'merchandise_sales', filter: `customer_id=eq.${userId}` },
        () => {
          queryClient.invalidateQueries({ queryKey: ['my-bike-lease-orders', userId] });
          queryClient.invalidateQueries({ queryKey: ['merchandise-recovery-plan', userId] });
          queryClient.invalidateQueries({ queryKey: ['wallet-view', userId] });
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [userId, queryClient]);

  useEffect(() => {
    if (orders.length === 0) {
      setSelectedId(null);
      return;
    }
    if (!selectedId || !orders.some((o) => o.id === selectedId)) setSelectedId(orders[0].id);
  }, [orders, selectedId]);

  const selected = useMemo(
    () => orders.find((o) => o.id === selectedId) ?? orders[0] ?? null,
    [orders, selectedId],
  );

  if (!userId || !selected) return null;

  const status = selected.order_status || 'submitted';
  const rejected = status === 'rejected' || status === 'failed';
  const current = stageIndex(status);
  const valuation = Number(selected.valuation_amount || selected.total_amount || 0);
  const outstanding = Number(selected.amount_outstanding || 0);
  const rate = Number(selected.lease_daily_rate || 0.15);

  const stageDates = [selected.created_at, selected.coo_approved_at, selected.lease_activated_at ?? selected.cfo_disbursed_at];

  return (
    <Card className="border-border">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Bike className="h-4 w-4 text-primary shrink-0" />
            <p className="text-sm font-bold truncate">Spiro bike lease status</p>
          </div>
          <div className="flex items-center gap-1">
            {onRequestNewOrder && rejected && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs border-primary/30 text-primary hover:bg-primary/10"
                onClick={onRequestNewOrder}
              >
                New application
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              aria-label={expanded ? 'Collapse' : 'Expand'}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {expanded && orders.length > 1 && (
          <Select value={selected.id} onValueChange={setSelectedId}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {orders.map((o) => (
                <SelectItem key={o.id} value={o.id} className="text-xs">
                  {format(new Date(o.created_at), 'd MMM yyyy')} · {o.model_type || 'Spiro bike'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {expanded && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="min-w-0">
                <p className="text-sm font-semibold truncate">{selected.model_type || 'Spiro bike'}</p>
                <p className="text-[11px] text-muted-foreground">
                  Valuation {formatUGX(valuation)} · {selected.lease_term_months || 12} month lease
                </p>
                {selected.tracking_reference && (
                  <p className="text-[11px] font-mono text-muted-foreground mt-0.5">
                    Tracking:{' '}
                    <span className="text-foreground font-semibold">{selected.tracking_reference}</span>
                  </p>
                )}
              </div>
              <Badge
                variant="outline"
                className={`gap-1 shrink-0 ${
                  rejected
                    ? 'bg-destructive/15 text-destructive border-destructive/30'
                    : current === 2
                      ? 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30'
                      : current === 1
                        ? 'bg-sky-500/15 text-sky-600 border-sky-500/30'
                        : 'bg-amber-500/15 text-amber-600 border-amber-500/30'
                }`}
              >
                {rejected ? <XCircle className="h-3 w-3" /> : current === 2 ? <CheckCircle2 className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
                {rejected ? 'Rejected' : STAGES[current]}
              </Badge>
            </div>

            {rejected ? (
              <p className="text-[11px] text-destructive">
                {selected.rejection_reason || 'Application rejected. No lease was created.'}
              </p>
            ) : (
              <ol className="space-y-2">
                {STAGES.map((label, i) => {
                  const done = i <= current;
                  const at = stageDates[i];
                  return (
                    <li key={label} className="flex items-start gap-2">
                      <span
                        className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-bold ${
                          done
                            ? 'bg-primary text-primary-foreground border-primary'
                            : 'bg-muted text-muted-foreground border-border'
                        }`}
                      >
                        {done ? '✓' : i + 1}
                      </span>
                      <div className="min-w-0">
                        <p className={`text-xs font-semibold ${done ? '' : 'text-muted-foreground'}`}>{label}</p>
                        {done && at && (
                          <p className="text-[11px] text-muted-foreground">
                            {format(new Date(at), 'd MMM yyyy, HH:mm')}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}

            {current === 2 && !rejected && (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Outstanding lease balance</span>
                  <span className="font-semibold">{formatUGX(outstanding)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Wallet recovery rate</span>
                  <span className="font-semibold">{Math.round(rate * 100)}% per credit</span>
                </div>
              </div>
            )}

            {current === 2 && !rejected && (
              <BikeRepaymentTracker userId={userId} saleId={selected.id} />
            )}

          </div>
        )}
      </CardContent>
    </Card>
  );
}
