import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { roleToSlug } from '@/lib/roleRoutes';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft,
  TrendingUp,
  Calendar,
  Wallet,
  Clock,
  CheckCircle2,
  Gift,
  Target,
  BarChart3,
  PiggyBank,
  Sparkles,
  ChevronRight,
  Info,
  Trophy
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format, addDays, differenceInDays, startOfMonth, endOfMonth, eachMonthOfInterval, subMonths } from 'date-fns';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Cell } from 'recharts';
import { motion } from 'framer-motion';
import { SupporterROILeaderboard } from '@/components/supporter/SupporterROILeaderboard';

interface ROIPayment {
  id: string;
  payment_proof_id: string;
  rent_amount: number;
  roi_amount: number;
  payment_number: number;
  due_date: string;
  paid_at: string | null;
  status: string;
  created_at: string;
}

interface PaymentProofSummary {
  id: string;
  amount: number;
  status: string;
  verified_at: string;
  next_roi_due_date: string | null;
  total_roi_paid: number;
  roi_payments_count: number;
  landlord?: {
    name: string;
  };
}

export default function SupporterEarnings() {
  const navigate = useNavigate();
  const { user, loading: authLoading, role } = useAuth();
  const [loading, setLoading] = useState(true);
  const [roiPayments, setRoiPayments] = useState<ROIPayment[]>([]);
  const [paymentProofs, setPaymentProofs] = useState<PaymentProofSummary[]>([]);

  useEffect(() => {
    if (user) {
      fetchData();
    }
  }, [user]);

  const fetchData = async () => {
    if (!user) return;
    setLoading(true);

    try {
      // supporter_roi_payments and landlord_payment_proofs tables removed - use empty arrays
      setRoiPayments([]);
      setPaymentProofs([]);
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  // Calculate metrics
  const paidPayments = roiPayments.filter(p => p.status === 'paid');
  const totalEarned = paidPayments.reduce((sum, p) => sum + p.roi_amount, 0);
  const totalInvested = paymentProofs.reduce((sum, p) => sum + p.amount, 0);
  const expectedMonthlyROI = paymentProofs.reduce((sum, p) => sum + Math.round(p.amount * 0.15), 0);
  
  // Project future earnings (12 months)
  const projectedAnnualROI = expectedMonthlyROI * 12;
  const effectiveROIRate = totalInvested > 0 ? ((totalEarned / totalInvested) * 100).toFixed(1) : '0';

  // Calculate cumulative earnings by month
  const getCumulativeChartData = () => {
    const months = eachMonthOfInterval({
      start: subMonths(new Date(), 5),
      end: new Date()
    });

    let cumulative = 0;
    return months.map(month => {
      const monthStart = startOfMonth(month);
      const monthEnd = endOfMonth(month);
      
      const monthlyEarnings = paidPayments
        .filter(p => {
          const paidDate = new Date(p.paid_at!);
          return paidDate >= monthStart && paidDate <= monthEnd;
        })
        .reduce((sum, p) => sum + p.roi_amount, 0);
      
      cumulative += monthlyEarnings;
      
      return {
        month: format(month, 'MMM'),
        earnings: monthlyEarnings,
        cumulative: cumulative
      };
    });
  };

  // Calculate projections (next 6 months)
  const getProjectionData = () => {
    const projections = [];
    let cumulativeProjection = totalEarned;
    
    for (let i = 0; i <= 6; i++) {
      const month = addDays(new Date(), i * 30);
      cumulativeProjection += expectedMonthlyROI;
      
      projections.push({
        month: format(month, 'MMM yy'),
        projected: cumulativeProjection,
        isProjection: i > 0
      });
    }
    
    return projections;
  };

  // Get next payment
  const nextPayment = paymentProofs
    .filter(p => p.next_roi_due_date)
    .sort((a, b) => new Date(a.next_roi_due_date!).getTime() - new Date(b.next_roi_due_date!).getTime())[0];

  const daysUntilNextPayment = nextPayment?.next_roi_due_date 
    ? differenceInDays(new Date(nextPayment.next_roi_due_date), new Date())
    : null;

  if (authLoading || loading) {
    return (
      <div className="min-h-screen bg-background p-4 space-y-4">
        <Skeleton className="h-12 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const cumulativeData = getCumulativeChartData();
  const projectionData = getProjectionData();

  return (
    <div className="min-h-screen bg-gradient-to-b from-background via-background to-success/5 pb-20">
      {/* Header */}
      <header className="sticky top-0 z-50 bg-background/95 backdrop-blur border-b">
        <div className="container mx-auto px-4 py-3 flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="font-bold flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-success" />
              ROI Earnings
            </h1>
            <p className="text-xs text-muted-foreground">Track your support returns</p>
          </div>
        </div>
      </header>

      <main className="container mx-auto px-4 py-6 space-y-6">
        {/* Hero Stats */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-success via-success/90 to-emerald-600 p-6 text-white"
        >
          <div className="absolute top-0 right-0 opacity-10">
            <PiggyBank className="h-32 w-32 -mt-4 -mr-4" />
          </div>
          
          <p className="text-success-foreground/80 text-sm font-medium">Total ROI Earned</p>
          <p className="text-4xl font-black mt-1">{formatUGX(totalEarned)}</p>
          
          <div className="flex items-center gap-2 mt-3">
            <Badge className="bg-white/20 text-white border-0 hover:bg-white/30">
              {effectiveROIRate}% earned
            </Badge>
            <Badge className="bg-white/20 text-white border-0 hover:bg-white/30">
              {paidPayments.length} payments
            </Badge>
          </div>

          {/* Quick Stats Row */}
          <div className="grid grid-cols-3 gap-3 mt-6">
            <div className="bg-white/10 rounded-xl p-3 text-center">
              <Wallet className="h-4 w-4 mx-auto mb-1 opacity-80" />
              <p className="text-lg font-bold">{formatUGX(totalInvested)}</p>
              <p className="text-xs opacity-70">Funded</p>
            </div>
            <div className="bg-white/10 rounded-xl p-3 text-center">
              <Calendar className="h-4 w-4 mx-auto mb-1 opacity-80" />
              <p className="text-lg font-bold">{formatUGX(expectedMonthlyROI)}</p>
              <p className="text-xs opacity-70">Monthly</p>
            </div>
            <div className="bg-white/10 rounded-xl p-3 text-center">
              <Target className="h-4 w-4 mx-auto mb-1 opacity-80" />
              <p className="text-lg font-bold">{paymentProofs.length}</p>
              <p className="text-xs opacity-70">Active</p>
            </div>
          </div>
        </motion.div>

        {/* Next Payment Card */}
        {nextPayment && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 }}
          >
            <Card className="border-primary/20 bg-gradient-to-r from-primary/5 to-transparent">
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="p-2.5 rounded-full bg-primary/10">
                      <Clock className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="font-semibold">Next ROI Payment</p>
                      <p className="text-sm text-muted-foreground">
                        {format(new Date(nextPayment.next_roi_due_date!), 'MMMM d, yyyy')}
                      </p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-xl font-bold text-primary">
                      +{formatUGX(Math.round(nextPayment.amount * 0.15))}
                    </p>
                    {daysUntilNextPayment !== null && (
                      <Badge variant="outline" className="mt-1">
                        {daysUntilNextPayment <= 0 ? 'Due today!' : `${daysUntilNextPayment} days`}
                      </Badge>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        )}

        {/* Charts Tabs */}
        <Tabs defaultValue="history" className="w-full">
          <TabsList className="w-full grid grid-cols-2">
            <TabsTrigger value="history" className="gap-1.5">
              <BarChart3 className="h-4 w-4" />
              History
            </TabsTrigger>
            <TabsTrigger value="projections" className="gap-1.5">
              <TrendingUp className="h-4 w-4" />
              Projections
            </TabsTrigger>
          </TabsList>

          <TabsContent value="history" className="mt-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart3 className="h-4 w-4 text-success" />
                  Cumulative Earnings
                </CardTitle>
              </CardHeader>
              <CardContent>
                {cumulativeData.some(d => d.cumulative > 0) ? (
                  <div className="h-[250px] w-full">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={cumulativeData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                        <defs>
                          <linearGradient id="colorCumulative" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="5%" stopColor="hsl(var(--success))" stopOpacity={0.3} />
                            <stop offset="95%" stopColor="hsl(var(--success))" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                        <XAxis 
                          dataKey="month" 
                          tick={{ fontSize: 12 }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis 
                          tickFormatter={(value) => `${(value / 1000).toFixed(0)}k`}
                          tick={{ fontSize: 12 }}
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip 
                          formatter={(value: number) => [formatUGX(value), 'Total']}
                          labelStyle={{ fontWeight: 'bold' }}
                          contentStyle={{ 
                            borderRadius: '8px',
                            border: '1px solid hsl(var(--border))',
                            backgroundColor: 'hsl(var(--background))'
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="cumulative"
                          stroke="hsl(var(--success))"
                          strokeWidth={2}
                          fillOpacity={1}
                          fill="url(#colorCumulative)"
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <div className="h-[200px] flex items-center justify-center">
                    <div className="text-center">
                      <Sparkles className="h-12 w-12 mx-auto text-muted-foreground/30 mb-2" />
                      <p className="text-muted-foreground">No earnings history yet</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Your first ROI payment will arrive 30 days after verification
                      </p>
                    </div>
                  </div>
                )}

                {/* Monthly Breakdown */}
                {cumulativeData.some(d => d.earnings > 0) && (
                  <div className="mt-4 pt-4 border-t">
                    <p className="text-sm font-medium mb-3">Monthly Breakdown</p>
                    <div className="space-y-2">
                      {cumulativeData.filter(d => d.earnings > 0).slice(-3).reverse().map((data, idx) => (
                        <div key={idx} className="flex items-center justify-between p-2 rounded-lg bg-muted/50">
                          <span className="text-sm">{data.month}</span>
                          <span className="font-medium text-success">+{formatUGX(data.earnings)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="projections" className="mt-4">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-primary" />
                  6-Month Projection
                </CardTitle>
              </CardHeader>
              <CardContent>
                {expectedMonthlyROI > 0 ? (
                  <>
                    <div className="h-[250px] w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={projectionData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                          <defs>
                            <linearGradient id="colorProjected" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                              <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                          <XAxis 
                            dataKey="month" 
                            tick={{ fontSize: 12 }}
                            tickLine={false}
                            axisLine={false}
                          />
                          <YAxis 
                            tickFormatter={(value) => `${(value / 1000).toFixed(0)}k`}
                            tick={{ fontSize: 12 }}
                            tickLine={false}
                            axisLine={false}
                          />
                          <Tooltip 
                            formatter={(value: number) => [formatUGX(value), 'Projected']}
                            labelStyle={{ fontWeight: 'bold' }}
                            contentStyle={{ 
                              borderRadius: '8px',
                              border: '1px solid hsl(var(--border))',
                              backgroundColor: 'hsl(var(--background))'
                            }}
                          />
                          <Area
                            type="monotone"
                            dataKey="projected"
                            stroke="hsl(var(--primary))"
                            strokeWidth={2}
                            strokeDasharray="5 5"
                            fillOpacity={1}
                            fill="url(#colorProjected)"
                          />
                        </AreaChart>
                      </ResponsiveContainer>
                    </div>

                    {/* Projection Summary */}
                    <div className="mt-4 p-4 rounded-xl bg-primary/5 border border-primary/20">
                      <div className="flex items-start gap-2 mb-3">
                        <Info className="h-4 w-4 text-primary mt-0.5" />
                        <p className="text-sm text-muted-foreground">
                          Based on your current {paymentProofs.length} active funding(s), you could earn:
                        </p>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="text-center p-3 rounded-lg bg-background">
                          <p className="text-2xl font-bold text-primary">{formatUGX(projectedAnnualROI)}</p>
                          <p className="text-xs text-muted-foreground">Annual projection</p>
                        </div>
                        <div className="text-center p-3 rounded-lg bg-background">
                          <p className="text-2xl font-bold">180%</p>
                          <p className="text-xs text-muted-foreground">Annual ROI rate</p>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <div className="h-[200px] flex items-center justify-center">
                    <div className="text-center">
                      <Target className="h-12 w-12 mx-auto text-muted-foreground/30 mb-2" />
                      <p className="text-muted-foreground">No active funding packages</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Fund tenant rent to start earning 15% monthly ROI
                      </p>
                      <Button 
                        size="sm" 
                        className="mt-4"
                        onClick={() => navigate(roleToSlug(role))}
                      >
                        Start Funding
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* Payment History */}
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Gift className="h-4 w-4 text-success" />
                Payment History
              </CardTitle>
              <Badge variant="outline">{paidPayments.length} payments</Badge>
            </div>
          </CardHeader>
          <CardContent>
            {roiPayments.length === 0 ? (
              <div className="text-center py-8">
                <Sparkles className="h-12 w-12 mx-auto text-muted-foreground/30 mb-2" />
                <p className="text-muted-foreground">No ROI payments yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Your first payment arrives 30 days after verification
                </p>
              </div>
            ) : (
              <ScrollArea className="h-[300px]">
                <div className="space-y-2 pr-2">
                  {roiPayments.map(payment => (
                    <div 
                      key={payment.id}
                      className="flex items-center justify-between p-3 rounded-xl border bg-card hover:bg-muted/50 transition-colors"
                    >
                      <div className="flex items-center gap-3">
                        <div className={`p-2 rounded-full ${
                          payment.status === 'paid' ? 'bg-success/20' : 'bg-warning/20'
                        }`}>
                          {payment.status === 'paid' ? (
                            <CheckCircle2 className="h-4 w-4 text-success" />
                          ) : (
                            <Clock className="h-4 w-4 text-warning" />
                          )}
                        </div>
                        <div>
                          <p className="font-medium text-sm">Payment #{payment.payment_number}</p>
                          <p className="text-xs text-muted-foreground">
                            From {formatUGX(payment.rent_amount)} funding
                          </p>
                        </div>
                      </div>
                      <div className="text-right">
                        <p className={`font-bold ${payment.status === 'paid' ? 'text-success' : ''}`}>
                          {payment.status === 'paid' ? '+' : ''}{formatUGX(payment.roi_amount)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {payment.paid_at 
                            ? format(new Date(payment.paid_at), 'MMM d, yyyy')
                            : `Due ${format(new Date(payment.due_date), 'MMM d')}`
                          }
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        {/* Active Fundings */}
        {paymentProofs.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Wallet className="h-4 w-4 text-primary" />
                Active Fundings
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {paymentProofs.map(proof => (
                  <div 
                    key={proof.id}
                    className="flex items-center justify-between p-3 rounded-xl border bg-card"
                  >
                    <div>
                      <p className="font-medium text-sm">
                        {proof.landlord?.name || 'Landlord Payment'}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {formatUGX(proof.amount)} • {proof.roi_payments_count || 0} payments made
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium text-success">
                        +{formatUGX(proof.total_roi_paid || 0)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        earned
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* ROI Leaderboard */}
        <SupporterROILeaderboard limit={10} />
      </main>
    </div>
  );
}
