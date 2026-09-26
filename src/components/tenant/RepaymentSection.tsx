import { useState, useEffect, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';
import { TrendingUp, Calendar, CheckCircle2, Clock, AlertTriangle, XCircle, CalendarDays, CreditCard, Smartphone, Zap, FileDown, Loader2 } from 'lucide-react';
import { RepaymentHistoryDrawer } from './RepaymentHistoryDrawer';
import { RentAccessGrowthInline } from './RentAccessGrowthInline';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { differenceInDays, format, eachDayOfInterval, isSameDay, startOfDay } from 'date-fns';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import PaymentPartnersCard from '@/components/payments/PaymentPartnersCard';
import { downloadRepaymentPdf, shareRepaymentPdfWhatsApp } from '@/lib/repaymentSchedulePdf';
import { useToast } from '@/hooks/use-toast';



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
}

interface RepaymentSectionProps {
  userId: string;
  activeRequest?: RentRequest;
  repayments?: Repayment[];
  onRepaymentSuccess?: () => void;
}

interface DayStatus {
  date: Date;
  status: 'paid' | 'missed' | 'upcoming' | 'today';
  amount?: number;
}

export default function RepaymentSection({ 
  userId, 
  activeRequest: propActiveRequest, 
  repayments: propRepayments,
  onRepaymentSuccess 
}: RepaymentSectionProps) {
  const [loading, setLoading] = useState(true);
  const [rentRequests, setRentRequests] = useState<RentRequest[]>([]);
  const [repayments, setRepayments] = useState<Repayment[]>([]);
  const [showPaymentDialog, setShowPaymentDialog] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const { toast } = useToast();


  // Fetch all rent requests and repayments for this tenant
  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      
      const [requestsRes, collectionsRes] = await Promise.all([
        supabase
          .from('rent_requests')
          .select('id, rent_amount, duration_days, total_repayment, daily_repayment, status, created_at, disbursed_at')
          .eq('tenant_id', userId)
          .in('status', ['disbursed', 'completed', 'approved', 'funded', 'repaying'])
          .order('created_at', { ascending: false }),
        // Payments come from agent_collections (single source of truth).
        supabase
          .from('agent_collections')
          .select('id, amount, created_at, rent_request_id').is('reversed_at', null)
          .eq('tenant_id', userId)
          .order('created_at', { ascending: false }),
      ]);

      if (requestsRes.data) setRentRequests(requestsRes.data);
      const mapped: Repayment[] = (collectionsRes.data ?? []).map((r: any) => ({
        id: r.id,
        amount: Number(r.amount) || 0,
        payment_date: r.created_at,
        created_at: r.created_at,
        rent_request_id: r.rent_request_id ?? '',
      }));
      setRepayments(mapped);
      
      setLoading(false);
    };

    fetchData();
  }, [userId]);

  // Use props if provided, otherwise use fetched data
  const allRepayments = propRepayments || repayments;
  const activeRequest = propActiveRequest || rentRequests.find(r => r.status === 'disbursed');
  const completedRequests = rentRequests.filter(r => r.status === 'completed');

  // Calculate totals across all requests
  const totalPaid = allRepayments.reduce((sum, r) => sum + Number(r.amount), 0);
  const activeRequestRepayments = activeRequest 
    ? allRepayments.filter(r => r.rent_request_id === activeRequest.id)
    : [];
  const activeRepaid = activeRequestRepayments.reduce((sum, r) => sum + Number(r.amount), 0);
  const activeRemaining = activeRequest ? Number(activeRequest.total_repayment) - activeRepaid : 0;
  const activeProgress = activeRequest ? (activeRepaid / Number(activeRequest.total_repayment)) * 100 : 0;

  // Use disbursed_at if available, otherwise fall back to created_at for older records
  const getStartDate = (request: RentRequest) => {
    return request.disbursed_at || request.created_at;
  };

  // Calculate days and status for active request
  const daysElapsed = activeRequest
    ? differenceInDays(new Date(), new Date(getStartDate(activeRequest)))
    : 0;
  const expectedPayments = activeRequest ? Math.max(0, daysElapsed) * Number(activeRequest.daily_repayment) : 0;
  const paymentStatus = activeRepaid >= expectedPayments ? 'on-track' : 'behind';

  // Generate schedule with paid/missed/upcoming days
  const scheduleData = useMemo(() => {
    if (!activeRequest) return { days: [], paidDays: 0, missedDays: 0, upcomingDays: 0 };

    // Fall back to created_at if disbursed_at is not available (for older records)
    const requestStartDate = getStartDate(activeRequest);
    const startDate = startOfDay(new Date(requestStartDate));
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + activeRequest.duration_days - 1);
    const today = startOfDay(new Date());

    const allDays = eachDayOfInterval({ start: startDate, end: endDate });
    
    // Get payments grouped by date
    const paymentsByDate = new Map<string, number>();
    activeRequestRepayments.forEach(payment => {
      const dateKey = format(new Date(payment.payment_date), 'yyyy-MM-dd');
      paymentsByDate.set(dateKey, (paymentsByDate.get(dateKey) || 0) + Number(payment.amount));
    });

    let paidDays = 0;
    let missedDays = 0;
    let upcomingDays = 0;

    const days: DayStatus[] = allDays.map(day => {
      const dateKey = format(day, 'yyyy-MM-dd');
      const paidAmount = paymentsByDate.get(dateKey) || 0;
      const isToday = isSameDay(day, today);
      const isPast = day < today && !isToday;

      if (paidAmount >= Number(activeRequest.daily_repayment)) {
        paidDays++;
        return { date: day, status: 'paid' as const, amount: paidAmount };
      } else if (isToday) {
        return { date: day, status: 'today' as const, amount: paidAmount };
      } else if (isPast) {
        missedDays++;
        return { date: day, status: 'missed' as const, amount: paidAmount };
      } else {
        upcomingDays++;
        return { date: day, status: 'upcoming' as const };
      }
    });

    return { days, paidDays, missedDays, upcomingDays };
  }, [activeRequest, activeRequestRepayments]);

  const buildPdfData = () => ({
    tenantName: 'My Repayment Schedule',
    rentAmount: activeRequest ? Number(activeRequest.rent_amount) : 0,
    totalRepayment: activeRequest ? Number(activeRequest.total_repayment) : 0,
    dailyRepayment: activeRequest ? Number(activeRequest.daily_repayment) : 0,
    durationDays: activeRequest ? activeRequest.duration_days : 0,
    status: activeRequest?.status || 'active',
    paidAmount: activeRepaid,
    startDate: activeRequest ? getStartDate(activeRequest) : undefined,
    schedule: scheduleData.days.map((d, i) => ({
      day: i + 1,
      date: d.date,
      status: d.status as 'paid' | 'missed' | 'upcoming' | 'today',
      expected: activeRequest ? Number(activeRequest.daily_repayment) : 0,
      paid: d.amount || 0,
    })),
  });

  const handleDownloadPdf = async () => {
    if (!activeRequest) return;
    setPdfLoading(true);
    try {
      await downloadRepaymentPdf(buildPdfData());
      toast({ title: 'PDF Downloaded', description: 'Your repayment schedule has been saved.' });
    } catch {
      toast({ title: 'Error', description: 'Could not generate PDF.', variant: 'destructive' });
    } finally {
      setPdfLoading(false);
    }
  };

  const handleWhatsApp = async () => {
    if (!activeRequest) return;
    await shareRepaymentPdfWhatsApp(buildPdfData());
  };

  if (loading) {
    return (

      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            Repayment Schedule
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    );
  }

  // No requests at all
  if (rentRequests.length === 0 && !propActiveRequest) {
    return (
      <Card className="glass-card">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Calendar className="h-5 w-5 text-primary" />
            Repayment Schedule
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-center py-6">
            <Clock className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
            <p className="text-muted-foreground text-sm">
              No repayment schedule yet. Submit a rent request to get started.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Tabs defaultValue="schedule" className="w-full">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="schedule" className="gap-2">
            <CalendarDays className="h-4 w-4" />
            Schedule
          </TabsTrigger>
          <TabsTrigger value="history" className="gap-2">
            <Clock className="h-4 w-4" />
            History
          </TabsTrigger>
        </TabsList>

        {/* Schedule Tab */}
        <TabsContent value="schedule" className="space-y-4 mt-4">
          {/* Make Payment CTA Card */}
          {activeRequest && (
            <Card className="border-0 bg-gradient-to-r from-primary via-primary to-success overflow-hidden">
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <Zap className="h-5 w-5 text-primary-foreground" />
                      <h3 className="font-bold text-primary-foreground">Make Daily Payment</h3>
                    </div>
                    <p className="text-sm text-primary-foreground/80">
                      Pay <span className="font-bold">{formatUGX(Number(activeRequest.daily_repayment))}</span> via MTN or Airtel
                    </p>
                    <RentAccessGrowthInline variant="onPrimary" className="mt-2" />
                    <div className="flex items-center gap-2 mt-2">
                      <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-yellow-500/20">
                        <div className="w-4 h-4 rounded-full bg-yellow-500 flex items-center justify-center">
                          <span className="text-[8px] font-black text-black">MTN</span>
                        </div>
                        <span className="text-xs text-primary-foreground">MoMo</span>
                      </div>
                      <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-red-500/20">
                        <div className="w-4 h-4 rounded-full bg-red-500 flex items-center justify-center">
                          <span className="text-[7px] font-black text-white">A</span>
                        </div>
                        <span className="text-xs text-primary-foreground">Airtel</span>
                      </div>
                    </div>
                  </div>
                  <Button 
                    size="lg"
                    onClick={() => setShowPaymentDialog(true)}
                    className="bg-card text-primary hover:bg-white/90 font-bold shadow-lg"
                  >
                    <Smartphone className="h-4 w-4 mr-2" />
                    Pay Now
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Summary Stats */}
          <div className="grid grid-cols-3 gap-2">
            <div className="p-3 rounded-lg bg-success/10 border border-success/20 text-center">
              <CheckCircle2 className="h-5 w-5 mx-auto text-success mb-1" />
              <p className="text-xl font-bold text-success">{scheduleData.paidDays}</p>
              <p className="text-xs text-muted-foreground">Paid Days</p>
            </div>
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-center">
              <XCircle className="h-5 w-5 mx-auto text-destructive mb-1" />
              <p className="text-xl font-bold text-destructive">{scheduleData.missedDays}</p>
              <p className="text-xs text-muted-foreground">Missed Days</p>
            </div>
            <div className="p-3 rounded-lg bg-muted border border-border text-center">
              <Calendar className="h-5 w-5 mx-auto text-muted-foreground mb-1" />
              <p className="text-xl font-bold">{scheduleData.upcomingDays}</p>
              <p className="text-xs text-muted-foreground">Upcoming</p>
            </div>
          </div>

          {/* Active Request Progress */}
          {activeRequest && (
            <Card className="glass-card overflow-hidden">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Rent Payback Progress</CardTitle>
                  <Badge variant={paymentStatus === 'on-track' ? 'default' : 'destructive'} className="text-xs">
                    {paymentStatus === 'on-track' ? '✓ On Track' : '⚠ Behind'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {/* Visual Progress Circle */}
                <div className="flex items-center gap-4">
                  <div className="relative w-20 h-20 shrink-0">
                    <svg className="w-20 h-20 transform -rotate-90">
                      <circle
                        cx="40"
                        cy="40"
                        r="36"
                        stroke="currentColor"
                        strokeWidth="8"
                        fill="none"
                        className="text-muted/30"
                      />
                      <circle
                        cx="40"
                        cy="40"
                        r="36"
                        stroke="currentColor"
                        strokeWidth="8"
                        fill="none"
                        strokeDasharray={`${2 * Math.PI * 36}`}
                        strokeDashoffset={`${2 * Math.PI * 36 * (1 - activeProgress / 100)}`}
                        strokeLinecap="round"
                        className="text-primary transition-all duration-500"
                      />
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center">
                      <span className="text-lg font-black">{activeProgress.toFixed(0)}%</span>
                    </div>
                  </div>
                  <div className="flex-1 space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Paid</span>
                      <span className="font-bold text-success">{formatUGX(activeRepaid)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Remaining</span>
                      <span className="font-bold">{formatUGX(activeRemaining)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Total</span>
                      <span className="font-mono">{formatUGX(Number(activeRequest.total_repayment))}</span>
                    </div>
                  </div>
                </div>

                {/* Quick Stats */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-primary/5 border border-primary/20">
                    <div className="p-1.5 rounded-full bg-primary/20">
                      <TrendingUp className="h-3.5 w-3.5 text-primary" />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Daily</p>
                      <p className="font-mono font-bold text-sm">{formatUGX(Number(activeRequest.daily_repayment))}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 p-2.5 rounded-lg bg-muted/50">
                    <div className="p-1.5 rounded-full bg-muted">
                      <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Days Left</p>
                      <p className="font-bold text-sm">{scheduleData.upcomingDays} days</p>
                    </div>
                  </div>
                </div>

                {paymentStatus === 'behind' && (
                  <div className="flex items-center gap-2 p-3 rounded-lg bg-destructive/10 border border-destructive/20">
                    <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-destructive">You're behind schedule</p>
                      <p className="text-xs text-destructive/80">
                        Missing {formatUGX(expectedPayments - activeRepaid)} • Late fees may apply
                      </p>
                    </div>
                    <Button 
                      size="sm" 
                      variant="destructive"
                      onClick={() => setShowPaymentDialog(true)}
                    >
                      Pay Now
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Day-by-Day Table Breakdown */}
          {activeRequest && scheduleData.days.length > 0 && (
            <Card className="glass-card">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <CardTitle className="text-base flex items-center gap-2">
                    <CalendarDays className="h-4 w-4 text-primary" />
                    Payment Schedule Breakdown
                  </CardTitle>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs gap-1 text-green-700 border-green-500/40 hover:bg-green-50"
                      onClick={handleWhatsApp}
                    >
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
                      Share
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="text-xs gap-1"
                      onClick={handleDownloadPdf}
                      disabled={pdfLoading}
                    >
                      {pdfLoading ? <Loader2 className="h-3 w-3 animate-spin" /> : <FileDown className="h-3 w-3" />}
                      PDF
                    </Button>
                  </div>
                </div>
                <CardDescription className="text-xs">
                  {activeRequest.duration_days} day repayment period • Daily: {formatUGX(Number(activeRequest.daily_repayment))}
                </CardDescription>
              </CardHeader>

              <CardContent className="p-0">
                <ScrollArea className="h-[400px]">
                  <Table>
                    <TableHeader className="sticky top-0 bg-card z-10">
                      <TableRow>
                        <TableHead className="text-xs">Day</TableHead>
                        <TableHead className="text-xs">Date</TableHead>
                        <TableHead className="text-xs">Status</TableHead>
                        <TableHead className="text-xs text-right">Expected</TableHead>
                        <TableHead className="text-xs text-right">Paid</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {scheduleData.days.map((day, index) => (
                        <TableRow 
                          key={index}
                          className={
                            day.status === 'paid' 
                              ? 'bg-success/5' 
                              : day.status === 'missed'
                              ? 'bg-destructive/5'
                              : day.status === 'today'
                              ? 'bg-primary/10'
                              : ''
                          }
                        >
                          <TableCell className="font-medium text-sm py-2">
                            Day {index + 1}
                          </TableCell>
                          <TableCell className="text-sm py-2">
                            {format(day.date, 'MMM d, yyyy')}
                          </TableCell>
                          <TableCell className="py-2">
                            {day.status === 'paid' && (
                              <Badge variant="default" className="bg-success text-success-foreground text-xs gap-1">
                                <CheckCircle2 className="h-3 w-3" />
                                Paid
                              </Badge>
                            )}
                            {day.status === 'missed' && (
                              <Badge variant="destructive" className="text-xs gap-1">
                                <XCircle className="h-3 w-3" />
                                Missed
                              </Badge>
                            )}
                            {day.status === 'today' && (
                              <Badge variant="default" className="text-xs gap-1">
                                <Clock className="h-3 w-3" />
                                Due Today
                              </Badge>
                            )}
                            {day.status === 'upcoming' && (
                              <Badge variant="secondary" className="text-xs gap-1">
                                <Calendar className="h-3 w-3" />
                                Upcoming
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm py-2">
                            {formatUGX(Number(activeRequest.daily_repayment))}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm py-2">
                            {day.amount && day.amount > 0 ? (
                              <span className="text-success font-semibold">{formatUGX(day.amount)}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </ScrollArea>
                
                {/* Legend */}
                <div className="flex flex-wrap gap-3 p-4 border-t text-xs">
                  <div className="flex items-center gap-1.5">
                    <Badge variant="default" className="bg-success text-success-foreground text-[10px] h-5">Paid</Badge>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="destructive" className="text-[10px] h-5">Missed</Badge>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="default" className="text-[10px] h-5">Due Today</Badge>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Badge variant="secondary" className="text-[10px] h-5">Upcoming</Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* History Tab */}
        <TabsContent value="history" className="space-y-4 mt-4">
          {/* Overview Stats */}
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded-lg bg-primary/10 border border-primary/20">
              <p className="text-xs text-muted-foreground">Total Paid</p>
              <p className="font-mono font-bold text-primary text-lg">{formatUGX(totalPaid)}</p>
            </div>
            <div className="p-3 rounded-lg bg-secondary/50">
              <p className="text-xs text-muted-foreground">Completed Loans</p>
              <p className="font-mono font-bold text-lg">{completedRequests.length}</p>
            </div>
          </div>

          {/* Payment History List */}
          <Card className="glass-card">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Payment History</CardTitle>
                <RepaymentHistoryDrawer userId={userId} />
              </div>
            </CardHeader>
            <CardContent>
              {allRepayments.length > 0 ? (
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {allRepayments.slice(0, 10).map((payment) => (
                    <div 
                      key={payment.id}
                      className="flex items-center justify-between p-3 rounded-lg bg-secondary/30 border border-border/50"
                    >
                      <div className="flex items-center gap-3">
                        <div className="h-8 w-8 rounded-full bg-success/20 flex items-center justify-center">
                          <CheckCircle2 className="h-4 w-4 text-success" />
                        </div>
                        <div>
                          <p className="font-mono font-semibold">{formatUGX(Number(payment.amount))}</p>
                          <p className="text-xs text-muted-foreground">
                            {format(new Date(payment.payment_date), 'MMM d, yyyy')}
                          </p>
                        </div>
                      </div>
                      <Badge variant="outline" className="text-xs">Paid</Badge>
                    </div>
                  ))}
                  {allRepayments.length > 10 && (
                    <p className="text-xs text-muted-foreground text-center py-2">
                      +{allRepayments.length - 10} more payments
                    </p>
                  )}
                </div>
              ) : (
                <div className="text-center py-6">
                  <Clock className="h-10 w-10 mx-auto text-muted-foreground/50 mb-2" />
                  <p className="text-muted-foreground text-sm">No payments recorded yet</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Payment Dialog */}
      <Dialog open={showPaymentDialog} onOpenChange={setShowPaymentDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] p-0">
          <DialogHeader className="p-4 pb-0">
            <DialogTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5 text-primary" />
              Make Repayment
            </DialogTitle>
          </DialogHeader>
          <ScrollArea className="max-h-[calc(90vh-80px)] p-4 pt-2">
            {activeRequest && (
              <div className="space-y-4">
                <RentAccessGrowthInline />
                {/* Amount Info */}
                <Card className="border-0 bg-primary/5">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-muted-foreground">Daily Payment</p>
                        <p className="text-2xl font-black text-primary">
                          {formatUGX(Number(activeRequest.daily_repayment))}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-muted-foreground">Remaining</p>
                        <p className="text-lg font-bold">{formatUGX(activeRemaining)}</p>
                      </div>
                    </div>
                    <Progress value={activeProgress} className="h-2 mt-3" />
                    <p className="text-xs text-muted-foreground mt-1 text-center">
                      {activeProgress.toFixed(0)}% complete
                    </p>
                  </CardContent>
                </Card>

                {/* Payment Partners */}
                <PaymentPartnersCard 
                  dashboardType="tenant"
                  onPaymentSubmitted={() => {
                    setShowPaymentDialog(false);
                    onRepaymentSuccess?.();
                  }}
                />
              </div>
            )}
          </ScrollArea>
        </DialogContent>
      </Dialog>
    </div>
  );
}