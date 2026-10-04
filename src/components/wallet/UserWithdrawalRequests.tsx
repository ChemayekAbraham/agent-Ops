import { useState, useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ArrowDownToLine,
  ArrowUpRight,
  CheckCircle,
  RefreshCw,
  Loader2,
  Smartphone,
  ChevronDown,
  ChevronUp,
  AlertTriangle,
} from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { format, formatDistanceToNow, parseISO, isToday, isYesterday } from 'date-fns';
import { cn } from '@/lib/utils';
import { ReportPayoutNotReceivedDialog } from '@/components/payouts/ReportPayoutNotReceivedDialog';
import { useWithdrawalRequestsList } from '@/hooks/wallet/useWalletRequests';

interface WithdrawalRequest {
  id: string;
  amount: number;
  status: string;
  mobile_money_number: string | null;
  mobile_money_provider: string | null;
  transaction_id: string | null;
  created_at: string;
  rejection_reason: string | null;
  processed_at: string | null;
  manager_approved_at: string | null;
  cfo_approved_at: string | null;
  coo_approved_at: string | null;
  payout_code: string | null;
  payout_method: string | null;
}

function dayLabel(iso: string): string {
  const d = parseISO(iso);
  if (isToday(d)) return 'TODAY';
  if (isYesterday(d)) return 'YESTERDAY';
  return format(d, 'EEE, d MMM yyyy').toUpperCase();
}

