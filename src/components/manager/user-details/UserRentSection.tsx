import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { 
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { 
  Home, 
  Calendar, 
  CheckCircle, 
  Clock, 
  XCircle,
  TrendingUp,
  Wallet,
  AlertCircle,
  User,
  ChevronDown,
  ChevronUp,
  FileDown,
  Loader2,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format, addDays, isBefore, isToday, startOfDay } from 'date-fns';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { toast } from '@/hooks/use-toast';
import { downloadRepaymentPdf, shareRepaymentPdfWhatsApp } from '@/lib/repaymentSchedulePdf';



interface RentRequest {
  id: string;
  rent_amount: number;
  total_repayment: number;
  daily_repayment: number;
  duration_days: number;
  status: string | null;
  created_at: string;
  approved_at: string | null;
  funded_at: string | null;
  disbursed_at: string | null;
  access_fee: number;
  request_fee: number;
  landlord: {
    name: string;
    property_address: string;
  } | null;
  agent: {
    full_name: string;
    phone: string;
  } | null;
}

interface Repayment {
  id: string;
  amount: number;
  payment_date: string;
  rent_request_id: string;
}

interface DayStatus {
  day: number;
  date: Date;
  status: 'paid' | 'missed' | 'due_today' | 'upcoming';
  expected: number;
  paid: number;
}

interface UserRentSectionProps {
  userId: string;
}

export default function UserRentSection({ userId }: UserRentSectionProps) {
  const [rentRequests, setRentRequests] = useState<RentRequest[]>([]);
  const [repayments, setRepayments] = useState<Repayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedSchedules, setExpandedSchedules] = useState<Record<string, boolean>>({});
  const [exportingPdf, setExportingPdf] = useState<string | null>(null);
  const [tenantName, setTenantName] = useState<string>('');

  useEffect(() => {
    fetchRentData();
  }, [userId]);

  const fetchRentData = async () => {
    setLoading(true);
    try {
      // Fetch tenant profile
      const { data: tenantProfile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', userId)
        .single();
      
      if (tenantProfile) {
        setTenantName(tenantProfile.full_name);
      }

      // Fetch rent requests with landlord info
      const { data: requests } = await supabase
        .from('rent_requests')
        .select('*, landlord:landlords(name, property_address)')
        .eq('tenant_id', userId)
        .order('created_at', { ascending: false });

      // repayments table removed - stub
      const payments: any[] = [];

      // Fetch agent profiles for requests that have agent_id
      const agentIds = [...new Set((requests || []).map(r => r.agent_id).filter(Boolean))];
      let agentProfiles: Record<string, { full_name: string; phone: string }> = {};
      
      if (agentIds.length > 0) {
        const { data: agents } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', agentIds);
        
        if (agents) {
          agentProfiles = agents.reduce((acc, agent) => {
            acc[agent.id] = { full_name: agent.full_name, phone: agent.phone };
            return acc;
          }, {} as Record<string, { full_name: string; phone: string }>);
        }
      }

      // Merge agent info into requests
      const requestsWithAgents = (requests || []).map(r => ({
        ...r,
        agent: r.agent_id ? agentProfiles[r.agent_id] || null : null
      }));

      setRentRequests(requestsWithAgents as RentRequest[]);
      setRepayments(payments || []);
    } catch (error) {
      console.error('Error fetching rent data:', error);
    } finally {
      setLoading(false);
    }
  };

  const exportScheduleToPdf = async (request: RentRequest, schedule: DayStatus[], paidAmount: number) => {
    setExportingPdf(request.id);
    try {
      await downloadRepaymentPdf({
        tenantName,
        propertyAddress: request.landlord?.property_address,
        landlordName: request.landlord?.name,
        agentName: request.agent?.full_name,
        agentPhone: request.agent?.phone,
        rentAmount: request.rent_amount,
        totalRepayment: request.total_repayment,
        dailyRepayment: request.daily_repayment,
        durationDays: request.duration_days,
        status: request.status || 'pending',
        paidAmount,
        startDate: request.disbursed_at || request.funded_at || request.created_at,
        schedule: schedule.map(d => ({
          day: d.day,
          date: d.date,
          status: d.status,
          expected: d.expected,
          paid: d.paid,
        })),
      });
      toast({ title: 'PDF Downloaded', description: 'Repayment schedule saved.' });
    } catch {
      toast({ title: 'Export Failed', description: 'Could not generate PDF.', variant: 'destructive' });
    } finally {
      setExportingPdf(null);
    }
  };

  const shareOnWhatsApp = async (request: RentRequest, schedule: DayStatus[], paidAmount: number) => {
    await shareRepaymentPdfWhatsApp({
      tenantName,
      propertyAddress: request.landlord?.property_address,
      landlordName: request.landlord?.name,
      agentName: request.agent?.full_name,
      agentPhone: request.agent?.phone,
      rentAmount: request.rent_amount,
      totalRepayment: request.total_repayment,
      dailyRepayment: request.daily_repayment,
      durationDays: request.duration_days,
      status: request.status || 'pending',
      paidAmount,
      startDate: request.disbursed_at || request.funded_at || request.created_at,
      schedule: schedule.map(d => ({
        day: d.day,
        date: d.date,
        status: d.status,
        expected: d.expected,
        paid: d.paid,
      })),
    });
  };

  const getStatusBadge = (status: string | null) => {
    switch (status) {
      case 'approved':
        return <Badge className="bg-success/20 text-success"><CheckCircle className="h-3 w-3 mr-1" />Approved</Badge>;
      case 'funded':
        return <Badge className="bg-primary/20 text-primary"><Wallet className="h-3 w-3 mr-1" />Funded</Badge>;
      case 'disbursed':
        return <Badge className="bg-chart-5/20 text-chart-5"><TrendingUp className="h-3 w-3 mr-1" />Active</Badge>;
      case 'completed':
        return <Badge className="bg-success/20 text-success"><CheckCircle className="h-3 w-3 mr-1" />Completed</Badge>;
      case 'rejected':
        return <Badge className="bg-destructive/20 text-destructive"><XCircle className="h-3 w-3 mr-1" />Rejected</Badge>;
      default:
        return <Badge className="bg-warning/20 text-warning"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
    }
    switch (status) {
      case 'approved':
        return <Badge className="bg-success/20 text-success"><CheckCircle className="h-3 w-3 mr-1" />Approved</Badge>;
      case 'funded':
        return <Badge className="bg-primary/20 text-primary"><Wallet className="h-3 w-3 mr-1" />Funded</Badge>;
      case 'disbursed':
        return <Badge className="bg-chart-5/20 text-chart-5"><TrendingUp className="h-3 w-3 mr-1" />Active</Badge>;
      case 'completed':
        return <Badge className="bg-success/20 text-success"><CheckCircle className="h-3 w-3 mr-1" />Completed</Badge>;
      case 'rejected':
        return <Badge className="bg-destructive/20 text-destructive"><XCircle className="h-3 w-3 mr-1" />Rejected</Badge>;
      default:
        return <Badge className="bg-warning/20 text-warning"><Clock className="h-3 w-3 mr-1" />Pending</Badge>;
    }
  };

  const getStartDate = (request: RentRequest): Date => {
    if (request.disbursed_at) return new Date(request.disbursed_at);
    if (request.funded_at) return new Date(request.funded_at);
    return new Date(request.created_at);
  };

  const generateSchedule = (request: RentRequest, requestPayments: Repayment[]): DayStatus[] => {
    const startDate = startOfDay(getStartDate(request));
    const today = startOfDay(new Date());
    const schedule: DayStatus[] = [];

    // Group payments by date
    const paymentsByDate: Record<string, number> = {};
    requestPayments.forEach(p => {
      const dateKey = format(new Date(p.payment_date), 'yyyy-MM-dd');
      paymentsByDate[dateKey] = (paymentsByDate[dateKey] || 0) + p.amount;
    });

    for (let day = 1; day <= request.duration_days; day++) {
      const date = addDays(startDate, day - 1);
      const dateKey = format(date, 'yyyy-MM-dd');
      const paidAmount = paymentsByDate[dateKey] || 0;

      let status: DayStatus['status'];
      if (paidAmount >= request.daily_repayment) {
        status = 'paid';
      } else if (isToday(date)) {
        status = 'due_today';
      } else if (isBefore(date, today)) {
        status = 'missed';
      } else {
        status = 'upcoming';
      }

      schedule.push({
        day,
        date,
        status,
        expected: request.daily_repayment,
        paid: paidAmount
      });
    }

    return schedule;
  };

  const toggleSchedule = (requestId: string) => {
    setExpandedSchedules(prev => ({
      ...prev,
      [requestId]: !prev[requestId]
    }));
  };

  // Calculate totals
  const activeRequests = rentRequests.filter(r => r.status === 'disbursed' || r.status === 'funded');
  const completedRequests = rentRequests.filter(r => r.status === 'completed');
  
  const totalOwed = activeRequests.reduce((sum, r) => sum + r.total_repayment, 0);
  const totalPaid = repayments.reduce((sum, r) => sum + r.amount, 0);
  const totalRequested = rentRequests.reduce((sum, r) => sum + r.rent_amount, 0);
  const balance = totalOwed - totalPaid;

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Rent Summary Cards */}
      <div className="grid grid-cols-2 gap-3">
        <Card className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <Home className="h-3 w-3" />
            Total Requested
          </div>
          <p className="font-semibold text-sm">{formatUGX(totalRequested)}</p>
          <p className="text-xs text-muted-foreground">{rentRequests.length} requests</p>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <CheckCircle className="h-3 w-3" />
            Total Paid
          </div>
          <p className="font-semibold text-sm text-success">{formatUGX(totalPaid)}</p>
          <p className="text-xs text-muted-foreground">{repayments.length} payments</p>
        </Card>
        <Card className="p-3">
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <TrendingUp className="h-3 w-3" />
            Active Loans
          </div>
          <p className="font-semibold text-sm">{formatUGX(totalOwed)}</p>
          <p className="text-xs text-muted-foreground">{activeRequests.length} active</p>
        </Card>
        <Card className={`p-3 ${balance > 0 ? 'border-warning/50' : 'border-success/50'}`}>
          <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
            <AlertCircle className="h-3 w-3" />
            Outstanding
          </div>
          <p className={`font-semibold text-sm ${balance > 0 ? 'text-warning' : 'text-success'}`}>
            {formatUGX(Math.max(0, balance))}
          </p>
          <p className="text-xs text-muted-foreground">{completedRequests.length} completed</p>
        </Card>
      </div>

      {/* Rent Requests List with Full Schedule */}
      <Card>
        <CardHeader className="py-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Home className="h-4 w-4 text-primary" />
            Rent Request History & Repayment Schedules
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {rentRequests.length === 0 ? (
            <div className="text-center py-6">
              <Home className="h-10 w-10 mx-auto text-muted-foreground mb-2" />
              <p className="text-muted-foreground text-sm">No rent requests yet</p>
            </div>
          ) : (
            <div className="space-y-4">
              {rentRequests.map((request) => {
                const requestPayments = repayments.filter(r => r.rent_request_id === request.id);
                const paidAmount = requestPayments.reduce((sum, r) => sum + r.amount, 0);
                const progress = request.total_repayment > 0 
                  ? Math.min(100, (paidAmount / request.total_repayment) * 100) 
                  : 0;
                const schedule = generateSchedule(request, requestPayments);
                const missedDays = schedule.filter(d => d.status === 'missed').length;
                const paidDays = schedule.filter(d => d.status === 'paid').length;
                const isExpanded = expandedSchedules[request.id];

                return (
                  <Collapsible key={request.id} open={isExpanded} onOpenChange={() => toggleSchedule(request.id)}>
                    <div className="p-3 rounded-lg border bg-muted/30">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">
                            {request.landlord?.property_address || 'Unknown Property'}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            {request.landlord?.name || 'Unknown Landlord'}
                          </p>
                        </div>
                        {getStatusBadge(request.status)}
                      </div>

                      {/* Agent Info */}
                      {request.agent && (
                        <div className="flex items-center gap-2 text-xs bg-primary/10 rounded-md p-2 mb-2">
                          <User className="h-3 w-3 text-primary" />
                          <span className="text-muted-foreground">Agent:</span>
                          <span className="font-medium">{request.agent.full_name}</span>
                          <span className="text-muted-foreground">({request.agent.phone})</span>
                        </div>
                      )}
                      
                      <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                        <div>
                          <span className="text-muted-foreground">Rent: </span>
                          <span className="font-medium">{formatUGX(request.rent_amount)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Repay: </span>
                          <span className="font-medium">{formatUGX(request.total_repayment)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Daily: </span>
                          <span className="font-medium">{formatUGX(request.daily_repayment)}</span>
                        </div>
                        <div>
                          <span className="text-muted-foreground">Days: </span>
                          <span className="font-medium">{request.duration_days}</span>
                        </div>
                      </div>

                      {(request.status === 'disbursed' || request.status === 'funded' || request.status === 'completed') && (
                        <>
                          <div className="mt-2">
                            <div className="flex items-center justify-between text-xs mb-1">
                              <span className="text-muted-foreground">
                                Paid: {formatUGX(paidAmount)} / {formatUGX(request.total_repayment)}
                              </span>
                              <span className="font-medium">{progress.toFixed(0)}%</span>
                            </div>
                            <Progress value={progress} className="h-2" />
                          </div>

                          {/* Quick Stats */}
                          <div className="flex gap-2 mt-2 text-xs">
                            <Badge variant="outline" className="bg-success/10 text-success border-success/30">
                              {paidDays} paid
                            </Badge>
                            {missedDays > 0 && (
                              <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30">
                                {missedDays} missed
                              </Badge>
                            )}
                            <Badge variant="outline" className="bg-muted text-muted-foreground">
                              {request.duration_days - paidDays - missedDays} remaining
                            </Badge>
                          </div>

                          {/* Expand/Collapse Schedule Button */}
                          <CollapsibleTrigger asChild>
                            <Button variant="ghost" size="sm" className="w-full mt-2 text-xs">
                              {isExpanded ? (
                                <>
                                  <ChevronUp className="h-3 w-3 mr-1" />
                                  Hide Full Schedule
                                </>
                              ) : (
                                <>
                                  <ChevronDown className="h-3 w-3 mr-1" />
                                  View Full Schedule ({request.duration_days} days)
                                </>
                              )}
                            </Button>
                          </CollapsibleTrigger>

                          {/* Full Schedule Table */}
                          <CollapsibleContent>
                            <div className="mt-3 border rounded-md overflow-hidden">
                              {/* Export + Share Buttons */}
                              <div className="p-2 bg-muted/50 border-b flex gap-2 justify-end">
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-xs gap-1 text-green-600 border-green-500/40 hover:bg-green-50"
                                  onClick={() => shareOnWhatsApp(request, schedule, paidAmount)}
                                >
                                  <svg className="h-3 w-3" viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
                                  </svg>
                                  WhatsApp
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="text-xs gap-1"
                                  onClick={() => exportScheduleToPdf(request, schedule, paidAmount)}
                                  disabled={exportingPdf === request.id}
                                >
                                  {exportingPdf === request.id ? (
                                    <>
                                      <Loader2 className="h-3 w-3 animate-spin" />
                                      Exporting...
                                    </>
                                  ) : (
                                    <>
                                      <FileDown className="h-3 w-3" />
                                      Download PDF
                                    </>
                                  )}
                                </Button>
                              </div>

                              <div className="max-h-64 overflow-y-auto">
                                <Table>
                                  <TableHeader className="sticky top-0 bg-muted">
                                    <TableRow>
                                      <TableHead className="text-xs py-2">Day</TableHead>
                                      <TableHead className="text-xs py-2">Date</TableHead>
                                      <TableHead className="text-xs py-2">Status</TableHead>
                                      <TableHead className="text-xs py-2 text-right">Expected</TableHead>
                                      <TableHead className="text-xs py-2 text-right">Paid</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {schedule.map((day) => (
                                      <TableRow key={day.day} className={
                                        day.status === 'paid' ? 'bg-success/5' :
                                        day.status === 'missed' ? 'bg-destructive/5' :
                                        day.status === 'due_today' ? 'bg-warning/10' : ''
                                      }>
                                        <TableCell className="text-xs py-1.5 font-medium">
                                          {day.day}
                                        </TableCell>
                                        <TableCell className="text-xs py-1.5">
                                          {format(day.date, 'MMM d')}
                                        </TableCell>
                                        <TableCell className="text-xs py-1.5">
                                          {day.status === 'paid' && (
                                            <span className="text-success flex items-center gap-1">
                                              <CheckCircle className="h-3 w-3" /> Paid
                                            </span>
                                          )}
                                          {day.status === 'missed' && (
                                            <span className="text-destructive flex items-center gap-1">
                                              <XCircle className="h-3 w-3" /> Missed
                                            </span>
                                          )}
                                          {day.status === 'due_today' && (
                                            <span className="text-warning flex items-center gap-1">
                                              <Clock className="h-3 w-3" /> Due Today
                                            </span>
                                          )}
                                          {day.status === 'upcoming' && (
                                            <span className="text-muted-foreground flex items-center gap-1">
                                              <Calendar className="h-3 w-3" /> Upcoming
                                            </span>
                                          )}
                                        </TableCell>
                                        <TableCell className="text-xs py-1.5 text-right">
                                          {formatUGX(day.expected)}
                                        </TableCell>
                                        <TableCell className="text-xs py-1.5 text-right font-medium">
                                          {day.paid > 0 ? formatUGX(day.paid) : '-'}
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            </div>
                          </CollapsibleContent>
                        </>
                      )}

                      <div className="flex items-center gap-1 text-xs text-muted-foreground mt-2">
                        <Calendar className="h-3 w-3" />
                        {format(new Date(request.created_at), 'MMM d, yyyy')}
                        {request.disbursed_at && (
                          <span className="ml-2">
                            • Started: {format(new Date(request.disbursed_at), 'MMM d, yyyy')}
                          </span>
                        )}
                      </div>
                    </div>
                  </Collapsible>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
