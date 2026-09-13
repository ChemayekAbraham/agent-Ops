import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import {
  Bike,
  Calendar,
  Check,
  Clock,
  Edit3,
  FileText,
  Phone,
  ShieldAlert,
  ShieldCheck,
  User,
  X,
  CreditCard,
  Hash,
  AlertCircle,
} from 'lucide-react';

import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { formatUGX } from '@/lib/rentCalculations';
import { SPIRO_LEASE_PERIODS } from '@/lib/spiroBikeLease';

const db = supabase as any;

export interface BikeLeaseDetailRow {
  id: string;
  customer_id: string | null;
  client_name: string | null;
  client_phone: string | null;
  model_type: string | null;
  valuation_amount: number | null;
  payment_projection: number | null;
  lease_term_months: number | null;
  lease_daily_rate: number | null;
  amount_outstanding: number | null;
  amount_paid: number | null;
  order_status: string;
  rejection_reason: string | null;
  created_at: string;
  ops_approved_at?: string | null;
  coo_approved_at: string | null;
  cfo_disbursed_at: string | null;
  lease_activated_at: string | null;
  disbursed_amount: number | null;
  tracking_reference: string | null;
}

const STATUS_TONE: Record<string, string> = {
  submitted: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  pending_approval: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
  ops_approved: 'bg-indigo-500/15 text-indigo-600 border-indigo-500/30',
  coo_approved: 'bg-sky-500/15 text-sky-600 border-sky-500/30',
  approved: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  completed: 'bg-emerald-500/15 text-emerald-600 border-emerald-500/30',
  rejected: 'bg-destructive/15 text-destructive border-destructive/30',
};

const STATUS_LABEL: Record<string, string> = {
  submitted: 'Submitted — awaiting Agent Ops',
  pending_approval: 'Submitted — awaiting Agent Ops',
  ops_approved: 'Agent Ops verified — awaiting COO',
  coo_approved: 'COO approved — awaiting CFO',
  approved: 'Funds disbursed & active lease',
  completed: 'Lease completed',
  rejected: 'Rejected',
};

interface Props {
  order: BikeLeaseDetailRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApprove?: (order: BikeLeaseDetailRow) => void;
  onReject?: (order: BikeLeaseDetailRow) => void;
  onEditPrice?: (order: BikeLeaseDetailRow) => void;
  stage?: 'ops' | 'coo' | 'cfo';
}

