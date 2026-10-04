import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { fetchOpsWallet } from '@/hooks/ops/useOpsDataLayer';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { 
  Sheet, 
  SheetContent, 
  SheetHeader, 
  SheetTitle, 
  SheetTrigger 
} from '@/components/ui/sheet';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { formatUGX } from '@/lib/rentCalculations';
import { 
  History, 
  CheckCircle2, 
  AlertTriangle, 
  Calendar,
  TrendingUp,
  Clock,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Ban,
  Coins,
  Wallet,
  Loader2,
  CreditCard,
  Plus
} from 'lucide-react';
import { format, differenceInDays, addDays, isBefore, isToday, isSameDay } from 'date-fns';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useToast } from '@/hooks/use-toast';
import DepositFlow from '@/components/payments/DepositFlow';

interface RentRequest {
  id: string;
  rent_amount: number;
  duration_days: number;
  total_repayment: number;
  daily_repayment: number;
  status: string;
  created_at: string;
  disbursed_at: string | null;
}

interface Repayment {
  id: string;
  amount: number;
  payment_date: string;
  created_at: string;
  rent_request_id: string;
  payment_method?: string;
  collection_channel?: string | null;
}

interface LateFee {
  id: string;
  loan_id: string;
  borrower_id: string;
  fee_amount: number;
  days_overdue: number;
  applied_at: string;
  paid: boolean;
  paid_at: string | null;
}

interface RepaymentHistoryDrawerProps {
  userId: string;
}