export function UserWithdrawalRequests() {
  const { user } = useAuth();
  const { requests: rawRequests, isLoading, refetch } = useWithdrawalRequestsList(user?.id);
  const requests = rawRequests as unknown as WithdrawalRequest[];
  const [expanded, setExpanded] = useState(false);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  // Withdrawal ids the user already reported as "not received" -> status.
  const [disputes, setDisputes] = useState<Record<string, string>>({});
  const [reportTarget, setReportTarget] = useState<WithdrawalRequest | null>(null);
  const loading = isLoading;

  const formatCurrency = (value: number) =>
    new Intl.NumberFormat('en-UG', {
      style: 'currency',
      currency: 'UGX',
      minimumFractionDigits: 0,
    }).format(value);

  // Disputes are keyed off this component's own withdrawal ids, so this
  // stays a dependent fetch off the shared, cached base rows above rather
  // than something the shared hook itself needs to know about.
  useEffect(() => {
    let cancelled = false;
    const ids = requests.map((r) => r.id);
    if (ids.length === 0) {
      setDisputes({});
      return;
    }
    (async () => {
      const { data: dRows } = await (supabase as any)
        .from('payout_delivery_disputes')
        .select('withdrawal_id, status')
        .in('withdrawal_id', ids);
      if (cancelled) return;
      const map: Record<string, string> = {};
      for (const row of (dRows as any[]) || []) map[row.withdrawal_id] = row.status;
      setDisputes(map);
    })();
    return () => { cancelled = true; };
  }, [requests]);

  const visualFor = (status: string) => {
    switch (status) {
      case 'approved':
      case 'completed':
        return {
          accent: 'border-l-success',
          iconWrap: 'bg-success/10 text-success',
          pill: 'bg-success/10 text-success',
          label: status === 'approved' ? 'Approved' : 'Completed',
          pulse: false,
        };
      case 'pending':
        return {
          accent: 'border-l-warning',
          iconWrap: 'bg-warning/15 text-warning',
          pill: 'bg-warning/15 text-warning',
          label: 'Pending',
          pulse: true,
        };
      case 'rejected':
      case 'failed':
        return {
          accent: 'border-l-destructive',
          iconWrap: 'bg-destructive/10 text-destructive',
          pill: 'bg-destructive/10 text-destructive',
          label: status === 'failed' ? 'Failed' : 'Rejected',
          pulse: false,
        };
      case 'cancelled':
      case 'expired':
        return {
          accent: 'border-l-transparent',
          iconWrap: 'bg-muted text-muted-foreground',
          pill: 'bg-muted text-muted-foreground',
          label: status === 'expired' ? 'Expired' : 'Cancelled',
          pulse: false,
        };
      default:
        return {
          accent: 'border-l-transparent',
          iconWrap: 'bg-muted text-muted-foreground',
          pill: 'bg-muted text-muted-foreground',
          label: status.charAt(0).toUpperCase() + status.slice(1).replace(/_/g, ' '),
          pulse: false,
        };
    }
  };

  const pendingCount = requests.filter((r) => r.status === 'pending').length;
  const displayedRequests = expanded ? requests : requests.slice(0, 3);

  const dayGroups = useMemo(() => {
    const groups: { key: string; label: string; rows: WithdrawalRequest[] }[] = [];
    for (const r of displayedRequests) {
      const key = format(parseISO(r.created_at), 'yyyy-MM-dd');
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.rows.push(r);
      else groups.push({ key, label: dayLabel(r.created_at), rows: [r] });
    }
    return groups;
  }, [displayedRequests]);

  if (loading) {
    return (
      <Card className="mt-4 rounded-2xl">
        <CardContent className="p-6 text-center">
          <Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  if (requests.length === 0) return null;

  return (
    <Card className="mt-4 border-border/50 rounded-2xl">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-bold text-muted-foreground uppercase tracking-widest flex items-center gap-2">
            <ArrowDownToLine className="h-4 w-4 text-primary" />
            My Withdrawals
            {pendingCount > 0 && (
              <Badge variant="secondary" className="text-xs animate-pulse normal-case tracking-normal">
                {pendingCount} in progress
              </Badge>
            )}
          </CardTitle>
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => void refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        <AnimatePresence mode="popLayout">
          {dayGroups.map((group) => (
            <section key={group.key} aria-labelledby={`wd-${group.key}`}>
              <h4
                id={`wd-${group.key}`}
                className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground"
              >
                {group.label}
              </h4>
              <ul className="space-y-2.5 list-none p-0 m-0">
                {group.rows.map((request, index) => {
                  const v = visualFor(request.status);
                  const isCardExpanded = expandedCardId === request.id;
                  const showTracker = request.status === 'pending' || request.status === 'approved';
                  const isSettled = request.status === 'approved' || request.status === 'completed';

                  return (
                    <motion.li
                      key={request.id}
                      layout
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ delay: index * 0.03 }}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          showTracker && setExpandedCardId(isCardExpanded ? null : request.id)
                        }
                        className={cn(
                          'flex w-full items-center gap-3 rounded-2xl border border-border/60 border-l-4 bg-card p-3.5 text-left shadow-sm transition-transform hover:shadow-md active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60',
                          v.accent,
                        )}
                      >
                        <div
                          className={cn(
                            'h-11 w-11 shrink-0 rounded-full flex items-center justify-center',
                            v.iconWrap,
                          )}
                          aria-hidden="true"
                        >
                          <ArrowUpRight className="h-5 w-5" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-bold text-foreground">
                            {formatCurrency(request.amount)}
                          </p>
                          {request.mobile_money_number && (
                            <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground min-w-0">
                              <Smartphone className="h-3 w-3 shrink-0" />
                              <span
                                className={cn(
                                  'uppercase font-semibold shrink-0',
                                  request.mobile_money_provider === 'mtn'
                                    ? 'text-yellow-600'
                                    : 'text-red-500',
                                )}
                              >
                                {request.mobile_money_provider || 'MoMo'}
                              </span>
                              <span className="shrink-0">•</span>
                              <span className="truncate">{request.mobile_money_number}</span>
                            </div>
                          )}
                          <p className="mt-0.5 text-[11px] text-muted-foreground/80">
                            {formatDistanceToNow(new Date(request.created_at), { addSuffix: true })}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <span
                            className={cn(
                              'inline-block rounded px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide',
                              v.pill,
                              v.pulse && 'animate-pulse',
                            )}
                          >
                            {v.label}
                          </span>
                          {showTracker && (
                            <ChevronDown
                              className={cn(
                                'mt-1 ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform',
                                isCardExpanded && 'rotate-180',
                              )}
                            />
                          )}
                        </div>
                      </button>

                      {request.status === 'rejected' && request.rejection_reason && (
                        <div className="mt-2 mx-1 p-2 bg-destructive/10 rounded-lg">
                          <p className="text-xs text-destructive">
                            <strong>Reason:</strong> {request.rejection_reason}
                          </p>
                        </div>
                      )}

                      {isSettled && request.processed_at && !isCardExpanded && (
                        <div className="mt-2 mx-1 p-2 bg-success/10 rounded-lg space-y-1">
                          <div className="flex items-center gap-1.5 text-xs text-success">
                            <CheckCircle className="h-3 w-3" />
                            <span>Sent {format(new Date(request.processed_at), 'MMM d • h:mm a')}</span>
                          </div>
                          {request.transaction_id && (
                            <p className="text-xs text-muted-foreground font-mono break-all">
                              Txn ID: {request.transaction_id}
                            </p>
                          )}
                        </div>
                      )}

                      {/* "I did not receive this money" — alerts the merchant
                          agent who settled this payout. */}
                      {isSettled && (
                        <div className="mt-1.5 mx-1">
                          {disputes[request.id] ? (
                            <div className="flex items-center gap-1.5 rounded-lg bg-destructive/10 p-2 text-[11px] font-semibold text-destructive">
                              <AlertTriangle className="h-3.5 w-3.5" />
                              {disputes[request.id] === 'resolved'
                                ? 'Non-delivery report closed by the merchant agent'
                                : disputes[request.id] === 'acknowledged'
                                  ? 'Merchant agent has seen your report — settlement pending'
                                  : 'Reported as not received — merchant agent alerted'}
                            </div>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-full justify-start gap-1.5 text-[11px] font-semibold text-destructive hover:bg-destructive/10"
                              onClick={() => setReportTarget(request)}
                            >
                              <AlertTriangle className="h-3.5 w-3.5" />
                              I did not receive this money
                            </Button>
                          )}
                        </div>
                      )}

                      <AnimatePresence>
                        {isCardExpanded && showTracker && (
                          <motion.div
                            initial={{ height: 0, opacity: 0 }}
                            animate={{ height: 'auto', opacity: 1 }}
                            exit={{ height: 0, opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="overflow-hidden"
                          >
                            <div className="mt-2 mx-1 px-3 pb-3 pt-2 rounded-xl border border-border/50 bg-muted/20">
                              <p className="text-sm text-muted-foreground text-center py-2">
                                Awaiting approval — you'll be notified once it's processed.
                              </p>
                              {request.payout_code && (
                                <div className="mt-3 p-3 rounded-lg bg-primary/5 border-2 border-primary/20 text-center space-y-2">
                                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">
                                    Your Withdrawal Code
                                  </p>
                                  <p className="text-2xl font-mono font-bold text-primary tracking-widest">
                                    {request.payout_code}
                                  </p>
                                  <p className="text-[10px] text-muted-foreground">
                                    Show this code to any Welile agent to receive your cash. Expires
                                    in 72 hours.
                                  </p>
                                </div>
                              )}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </motion.li>
                  );
                })}
              </ul>
            </section>
          ))}
        </AnimatePresence>

        {requests.length > 3 && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full h-10 text-muted-foreground touch-manipulation"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <>
                <ChevronUp className="h-4 w-4 mr-2" />
                Show less
              </>
            ) : (
              <>
                <ChevronDown className="h-4 w-4 mr-2" />
                Show {requests.length - 3} more
              </>
            )}
          </Button>
        )}
      </CardContent>
      {reportTarget && (
        <ReportPayoutNotReceivedDialog
          open={!!reportTarget}
          onOpenChange={(v) => !v && setReportTarget(null)}
          withdrawalId={reportTarget.id}
          amount={reportTarget.amount}
          onReported={() => void refetch()}
        />
      )}
    </Card>
  );
}