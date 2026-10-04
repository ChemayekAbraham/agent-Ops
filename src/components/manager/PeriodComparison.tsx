import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  TrendingUp, TrendingDown, Minus, ArrowLeftRight, 
  CalendarIcon, Wallet, Banknote, Users, PiggyBank
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { 
  Select, 
  SelectContent, 
  SelectItem, 
  SelectTrigger, 
  SelectValue 
} from '@/components/ui/select';
import { 
  format, subDays, subMonths, subWeeks, startOfDay, endOfDay, 
  startOfMonth, endOfMonth, startOfWeek, endOfWeek, startOfYear
} from 'date-fns';

type ComparisonPreset = 'week' | 'month' | 'quarter' | 'year';

interface PeriodMetrics {
  deposits: number;
  withdrawals: number;
  transfers: number;
  rentFacilitated: number;
  platformFees: number;
  agentEarnings: number;
  newUsers: number;
  rentRequests: number;
}

interface ComparisonData {
  current: PeriodMetrics;
  previous: PeriodMetrics;
  currentLabel: string;
  previousLabel: string;
}

export function PeriodComparison() {
  const [preset, setPreset] = useState<ComparisonPreset>('month');
  const [data, setData] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchComparisonData();
  }, [preset]);

  const getDateRanges = () => {
    const now = new Date();
    let currentStart: Date, currentEnd: Date, previousStart: Date, previousEnd: Date;
    let currentLabel: string, previousLabel: string;

    switch (preset) {
      case 'week':
        currentStart = startOfWeek(now, { weekStartsOn: 1 });
        currentEnd = endOfDay(now);
        previousStart = startOfWeek(subWeeks(now, 1), { weekStartsOn: 1 });
        previousEnd = endOfWeek(subWeeks(now, 1), { weekStartsOn: 1 });
        currentLabel = 'This Week';
        previousLabel = 'Last Week';
        break;
      case 'month':
        currentStart = startOfMonth(now);
        currentEnd = endOfDay(now);
        previousStart = startOfMonth(subMonths(now, 1));
        previousEnd = endOfMonth(subMonths(now, 1));
        currentLabel = format(now, 'MMMM yyyy');
        previousLabel = format(subMonths(now, 1), 'MMMM yyyy');
        break;
      case 'quarter':
        currentStart = startOfDay(subDays(now, 90));
        currentEnd = endOfDay(now);
        previousStart = startOfDay(subDays(now, 180));
        previousEnd = endOfDay(subDays(now, 91));
        currentLabel = 'Last 90 Days';
        previousLabel = 'Previous 90 Days';
        break;
      case 'year':
        currentStart = startOfYear(now);
        currentEnd = endOfDay(now);
        previousStart = startOfYear(subMonths(now, 12));
        previousEnd = endOfDay(subDays(startOfYear(now), 1));
        currentLabel = format(now, 'yyyy');
        previousLabel = format(subMonths(now, 12), 'yyyy');
        break;
      default:
        currentStart = startOfMonth(now);
        currentEnd = endOfDay(now);
        previousStart = startOfMonth(subMonths(now, 1));
        previousEnd = endOfMonth(subMonths(now, 1));
        currentLabel = 'This Month';
        previousLabel = 'Last Month';
    }

    return { currentStart, currentEnd, previousStart, previousEnd, currentLabel, previousLabel };
  };

  const fetchPeriodMetrics = async (start: Date, end: Date): Promise<PeriodMetrics> => {
    const [depositsRes, withdrawalsRes, transfersRes, requestsRes, earningsRes, rolesRes] = await Promise.all([
      supabase
        .from('deposit_requests')
        .select('amount')
        .eq('status', 'approved')
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString()),
      supabase
        .from('withdrawal_requests')
        .select('amount')
        .eq('status', 'approved')
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString()),
      supabase
        .from('wallet_transactions')
        .select('amount')
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString()),
      supabase
        .from('rent_requests')
        .select('rent_amount, access_fee, request_fee, status')
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString()),
      supabase
        .from('agent_earnings')
        .select('amount')
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString()),
      supabase
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', start.toISOString())
        .lte('created_at', end.toISOString())
    ]);

    const deposits = (depositsRes.data || []).reduce((sum, d) => sum + Number(d.amount), 0);
    const withdrawals = (withdrawalsRes.data || []).reduce((sum, w) => sum + Number(w.amount), 0);
    const transfers = (transfersRes.data || []).reduce((sum, t) => sum + Number(t.amount), 0);
    
    const completedRequests = (requestsRes.data || []).filter(r => 
      ['funded', 'disbursed', 'completed'].includes(r.status)
    );
    const rentFacilitated = completedRequests.reduce((sum, r) => sum + Number(r.rent_amount), 0);
    const platformFees = completedRequests.reduce((sum, r) => 
      sum + Number(r.access_fee) + Number(r.request_fee), 0
    );
    
    const agentEarnings = (earningsRes.data || []).reduce((sum, e) => sum + Number(e.amount), 0);
    const newUsers = rolesRes.count || 0;
    const rentRequests = (requestsRes.data || []).length;

    return {
      deposits,
      withdrawals,
      transfers,
      rentFacilitated,
      platformFees,
      agentEarnings,
      newUsers,
      rentRequests
    };
  };

  const fetchComparisonData = async () => {
    setLoading(true);
    const { currentStart, currentEnd, previousStart, previousEnd, currentLabel, previousLabel } = getDateRanges();

    const [current, previous] = await Promise.all([
      fetchPeriodMetrics(currentStart, currentEnd),
      fetchPeriodMetrics(previousStart, previousEnd)
    ]);

    setData({ current, previous, currentLabel, previousLabel });
    setLoading(false);
  };

  const calculateChange = (current: number, previous: number) => {
    if (previous === 0) return current > 0 ? 100 : 0;
    return ((current - previous) / previous) * 100;
  };

  const ChangeIndicator = ({ current, previous }: { current: number; previous: number }) => {
    const change = calculateChange(current, previous);
    const isPositive = change > 0;
    const isNeutral = change === 0;

    return (
      <div className={`flex items-center gap-1 text-xs font-medium ${
        isNeutral ? 'text-muted-foreground' : isPositive ? 'text-success' : 'text-destructive'
      }`}>
        {isNeutral ? (
          <Minus className="h-3 w-3" />
        ) : isPositive ? (
          <TrendingUp className="h-3 w-3" />
        ) : (
          <TrendingDown className="h-3 w-3" />
        )}
        <span>{isNeutral ? '0%' : `${isPositive ? '+' : ''}${change.toFixed(1)}%`}</span>
      </div>
    );
  };

  const MetricRow = ({ 
    label, 
    icon: Icon, 
    current, 
    previous, 
    isCurrency = true 
  }: { 
    label: string; 
    icon: any; 
    current: number; 
    previous: number; 
    isCurrency?: boolean;
  }) => (
    <div className="grid grid-cols-4 gap-4 items-center py-3 border-b border-border/50 last:border-0">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{label}</span>
      </div>
      <div className="text-right">
        <p className="font-mono text-sm font-semibold">
          {isCurrency ? formatUGX(previous) : previous}
        </p>
      </div>
      <div className="text-right">
        <p className="font-mono text-sm font-semibold">
          {isCurrency ? formatUGX(current) : current}
        </p>
      </div>
      <div className="flex justify-end">
        <ChangeIndicator current={current} previous={previous} />
      </div>
    </div>
  );

  if (loading && !data) {
    return (
      <Card className="glass-card">
        <CardContent className="py-8 text-center text-muted-foreground">
          Loading comparison data...
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <Card className="glass-card">
      <CardHeader className="pb-2">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <CardTitle className="text-base flex items-center gap-2">
            <ArrowLeftRight className="h-5 w-5" />
            Period Comparison
          </CardTitle>
          <Select value={preset} onValueChange={(v) => setPreset(v as ComparisonPreset)}>
            <SelectTrigger className="w-[180px]">
              <SelectValue placeholder="Select period" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="week">Week over Week</SelectItem>
              <SelectItem value="month">Month over Month</SelectItem>
              <SelectItem value="quarter">Quarter over Quarter</SelectItem>
              <SelectItem value="year">Year over Year</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        {/* Period Labels */}
        <div className="grid grid-cols-4 gap-4 mb-4 pb-2 border-b">
          <div className="text-xs font-medium text-muted-foreground">Metric</div>
          <div className="text-right">
            <Badge variant="outline" className="text-xs">
              <CalendarIcon className="h-3 w-3 mr-1" />
              {data.previousLabel}
            </Badge>
          </div>
          <div className="text-right">
            <Badge variant="default" className="text-xs">
              <CalendarIcon className="h-3 w-3 mr-1" />
              {data.currentLabel}
            </Badge>
          </div>
          <div className="text-right text-xs font-medium text-muted-foreground">Change</div>
        </div>

        {/* Metrics */}
        <div className="space-y-0">
          <MetricRow 
            label="Deposits" 
            icon={Wallet} 
            current={data.current.deposits} 
            previous={data.previous.deposits} 
          />
          <MetricRow 
            label="Withdrawals" 
            icon={Wallet} 
            current={data.current.withdrawals} 
            previous={data.previous.withdrawals} 
          />
          <MetricRow 
            label="Transfers" 
            icon={Wallet} 
            current={data.current.transfers} 
            previous={data.previous.transfers} 
          />
          <MetricRow 
            label="Rent Facilitated" 
            icon={Banknote} 
            current={data.current.rentFacilitated} 
            previous={data.previous.rentFacilitated} 
          />
          <MetricRow 
            label="Platform Fees" 
            icon={PiggyBank} 
            current={data.current.platformFees} 
            previous={data.previous.platformFees} 
          />
          <MetricRow 
            label="Agent Earnings" 
            icon={TrendingUp} 
            current={data.current.agentEarnings} 
            previous={data.previous.agentEarnings} 
          />
          <MetricRow 
            label="Rent Requests" 
            icon={Banknote} 
            current={data.current.rentRequests} 
            previous={data.previous.rentRequests} 
            isCurrency={false}
          />
          <MetricRow 
            label="New Users" 
            icon={Users} 
            current={data.current.newUsers} 
            previous={data.previous.newUsers} 
            isCurrency={false}
          />
        </div>

        {/* Summary */}
        <div className="mt-4 pt-4 border-t">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-3 rounded-lg bg-success/10 text-center">
              <p className="text-xs text-muted-foreground mb-1">Net Flow Change</p>
              <ChangeIndicator 
                current={data.current.deposits - data.current.withdrawals} 
                previous={data.previous.deposits - data.previous.withdrawals} 
              />
            </div>
            <div className="p-3 rounded-lg bg-warning/10 text-center">
              <p className="text-xs text-muted-foreground mb-1">Revenue Change</p>
              <ChangeIndicator 
                current={data.current.platformFees} 
                previous={data.previous.platformFees} 
              />
            </div>
            <div className="p-3 rounded-lg bg-primary/10 text-center">
              <p className="text-xs text-muted-foreground mb-1">Volume Change</p>
              <ChangeIndicator 
                current={data.current.rentFacilitated} 
                previous={data.previous.rentFacilitated} 
              />
            </div>
            <div className="p-3 rounded-lg bg-chart-5/10 text-center">
              <p className="text-xs text-muted-foreground mb-1">User Growth</p>
              <ChangeIndicator 
                current={data.current.newUsers} 
                previous={data.previous.newUsers} 
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