export function BikeLeaseDetailDialog({
  order,
  open,
  onOpenChange,
  onApprove,
  onReject,
  onEditPrice,
  stage,
}: Props) {
  if (!order) return null;

  const isOps = !stage || stage === 'ops';

  const valuationNum = Number(order.valuation_amount || 0);
  const termNum = Number(order.lease_term_months || 12);
  const period = SPIRO_LEASE_PERIODS.find((p) => p.months === termNum);
  const feePct = period?.feePct ?? (termNum <= 3 ? 33 : termNum <= 6 ? 36 : termNum <= 9 ? 39 : 42);
  const monthly = termNum > 0 && valuationNum > 0 ? Math.round(valuationNum / termNum) : 0;
  const outstanding = Number(order.amount_outstanding ?? valuationNum);
  const paid = Number(order.amount_paid || 0);
  const costPrice = Math.round(valuationNum / (1 + feePct / 100));
  const days = termNum * 30;
  const dailyPay = days > 0 ? Math.ceil(valuationNum / days) : 0;
  const profit = Math.max(0, valuationNum - costPrice);

  const isPending = order.order_status === 'submitted' || order.order_status === 'pending_approval';
  const isAwaitingCoo = order.order_status === 'ops_approved';
  const isAwaitingCfo = order.order_status === 'coo_approved';
  const isOpen = isPending || isAwaitingCoo || isAwaitingCfo;

  const canAct =
    stage === 'ops'
      ? isPending
      : stage === 'coo'
        ? isAwaitingCoo
        : stage === 'cfo'
          ? isAwaitingCfo
          : isOpen;


  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn(
          'app-dialog-bottom-sheet',
          '!left-0 !right-0 !top-auto !bottom-0',
          '!translate-x-0 !translate-y-0',
          '!max-w-none !w-full',
          '!rounded-t-3xl !rounded-b-none',
          '!p-0 !gap-0',
          'h-[88dvh] max-h-[88dvh]',
          'flex flex-col overflow-hidden',
          'pointer-events-auto',
          'sm:!left-[50%] sm:!top-[50%] sm:!bottom-auto sm:!right-auto',
          'sm:!translate-x-[-50%] sm:!translate-y-[-50%]',
          'sm:!max-w-lg sm:!w-full',
          'sm:!rounded-2xl',
          'sm:h-auto sm:max-h-[90dvh]'
        )}
      >
        {/* Mobile drag handle */}
        <div className="sm:hidden flex justify-center pt-2 pb-1 shrink-0">
          <div className="h-1.5 w-12 rounded-full bg-muted-foreground/30" />
        </div>

        {/* Dialog Header */}
        <DialogHeader className="px-4 sm:px-6 pt-2 pb-3.5 border-b border-border/50 shrink-0 pr-12 sm:pr-10 text-left">
          <div className="flex items-start gap-3">
            <div className="h-10 w-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0 border border-primary/20 shadow-xs mt-0.5">
              <Bike className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <DialogTitle className="text-base sm:text-lg font-bold text-foreground capitalize tracking-tight leading-snug truncate">
                {order.client_name || 'Agent Application'}
              </DialogTitle>

              <div className="flex items-center gap-1.5 text-xs text-muted-foreground truncate">
                <Phone className="h-3.5 w-3.5 text-muted-foreground/70 shrink-0" />
                <span className="font-medium text-foreground/80">{order.client_phone || 'No phone'}</span>
                {order.tracking_reference && (
                  <>
                    <span className="text-muted-foreground/40">·</span>
                    <span className="font-mono text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">
                      {order.tracking_reference}
                    </span>
                  </>
                )}
              </div>

              <div className="flex items-center gap-2 pt-0.5 flex-wrap">
                <Badge
                  variant="outline"
                  className={`text-[11px] font-semibold px-2 py-0.5 ${STATUS_TONE[order.order_status] || ''}`}
                >
                  {STATUS_LABEL[order.order_status] || order.order_status.replace(/_/g, ' ')}
                </Badge>
                <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3 text-muted-foreground/60 shrink-0" />
                  Submitted {format(new Date(order.created_at), 'd MMM yyyy, HH:mm')}
                </span>
              </div>
            </div>
          </div>
        </DialogHeader>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 sm:p-6 space-y-3.5 text-xs overscroll-contain">
          {/* SECTION 1: BIKE & VALUATION DETAILS */}
          <div className="rounded-xl border bg-card p-3 sm:p-4 space-y-3 shadow-xs overflow-hidden">
            <div className="flex items-center justify-between gap-2 pb-0.5 border-b border-border/40">
              <div className="flex items-center gap-2 min-w-0">
                <div className="h-6 w-6 rounded-md bg-primary/10 text-primary flex items-center justify-center shrink-0">
                  <Bike className="h-3.5 w-3.5" />
                </div>
                <h3 className="text-xs font-bold text-foreground truncate">
                  Motor Bike &amp; Financial Terms
                </h3>
              </div>
              {onEditPrice && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2.5 text-xs font-semibold gap-1.5 rounded-lg border-primary/30 text-primary hover:bg-primary/10 transition-colors shrink-0"
                  onClick={() => onEditPrice(order)}
                >
                  <Edit3 className="h-3 w-3" /> Edit Price
                </Button>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1 min-w-0 overflow-hidden">
                <p className="text-[11px] font-medium text-muted-foreground truncate">Bike Model</p>
                <p className="text-xs sm:text-sm font-bold text-foreground truncate">
                  {order.model_type || 'Spiro bike'}
                </p>
              </div>

              <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1 min-w-0 overflow-hidden">
                <p className="text-[11px] font-medium text-muted-foreground truncate">
                  {isOps ? 'Bike Cost Price' : 'Valuation Amount'}
                </p>
                <p className="text-xs sm:text-sm font-bold text-primary truncate">
                  {formatUGX(isOps ? costPrice : valuationNum)}
                </p>
              </div>

              {isOps && (
                <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1 min-w-0 overflow-hidden">
                  <p className="text-[11px] font-medium text-muted-foreground truncate">Estimated Daily Pay</p>
                  <p className="text-xs sm:text-sm font-bold text-foreground truncate">
                    {formatUGX(dailyPay)}/day
                  </p>
                </div>
              )}

              <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1 min-w-0 overflow-hidden">
                <p className="text-[11px] font-medium text-muted-foreground truncate">Lease Term</p>
                <p className="text-xs sm:text-sm font-bold text-foreground truncate">{termNum} Months</p>
              </div>

              <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1 min-w-0 overflow-hidden">
                <p className="text-[11px] font-medium text-muted-foreground truncate">Monthly Estimate</p>
                <p className="text-xs sm:text-sm font-bold text-foreground truncate">{formatUGX(monthly)}/mo</p>
              </div>

              <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1 min-w-0 overflow-hidden">
                <p className="text-[11px] font-medium text-muted-foreground truncate">Interest Rate</p>
                <p className="text-xs sm:text-sm font-bold text-primary truncate">{feePct}%</p>
              </div>

              <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-2.5 space-y-1 min-w-0 overflow-hidden">
                <p className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400 truncate">Our Profit</p>
                <p className="text-xs sm:text-sm font-bold text-emerald-600 dark:text-emerald-400 truncate">
                  {formatUGX(profit)}
                </p>
              </div>

              <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1 min-w-0 overflow-hidden">
                <p className="text-[11px] font-medium text-muted-foreground truncate">Amount Paid</p>
                <p className="text-xs sm:text-sm font-bold text-emerald-600 truncate">{formatUGX(paid)}</p>
              </div>

              <div className="rounded-lg border bg-muted/30 p-2.5 space-y-1 min-w-0 overflow-hidden">
                <p className="text-[11px] font-medium text-muted-foreground truncate">Outstanding</p>
                <p className="text-xs sm:text-sm font-bold text-foreground truncate">{formatUGX(outstanding)}</p>
              </div>
            </div>
          </div>

          {/* SECTION 2: AUDIT & TIMELINE */}
          <div className="rounded-xl border bg-card p-3 sm:p-4 space-y-2.5 shadow-xs">
            <div className="flex items-center gap-2 pb-0.5 border-b border-border/40">
              <div className="h-6 w-6 rounded-md bg-muted text-muted-foreground flex items-center justify-center shrink-0">
                <Clock className="h-3.5 w-3.5" />
              </div>
              <h3 className="text-xs font-bold text-foreground truncate">
                Application History &amp; Milestones
              </h3>
            </div>

            <div className="divide-y divide-border/40 text-xs">
              <div className="flex flex-wrap justify-between gap-1.5 py-1.5">
                <span className="text-muted-foreground font-medium">Submitted</span>
                <span className="font-semibold text-foreground">{format(new Date(order.created_at), 'd MMM yyyy, HH:mm')}</span>
              </div>

              {order.coo_approved_at && (
                <div className="flex flex-wrap justify-between gap-1.5 py-1.5">
                  <span className="text-muted-foreground font-medium">COO Approved</span>
                  <span className="font-semibold text-sky-600">
                    {format(new Date(order.coo_approved_at), 'd MMM yyyy, HH:mm')}
                  </span>
                </div>
              )}

              {order.cfo_disbursed_at && (
                <div className="flex flex-wrap justify-between gap-1.5 py-1.5">
                  <span className="text-muted-foreground font-medium">CFO Disbursed</span>
                  <span className="font-semibold text-emerald-600">
                    {format(new Date(order.cfo_disbursed_at), 'd MMM yyyy, HH:mm')}
                  </span>
                </div>
              )}

              {order.lease_activated_at && (
                <div className="flex flex-wrap justify-between gap-1.5 py-1.5">
                  <span className="text-muted-foreground font-medium">Lease Activated</span>
                  <span className="font-semibold text-emerald-600">
                    {format(new Date(order.lease_activated_at), 'd MMM yyyy, HH:mm')}
                  </span>
                </div>
              )}

              {order.rejection_reason && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5 space-y-0.5 mt-1.5">
                  <p className="text-[11px] font-semibold text-destructive">Rejection Reason</p>
                  <p className="text-xs text-destructive">{order.rejection_reason}</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* DIALOG FOOTER WITH CENTERED DECISION ACTIONS ON MOBILE */}
        <DialogFooter className="p-3 sm:p-4 border-t bg-card/50 shrink-0 gap-2 flex flex-col-reverse sm:flex-row sm:justify-between items-stretch sm:items-center">
          <Button
            variant="outline"
            size="sm"
            className="h-9 text-xs w-full sm:w-auto justify-center"
            onClick={() => onOpenChange(false)}
          >
            Close
          </Button>

          <div className="flex flex-col sm:flex-row items-center justify-center sm:justify-end gap-2 w-full sm:w-auto">
            <div className="flex items-center justify-center gap-2 w-full sm:w-auto">
              {onEditPrice && canAct && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 text-xs gap-1.5 flex-1 sm:flex-initial justify-center"
                  onClick={() => {
                    onOpenChange(false);
                    onEditPrice(order);
                  }}
                >
                  <Edit3 className="h-3.5 w-3.5 text-primary" /> Edit Price
                </Button>
              )}
              {!canAct && (
                <span className="text-[11px] text-muted-foreground">
                  Read-only — already decided at this level
                </span>
              )}

              {canAct && onReject && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 text-xs text-destructive hover:bg-destructive/10 flex-1 sm:flex-initial justify-center"
                  onClick={() => {
                    onOpenChange(false);
                    onReject(order);
                  }}
                >
                  <X className="h-3.5 w-3.5 mr-1" /> Reject
                </Button>
              )}
            </div>

            {canAct && onApprove && (
              <Button
                size="sm"
                className="h-9 text-xs bg-primary text-primary-foreground hover:bg-primary/90 w-full sm:w-auto justify-center font-semibold"
                onClick={() => {
                  onOpenChange(false);
                  onApprove(order);
                }}
              >
                <Check className="h-3.5 w-3.5 mr-1" />
                {isAwaitingCfo
                  ? 'Disburse to agent wallet'
                  : isAwaitingCoo
                    ? 'Approve & send to CFO'
                    : 'Verify & send to COO'}
              </Button>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