export function RepaymentHistoryDrawer({ userId }: RepaymentHistoryDrawerProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rentRequests, setRentRequests] = useState<RentRequest[]>([]);
  const [repayments, setRepayments] = useState<Repayment[]>([]);
  const [lateFees, setLateFees] = useState<LateFee[]>([]);
  
  // Payment dialog state
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false);
  const [selectedRequest, setSelectedRequest] = useState<RentRequest | null>(null);
  const [paymentAmount, setPaymentAmount] = useState('');
  const [submittingPayment, setSubmittingPayment] = useState(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [loadingWallet, setLoadingWallet] = useState(false);
  const [depositFlowOpen, setDepositFlowOpen] = useState(false);
  
  const { toast } = useToast();

  // Late fee configuration (5% per missed day, can be fetched from DB if needed)
  const LATE_FEE_RATE = 0.05; // 5% per day
  const GRACE_PERIOD_DAYS = 0; // No grace period

  const fetchData = async () => {
    setLoading(true);
    
    const [requestsResult, collectionsResult] = await Promise.all([
      supabase
        .from('rent_requests')
        .select('*')
        .eq('tenant_id', userId)
        .in('status', ['disbursed', 'completed', 'funded', 'repaying'])
        .order('created_at', { ascending: false }),
      // Payments now come from agent_collections (single source of truth).
      supabase
        .from('agent_collections')
        .select('id, amount, created_at, rent_request_id, payment_method, collection_channel').is('reversed_at', null)
        .eq('tenant_id', userId)
        .order('created_at', { ascending: false }),
    ]);

    setRentRequests(requestsResult.data || []);
    const mapped: Repayment[] = (collectionsResult.data ?? []).map((r: any) => ({
      id: r.id,
      amount: Number(r.amount) || 0,
      payment_date: r.created_at,
      created_at: r.created_at,
      rent_request_id: r.rent_request_id ?? '',
      payment_method: r.payment_method ?? 'cash',
      collection_channel: r.collection_channel ?? null,
    } as Repayment));
    setRepayments(mapped);
    setLateFees([]);
    setLoading(false);
  };

  useEffect(() => {
    if (open) {
      fetchData();
    }
  }, [open, userId]);

  // Calculate missed payments for active (disbursed) requests
  const calculateMissedPayments = (request: RentRequest) => {
    if (request.status !== 'disbursed' || !request.disbursed_at) return null;

    const disbursedDate = new Date(request.disbursed_at);
    const today = new Date();
    const daysElapsed = differenceInDays(today, disbursedDate);
    
    const requestRepayments = repayments.filter(r => r.rent_request_id === request.id);
    const totalRepaid = requestRepayments.reduce((sum, r) => sum + Number(r.amount), 0);
    const expectedPayments = daysElapsed * Number(request.daily_repayment);
    
    const missedAmount = Math.max(0, expectedPayments - totalRepaid);
    const missedDays = Math.floor(missedAmount / Number(request.daily_repayment));
    
    return {
      missedDays,
      missedAmount,
      totalRepaid,
      remainingBalance: Number(request.total_repayment) - totalRepaid,
      progressPercent: (totalRepaid / Number(request.total_repayment)) * 100
    };
  };

  // Calculate late fees for a request based on missed days
  const calculateLateFees = (request: RentRequest) => {
    const stats = calculateMissedPayments(request);
    if (!stats || stats.missedDays <= GRACE_PERIOD_DAYS) return null;
    
    const effectiveMissedDays = stats.missedDays - GRACE_PERIOD_DAYS;
    const dailyFee = Number(request.daily_repayment) * LATE_FEE_RATE;
    
    // Calculate compounding late fees
    let accumulatedFees = 0;
    for (let i = 1; i <= effectiveMissedDays; i++) {
      accumulatedFees += dailyFee * i; // Increases each day
    }
    
    // Also check for recorded late fees in DB
    const dbLateFees = lateFees.filter(lf => !lf.paid);
    const unpaidDbFees = dbLateFees.reduce((sum, lf) => sum + Number(lf.fee_amount), 0);
    
    return {
      missedDays: effectiveMissedDays,
      dailyFeeRate: dailyFee,
      accumulatedFees: Math.max(accumulatedFees, unpaidDbFees),
      unpaidDbFees,
      hasRecordedFees: dbLateFees.length > 0
    };
  };

  // Get total unpaid late fees
  const getTotalUnpaidLateFees = () => {
    return activeRequests.reduce((total, request) => {
      const fees = calculateLateFees(request);
      return total + (fees?.accumulatedFees || 0);
    }, 0);
  };

  // Generate repayment schedule for a request
  const generateSchedule = (request: RentRequest) => {
    if (!request.disbursed_at) return [];
    
    const disbursedDate = new Date(request.disbursed_at);
    const schedule = [];
    const requestRepayments = repayments.filter(r => r.rent_request_id === request.id);
    
    for (let i = 1; i <= request.duration_days; i++) {
      const dueDate = addDays(disbursedDate, i);
      const dailyAmount = Number(request.daily_repayment);
      
      // Check if payment was made for this day
      const paymentForDay = requestRepayments.find(r => 
        isSameDay(new Date(r.payment_date), dueDate)
      );
      
      const isPast = isBefore(dueDate, new Date()) && !isToday(dueDate);
      const isCurrentDay = isToday(dueDate);
      
      schedule.push({
        day: i,
        dueDate,
        amount: dailyAmount,
        status: paymentForDay ? 'paid' : (isPast ? 'missed' : (isCurrentDay ? 'due_today' : 'upcoming')),
        paidAmount: paymentForDay ? Number(paymentForDay.amount) : 0
      });
    }
    
    return schedule;
  };

  // Calculate remaining balance for a request
  const getRemainingBalance = (request: RentRequest) => {
    const requestRepayments = repayments.filter(r => r.rent_request_id === request.id);
    const totalRepaid = requestRepayments.reduce((sum, r) => sum + Number(r.amount), 0);
    return Number(request.total_repayment) - totalRepaid;
  };

  // Fetch wallet balance
  const fetchWalletBalance = async () => {
    setLoadingWallet(true);
    // Authoritative wallet RPC — avoids the heavy `wallets` view.
    try {
      const w = await fetchOpsWallet(userId);
      setWalletBalance(w ? w.withdrawable + w.float + w.advance : 0);
    } catch {
      setWalletBalance(0);
    }
    setLoadingWallet(false);
  };

  // Open payment dialog
  const openPaymentDialog = (request: RentRequest) => {
    setSelectedRequest(request);
    setPaymentAmount(String(request.daily_repayment));
    setPaymentDialogOpen(true);
    fetchWalletBalance();
  };

  // Handle payment submission
  const handleSubmitPayment = async () => {
    if (!selectedRequest) return;
    
    const amount = parseFloat(paymentAmount);
    const remainingBalance = getRemainingBalance(selectedRequest);
    
    if (isNaN(amount) || amount <= 0) {
      toast({
        title: 'Invalid Amount',
        description: 'Please enter a valid payment amount',
        variant: 'destructive'
      });
      return;
    }

    if (amount > remainingBalance) {
      toast({
        title: 'Amount Exceeds Balance',
        description: `Maximum payment is ${formatUGX(remainingBalance)}`,
        variant: 'destructive'
      });
      return;
    }

    setSubmittingPayment(true);

    try {
      // repayments and platform_transactions tables removed
      toast({ title: 'Not Available', description: 'Repayment submission is currently disabled.', variant: 'destructive' });
      setSubmittingPayment(false);
      return;

      // Check if fully repaid
      if (amount >= remainingBalance) {
        await supabase
          .from('rent_requests')
          .update({ status: 'completed' })
          .eq('id', selectedRequest.id);
      }

      toast({
        title: 'Payment Recorded',
        description: `Successfully recorded payment of ${formatUGX(amount)}`
      });

      setPaymentDialogOpen(false);
      setPaymentAmount('');
      setSelectedRequest(null);
      fetchData(); // Refresh data
    } catch (error: any) {
      toast({
        title: 'Error',
        description: error.message || 'Failed to record payment',
        variant: 'destructive'
      });
    } finally {
      setSubmittingPayment(false);
    }
  };

  const activeRequests = rentRequests.filter(r => r.status === 'disbursed');
  const completedRequests = rentRequests.filter(r => r.status === 'completed');
  const totalMissedPayments = activeRequests.reduce((total, request) => {
    const stats = calculateMissedPayments(request);
    return total + (stats?.missedDays || 0);
  }, 0);
  const totalLateFees = activeRequests.reduce((total, request) => {
    const fees = calculateLateFees(request);
    return total + (fees?.accumulatedFees || 0);
  }, 0);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button 
          variant="outline" 
          size="sm" 
          className="gap-1.5 text-xs h-8 px-2.5 border-primary/20 hover:border-primary/40 hover:bg-primary/5"
        >
          <History className="h-3.5 w-3.5" />
          <span className="hidden sm:inline">Payments</span>
          {totalMissedPayments > 0 && (
            <Badge variant="destructive" className="h-4 px-1 text-[10px] ml-0.5">
              {totalMissedPayments}
            </Badge>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent side="bottom" className="h-[85vh] rounded-t-2xl">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2">
            <History className="h-5 w-5 text-primary" />
            Repayment History
          </SheetTitle>
        </SheetHeader>
        
        <Tabs defaultValue="history" className="h-[calc(85vh-80px)]">
          <TabsList className="grid w-full grid-cols-2 mb-4">
            <TabsTrigger value="history" className="gap-1.5">
              <History className="h-4 w-4" />
              History
            </TabsTrigger>
            <TabsTrigger value="schedule" className="gap-1.5">
              <CalendarDays className="h-4 w-4" />
              Schedule
            </TabsTrigger>
          </TabsList>
          
          <TabsContent value="history" className="mt-0 h-[calc(100%-48px)]">
            <ScrollArea className="h-full pr-4">
              {loading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="p-4 rounded-lg border border-border">
                      <Skeleton className="h-4 w-32 mb-2" />
                      <Skeleton className="h-6 w-24 mb-3" />
                      <Skeleton className="h-2 w-full" />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-6">
                  {/* Missed Payments Summary */}
                  {totalMissedPayments > 0 && (
                    <div className="p-4 rounded-xl bg-destructive/10 border border-destructive/30">
                      <div className="flex items-center gap-2 mb-2">
                        <AlertTriangle className="h-5 w-5 text-destructive" />
                        <h3 className="font-semibold text-destructive">Missed Payments</h3>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        You have missed approximately {totalMissedPayments} day(s) of payments. 
                        Please catch up to stay on track.
                      </p>
                    </div>
                  )}

                  {/* Active Requests */}
                  {activeRequests.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                        <Clock className="h-4 w-4" />
                        Active Repayments
                      </h3>
                      {activeRequests.map((request) => {
                        const stats = calculateMissedPayments(request);
                        const requestRepayments = repayments.filter(r => r.rent_request_id === request.id);
                        
                        return (
                          <div 
                            key={request.id} 
                            className="p-4 rounded-xl border border-border bg-card"
                          >
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm text-muted-foreground">
                                {format(new Date(request.created_at), 'MMM d, yyyy')}
                              </span>
                              {stats && stats.missedDays > 0 ? (
                                <Badge variant="destructive" className="gap-1">
                                  <AlertTriangle className="h-3 w-3" />
                                  {stats.missedDays} days behind
                                </Badge>
                              ) : (
                                <Badge variant="success" className="gap-1">
                                  <CheckCircle2 className="h-3 w-3" />
                                  On track
                                </Badge>
                              )}
                            </div>
                            
                            <div className="space-y-2">
                              <div className="flex justify-between">
                                <span className="text-sm">Total to repay</span>
                                <span className="font-mono font-medium">
                                  {formatUGX(Number(request.total_repayment))}
                                </span>
                              </div>
                              {stats && (
                                <>
                                  <div className="h-2 rounded-full bg-secondary overflow-hidden">
                                    <div 
                                      className="h-full bg-primary rounded-full transition-all"
                                      style={{ width: `${stats.progressPercent}%` }}
                                    />
                                  </div>
                                  <div className="flex justify-between text-xs text-muted-foreground">
                                    <span>Paid: {formatUGX(stats.totalRepaid)}</span>
                                    <span>Remaining: {formatUGX(stats.remainingBalance)}</span>
                                  </div>
                                </>
                              )}
                            </div>

                            {/* Recent payments for this request */}
                            {requestRepayments.length > 0 && (
                              <div className="mt-3 pt-3 border-t border-border">
                                <p className="text-xs text-muted-foreground mb-2">Recent payments:</p>
                                <div className="space-y-1.5">
                                  {requestRepayments.slice(0, 3).map((payment) => (
                                    <div 
                                      key={payment.id}
                                      className="flex items-center justify-between text-sm py-1 px-2 rounded bg-secondary/50"
                                    >
                                      <div className="flex items-center gap-2">
                                        <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                                        <span className="font-mono">{formatUGX(Number(payment.amount))}</span>
                                      </div>
                                      <span className="text-xs text-muted-foreground">
                                        {format(new Date(payment.payment_date), 'MMM d')}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Completed Requests */}
                  {completedRequests.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                        <CheckCircle2 className="h-4 w-4" />
                        Completed
                      </h3>
                      {completedRequests.map((request) => {
                        const requestRepayments = repayments.filter(r => r.rent_request_id === request.id);
                        const totalRepaid = requestRepayments.reduce((sum, r) => sum + Number(r.amount), 0);
                        
                        return (
                          <div 
                            key={request.id} 
                            className="p-4 rounded-xl border border-border bg-card/50"
                          >
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-sm text-muted-foreground">
                                {format(new Date(request.created_at), 'MMM d, yyyy')}
                              </span>
                              <Badge variant="outline" className="text-success border-success/30">
                                Completed
                              </Badge>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-sm">Amount repaid</span>
                              <span className="font-mono font-medium text-success">
                                {formatUGX(totalRepaid)}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* All Payments History */}
                  {repayments.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                        <Calendar className="h-4 w-4" />
                        All Payments
                      </h3>
                      <div className="space-y-2">
                        {repayments.slice(0, 20).map((payment) => (
                          <div 
                            key={payment.id}
                            className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border border-border/50"
                          >
                            <div className="flex items-center gap-3">
                              <div className="h-8 w-8 rounded-full bg-success/10 flex items-center justify-center">
                                <CheckCircle2 className="h-4 w-4 text-success" />
                              </div>
                              <div>
                                <p className="font-mono font-medium">{formatUGX(Number(payment.amount))}</p>
                                <p className="text-xs text-muted-foreground">
                                  {format(new Date(payment.payment_date), 'MMMM d, yyyy')}
                                </p>
                                <Badge
                                  variant="outline"
                                  className="mt-1 text-[10px]"
                                >
                                  {payment.collection_channel === 'tenant_paid'
                                    ? 'Paid by you'
                                    : 'Collected by agent'}
                                </Badge>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Empty State */}
                  {rentRequests.length === 0 && repayments.length === 0 && (
                    <div className="text-center py-12">
                      <TrendingUp className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
                      <h3 className="font-medium text-muted-foreground mb-1">No repayment history</h3>
                      <p className="text-sm text-muted-foreground/70">
                        Your payment history will appear here once you start making repayments.
                      </p>
                    </div>
                  )}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
          
          <TabsContent value="schedule" className="mt-0 h-[calc(100%-48px)]">
            <ScrollArea className="h-full pr-4">
              {loading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map((i) => (
                    <div key={i} className="p-4 rounded-lg border border-border">
                      <Skeleton className="h-4 w-32 mb-2" />
                      <Skeleton className="h-20 w-full" />
                    </div>
                  ))}
                </div>
              ) : activeRequests.length === 0 ? (
                <div className="text-center py-12">
                  <CalendarDays className="h-12 w-12 text-muted-foreground/30 mx-auto mb-4" />
                  <h3 className="font-medium text-muted-foreground mb-1">No active schedule</h3>
                  <p className="text-sm text-muted-foreground/70">
                    Your repayment schedule will appear here once you have an active rent request.
                  </p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Late Fee Warning Banner */}
                  {totalLateFees > 0 && (
                    <Alert variant="destructive" className="border-destructive/50 bg-destructive/10">
                      <Ban className="h-4 w-4" />
                      <AlertTitle className="flex items-center gap-2">
                        Late Fee Penalty
                        <Badge variant="destructive" className="font-mono">
                          {formatUGX(totalLateFees)}
                        </Badge>
                      </AlertTitle>
                      <AlertDescription className="text-xs mt-1">
                        You have accumulated late fees due to missed payments. Pay your overdue balance to stop further penalties.
                        <span className="block mt-1 text-destructive/80">
                          Rate: 5% of daily repayment per missed day (compounding)
                        </span>
                      </AlertDescription>
                    </Alert>
                  )}
                  
                  {activeRequests.map((request) => {
                    const schedule = generateSchedule(request);
                    const stats = calculateMissedPayments(request);
                    const lateFeeStats = calculateLateFees(request);
                    
                    return (
                      <Collapsible key={request.id} defaultOpen>
                        <div className="p-4 rounded-xl border border-border bg-card">
                          <CollapsibleTrigger className="w-full">
                            <div className="flex items-center justify-between">
                              <div className="text-left">
                                <p className="font-medium">
                                  {formatUGX(Number(request.rent_amount))} Rent
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {request.duration_days} days • {formatUGX(Number(request.daily_repayment))}/day
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                {stats && (
                                  <span className="text-xs text-muted-foreground">
                                    {Math.round(stats.progressPercent)}% done
                                  </span>
                                )}
                                <ChevronDown className="h-4 w-4 text-muted-foreground" />
                              </div>
                            </div>
                          </CollapsibleTrigger>
                          
                          <CollapsibleContent>
                            <div className="mt-4 pt-4 border-t border-border space-y-3">
                              {/* Late Fee Warning for this request */}
                              {lateFeeStats && lateFeeStats.accumulatedFees > 0 && (
                                <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/30">
                                  <div className="flex items-start gap-2">
                                    <Coins className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center justify-between gap-2">
                                        <span className="text-sm font-medium text-destructive">Late Fees</span>
                                        <span className="font-mono text-sm font-bold text-destructive">
                                          {formatUGX(lateFeeStats.accumulatedFees)}
                                        </span>
                                      </div>
                                      <p className="text-xs text-muted-foreground mt-1">
                                        {lateFeeStats.missedDays} day(s) overdue × {formatUGX(lateFeeStats.dailyFeeRate)}/day (compounding)
                                      </p>
                                    </div>
                                  </div>
                                </div>
                              )}
                              
                              {/* Schedule Legend */}
                              {/* Schedule Legend */}
                              <div className="flex flex-wrap gap-3 text-xs mb-3">
                                <div className="flex items-center gap-1">
                                  <div className="h-2.5 w-2.5 rounded-full bg-success" />
                                  <span className="text-muted-foreground">Paid</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  <div className="h-2.5 w-2.5 rounded-full bg-destructive" />
                                  <span className="text-muted-foreground">Missed</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  <div className="h-2.5 w-2.5 rounded-full bg-warning" />
                                  <span className="text-muted-foreground">Today</span>
                                </div>
                                <div className="flex items-center gap-1">
                                  <div className="h-2.5 w-2.5 rounded-full bg-muted" />
                                  <span className="text-muted-foreground">Upcoming</span>
                                </div>
                              </div>
                              
                              {/* Schedule Grid */}
                              <div className="grid grid-cols-7 gap-1.5">
                                {schedule.map((item) => (
                                  <div
                                    key={item.day}
                                    className={`
                                      relative p-1.5 rounded text-center text-xs
                                      ${item.status === 'paid' ? 'bg-success/20 text-success border border-success/30' : ''}
                                      ${item.status === 'missed' ? 'bg-destructive/20 text-destructive border border-destructive/30' : ''}
                                      ${item.status === 'due_today' ? 'bg-warning/20 text-warning-foreground border-2 border-warning' : ''}
                                      ${item.status === 'upcoming' ? 'bg-muted/50 text-muted-foreground border border-border' : ''}
                                    `}
                                    title={`Day ${item.day}: ${format(item.dueDate, 'MMM d')} - ${formatUGX(item.amount)}`}
                                  >
                                    <span className="font-medium">{item.day}</span>
                                  </div>
                                ))}
                              </div>
                              
                              {/* Detailed Schedule List */}
                              <div className="mt-4 space-y-1.5 max-h-48 overflow-y-auto">
                                {schedule.map((item) => (
                                  <div
                                    key={item.day}
                                    className={`
                                      flex items-center justify-between p-2 rounded-lg text-sm
                                      ${item.status === 'paid' ? 'bg-success/10' : ''}
                                      ${item.status === 'missed' ? 'bg-destructive/10' : ''}
                                      ${item.status === 'due_today' ? 'bg-warning/10 ring-1 ring-warning' : ''}
                                      ${item.status === 'upcoming' ? 'bg-muted/30' : ''}
                                    `}
                                  >
                                    <div className="flex items-center gap-2">
                                      <span className="font-medium w-8">D{item.day}</span>
                                      <span className="text-muted-foreground">
                                        {format(item.dueDate, 'EEE, MMM d')}
                                      </span>
                                    </div>
                                    <div className="flex items-center gap-2">
                                      <span className="font-mono text-xs">
                                        {formatUGX(item.amount)}
                                      </span>
                                      {item.status === 'paid' && (
                                        <CheckCircle2 className="h-4 w-4 text-success" />
                                      )}
                                      {item.status === 'missed' && (
                                        <AlertTriangle className="h-4 w-4 text-destructive" />
                                      )}
                                      {item.status === 'due_today' && (
                                        <Clock className="h-4 w-4 text-warning" />
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                              
                              {/* Make Payment Button */}
                              <div className="mt-4 pt-3 border-t border-border">
                                <Button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openPaymentDialog(request);
                                  }}
                                  className="w-full gap-2"
                                  size="default"
                                >
                                  <CreditCard className="h-4 w-4" />
                                  Make Payment
                                </Button>
                                <p className="text-xs text-center text-muted-foreground mt-2">
                                  Remaining: {formatUGX(getRemainingBalance(request))}
                                </p>
                              </div>
                            </div>
                          </CollapsibleContent>
                        </div>
                      </Collapsible>
                    );
                  })}
                </div>
              )}
            </ScrollArea>
          </TabsContent>
        </Tabs>
        
        {/* Payment Dialog */}
        <Dialog open={paymentDialogOpen} onOpenChange={setPaymentDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Wallet className="h-5 w-5 text-primary" />
                Make a Payment
              </DialogTitle>
              <DialogDescription>
                Enter the amount you want to pay towards your rent repayment.
              </DialogDescription>
            </DialogHeader>
            
            {selectedRequest && (
              <div className="space-y-4 py-2">
                {/* Wallet Balance */}
                <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Wallet className="h-4 w-4 text-primary" />
                      <span className="text-sm font-medium">Wallet Balance</span>
                    </div>
                    {loadingWallet ? (
                      <Skeleton className="h-5 w-24" />
                    ) : (
                      <span className="font-mono font-bold text-primary">
                        {formatUGX(walletBalance ?? 0)}
                      </span>
                    )}
                  </div>
                </div>

                {/* Insufficient Balance Warning with Deposit Link */}
                {!loadingWallet && walletBalance !== null && parseFloat(paymentAmount || '0') > walletBalance && (
                  <Alert variant="destructive" className="py-2">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-xs flex items-center justify-between gap-2">
                      <span>
                        Insufficient balance. Need {formatUGX(parseFloat(paymentAmount || '0') - walletBalance)} more.
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 text-xs border-destructive/50 hover:bg-destructive/10"
                        onClick={() => setDepositFlowOpen(true)}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Deposit
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
                
                {/* Payment Summary */}
                <div className="p-3 rounded-lg bg-secondary/50 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Daily Target</span>
                    <span className="font-mono font-medium">
                      {formatUGX(Number(selectedRequest.daily_repayment))}
                    </span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Remaining Balance</span>
                    <span className="font-mono font-medium">
                      {formatUGX(getRemainingBalance(selectedRequest))}
                    </span>
                  </div>
                </div>
                
                {/* Amount Input */}
                <div className="space-y-2">
                  <Label htmlFor="payment-amount">Payment Amount (UGX)</Label>
                  <Input
                    id="payment-amount"
                    type="number"
                    placeholder="Enter amount"
                    value={paymentAmount}
                    onChange={(e) => setPaymentAmount(e.target.value)}
                    min="1"
                    max={getRemainingBalance(selectedRequest)}
                    className="font-mono"
                  />
                </div>
                
                {/* Quick Amount Buttons */}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPaymentAmount(String(selectedRequest.daily_repayment))}
                    className="text-xs"
                  >
                    Daily ({formatUGX(Number(selectedRequest.daily_repayment))})
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPaymentAmount(String(Number(selectedRequest.daily_repayment) * 7))}
                    className="text-xs"
                  >
                    Weekly
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPaymentAmount(String(Math.min(getRemainingBalance(selectedRequest), walletBalance ?? 0)))}
                    className="text-xs"
                    disabled={!walletBalance}
                  >
                    Max Affordable
                  </Button>
                </div>
              </div>
            )}
            
            <DialogFooter className="gap-2 sm:gap-0">
              <Button
                variant="outline"
                onClick={() => setPaymentDialogOpen(false)}
                disabled={submittingPayment}
              >
                Cancel
              </Button>
              <Button
                onClick={handleSubmitPayment}
                disabled={
                  submittingPayment || 
                  !paymentAmount || 
                  loadingWallet ||
                  (walletBalance !== null && parseFloat(paymentAmount || '0') > walletBalance)
                }
                className="gap-2"
              >
                {submittingPayment ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Processing...
                  </>
                ) : (
                  <>
                    <CheckCircle2 className="h-4 w-4" />
                    Confirm Payment
                  </>
                )}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Deposit Flow */}
        <DepositFlow 
          open={depositFlowOpen} 
          onOpenChange={(open) => {
            setDepositFlowOpen(open);
            if (!open) {
              // Refresh wallet balance after deposit flow closes
              fetchWalletBalance();
            }
          }} 
          walletBalance={walletBalance ?? 0}
        />
      </SheetContent>
    </Sheet>
  );
}
