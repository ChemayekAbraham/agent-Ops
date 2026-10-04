import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  TrendingUp, TrendingDown, Wallet, Users, Banknote, 
  ArrowDownLeft, ArrowUpRight, RefreshCw, PiggyBank,
  Building2, Percent, Gift, CalendarIcon
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { format, startOfDay, endOfDay, subDays, startOfMonth, startOfYear } from 'date-fns';
import { FinancialCharts } from './FinancialCharts';
import { PeriodComparison } from './PeriodComparison';
import { FinancialAlerts } from './FinancialAlerts';
interface FinancialMetrics {
  totalWalletBalances: number;
  totalDeposits: number;
  totalWithdrawals: number;
  totalTransfers: number;
  totalAgentEarnings: number;
  totalCommissions: number;
  totalBonuses: number;
  totalRentFacilitated: number;
  totalPlatformFees: number;
  pendingRepayments: number;
  userCount: number;
  agentCount: number;
  tenantCount: number;
  supporterCount: number;
  // Marketplace metrics
  totalMarketplaceSales: number;
  totalMarketplaceCommissions: number;
  marketplaceOrderCount: number;
  marketplaceProductCount: number;
}

type DatePreset = 'all' | 'today' | '7days' | '30days' | 'month' | 'year' | 'custom';

export function FinancialOverview() {
  const [metrics, setMetrics] = useState<FinancialMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [datePreset, setDatePreset] = useState<DatePreset>('all');
  const [startDate, setStartDate] = useState<Date | undefined>(undefined);
  const [endDate, setEndDate] = useState<Date | undefined>(undefined);

  useEffect(() => {
    fetchMetrics();
  }, [startDate, endDate]);

  const handlePresetChange = (preset: DatePreset) => {
    setDatePreset(preset);
    const now = new Date();
    
    switch (preset) {
      case 'all':
        setStartDate(undefined);
        setEndDate(undefined);
        break;
      case 'today':
        setStartDate(startOfDay(now));
        setEndDate(endOfDay(now));
        break;
      case '7days':
        setStartDate(startOfDay(subDays(now, 7)));
        setEndDate(endOfDay(now));
        break;
      case '30days':
        setStartDate(startOfDay(subDays(now, 30)));
        setEndDate(endOfDay(now));
        break;
      case 'month':
        setStartDate(startOfMonth(now));
        setEndDate(endOfDay(now));
        break;
      case 'year':
        setStartDate(startOfYear(now));
        setEndDate(endOfDay(now));
        break;
      case 'custom':
        // Keep current dates for custom
        break;
    }
  };

  const fetchMetrics = async () => {
    setLoading(true);
    setError(null);

    try {
      // Build date filter
      const buildDateFilter = (query: any, dateColumn: string = 'created_at') => {
        if (startDate) {
          query = query.gte(dateColumn, startDate.toISOString());
        }
        if (endDate) {
          query = query.lte(dateColumn, endDate.toISOString());
        }
        return query;
      };

      // Wallets don't have date filter (current balances)
      const walletsQuery = supabase.from('wallets').select('balance');

      // Apply date filters to transactional data
      let depositsQuery = supabase.from('deposit_requests').select('amount, created_at').eq('status', 'approved');
      let withdrawalsQuery = supabase.from('withdrawal_requests').select('amount, created_at').eq('status', 'approved');
      let transfersQuery = supabase.from('wallet_transactions').select('amount, created_at');
      let earningsQuery = supabase.from('agent_earnings').select('amount, earning_type, created_at');
      let requestsQuery = supabase.from('rent_requests').select('rent_amount, total_repayment, access_fee, request_fee, status, created_at');
      let ordersQuery = supabase.from('product_orders').select('total_price, agent_commission, created_at');
      let productsQuery = supabase.from('products').select('id', { count: 'exact', head: true }).eq('active', true);

      if (startDate || endDate) {
        depositsQuery = buildDateFilter(depositsQuery);
        withdrawalsQuery = buildDateFilter(withdrawalsQuery);
        transfersQuery = buildDateFilter(transfersQuery);
        earningsQuery = buildDateFilter(earningsQuery);
        requestsQuery = buildDateFilter(requestsQuery);
        ordersQuery = buildDateFilter(ordersQuery);
      }

      const [
        walletsRes,
        depositsRes,
        withdrawalsRes,
        transfersRes,
        earningsRes,
        requestsRes,
        rolesRes,
        profilesRes,
        ordersRes,
        productsRes,
      ] = await Promise.all([
        walletsQuery,
        depositsQuery,
        withdrawalsQuery,
        transfersQuery,
        earningsQuery,
        requestsQuery,
        supabase.from('user_roles').select('user_id, role'),
        supabase.from('profiles').select('id', { count: 'exact', head: true }),
        ordersQuery,
        productsQuery,
      ]);

      const errors = [
        walletsRes.error,
        depositsRes.error,
        withdrawalsRes.error,
        transfersRes.error,
        earningsRes.error,
        requestsRes.error,
        rolesRes.error,
        ordersRes.error,
        productsRes.error,
      ].filter(Boolean);

      if (errors.length > 0) {
        console.error('FinancialOverview fetchMetrics errors:', errors);
        throw new Error('Not allowed to load some financial tables.');
      }

      const wallets = walletsRes.data || [];
      const deposits = depositsRes.data || [];
      const withdrawals = withdrawalsRes.data || [];
      const transfers = transfersRes.data || [];
      const earnings = earningsRes.data || [];
      const requests = requestsRes.data || [];
      const roles = rolesRes.data || [];
      const orders = ordersRes.data || [];

      const totalWalletBalances = wallets.reduce((sum, w) => sum + Number(w.balance), 0);
      const totalDeposits = deposits.reduce((sum, d) => sum + Number(d.amount), 0);
      const totalWithdrawals = withdrawals.reduce((sum, w) => sum + Number(w.amount), 0);
      const totalTransfers = transfers.reduce((sum, t) => sum + Number(t.amount), 0);

      const totalAgentEarnings = earnings.reduce((sum, e) => sum + Number(e.amount), 0);
      const totalCommissions = earnings
        .filter((e) => e.earning_type === 'commission')
        .reduce((sum, e) => sum + Number(e.amount), 0);
      const totalBonuses = earnings
        .filter((e) => e.earning_type === 'approval_bonus')
        .reduce((sum, e) => sum + Number(e.amount), 0);

      const completedRequests = requests.filter((r) => ['funded', 'disbursed', 'completed'].includes(r.status));
      const totalRentFacilitated = completedRequests.reduce((sum, r) => sum + Number(r.rent_amount), 0);
      const totalPlatformFees = completedRequests.reduce(
        (sum, r) => sum + Number(r.access_fee) + Number(r.request_fee),
        0
      );

      const activeRequests = requests.filter((r) => ['funded', 'disbursed'].includes(r.status));
      const pendingRepayments = activeRequests.reduce((sum, r) => sum + Number(r.total_repayment), 0);

      // Marketplace metrics from real data
      const totalMarketplaceSales = orders.reduce((sum, o) => sum + Number(o.total_price), 0);
      const totalMarketplaceCommissions = orders.reduce((sum, o) => sum + Number(o.agent_commission), 0);
      const marketplaceOrderCount = orders.length;
      const marketplaceProductCount = productsRes.count || 0;

      // True user count from profiles table
      const userCount = profilesRes.count || 0;
      const agentCount = roles.filter((r) => r.role === 'agent').length;
      const tenantCount = roles.filter((r) => r.role === 'tenant').length;
      const supporterCount = roles.filter((r) => r.role === 'supporter').length;

      setMetrics({
        totalWalletBalances,
        totalDeposits,
        totalWithdrawals,
        totalTransfers,
        totalAgentEarnings,
        totalCommissions,
        totalBonuses,
        totalRentFacilitated,
        totalPlatformFees,
        pendingRepayments,
        userCount,
        agentCount,
        tenantCount,
        supporterCount,
        totalMarketplaceSales,
        totalMarketplaceCommissions,
        marketplaceOrderCount,
        marketplaceProductCount,
      });
    } catch (e: any) {
      console.error('FinancialOverview fetchMetrics failed:', e);
      setError(e?.message || 'Failed to load financial dashboard');
    } finally {
      setLoading(false);
    }
  };

  const getDateRangeLabel = () => {
    if (!startDate && !endDate) return 'All Time';
    if (startDate && endDate) {
      return `${format(startDate, 'MMM d, yyyy')} - ${format(endDate, 'MMM d, yyyy')}`;
    }
    if (startDate) return `From ${format(startDate, 'MMM d, yyyy')}`;
    if (endDate) return `Until ${format(endDate, 'MMM d, yyyy')}`;
    return 'All Time';
  };

  if (error) {
    return (
      <div className="space-y-4">
        <Card className="glass-card">
          <CardContent className="py-8 text-center">
            <div className="mx-auto max-w-md space-y-3">
              <p className="font-semibold">Financial dashboard failed to load</p>
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" onClick={fetchMetrics}>Try again</Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (loading || !metrics) {
    return (
      <div className="space-y-4">
        <Card className="glass-card">
          <CardContent className="py-8 text-center text-muted-foreground">
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
              <p>Loading financial metrics...</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header with Date Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <TrendingUp className="h-5 w-5" />
          Financial Overview
          {loading && <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" />}
        </h2>
        
        <div className="flex flex-wrap items-center gap-2">
          {/* Preset Buttons */}
          <div className="flex flex-wrap gap-1">
            {[
              { value: 'all', label: 'All' },
              { value: 'today', label: 'Today' },
              { value: '7days', label: '7 Days' },
              { value: '30days', label: '30 Days' },
              { value: 'month', label: 'This Month' },
              { value: 'year', label: 'This Year' },
            ].map((preset) => (
              <Button
                key={preset.value}
                variant={datePreset === preset.value ? 'default' : 'outline'}
                size="sm"
                className="text-xs h-8"
                onClick={() => handlePresetChange(preset.value as DatePreset)}
              >
                {preset.label}
              </Button>
            ))}
          </div>

          {/* Custom Date Pickers */}
          <div className="flex items-center gap-2">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-8 text-xs justify-start",
                    !startDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="h-3 w-3 mr-1" />
                  {startDate ? format(startDate, "MMM d") : "From"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="single"
                  selected={startDate}
                  onSelect={(date) => {
                    setStartDate(date);
                    setDatePreset('custom');
                  }}
                  initialFocus
                  className={cn("p-3 pointer-events-auto")}
                />
              </PopoverContent>
            </Popover>
            
            <span className="text-muted-foreground text-xs">to</span>
            
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    "h-8 text-xs justify-start",
                    !endDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="h-3 w-3 mr-1" />
                  {endDate ? format(endDate, "MMM d") : "To"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <Calendar
                  mode="single"
                  selected={endDate}
                  onSelect={(date) => {
                    setEndDate(date ? endOfDay(date) : undefined);
                    setDatePreset('custom');
                  }}
                  initialFocus
                  className={cn("p-3 pointer-events-auto")}
                />
              </PopoverContent>
            </Popover>

            <Button variant="ghost" size="sm" onClick={fetchMetrics} className="h-8">
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
          </div>
        </div>
      </div>

      {/* Date Range Badge */}
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="text-xs">
          <CalendarIcon className="h-3 w-3 mr-1" />
          {getDateRangeLabel()}
        </Badge>
        {datePreset !== 'all' && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 text-xs text-muted-foreground"
            onClick={() => handlePresetChange('all')}
          >
            Clear filter
          </Button>
        )}
      </div>

      {/* Key Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Card className="glass-card">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Wallet className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Wallet Balances</p>
                <p className="font-mono font-bold truncate">{formatUGX(metrics.totalWalletBalances)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-success/10">
                <Banknote className="h-5 w-5 text-success" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Rent Facilitated</p>
                <p className="font-mono font-bold text-success truncate">{formatUGX(metrics.totalRentFacilitated)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-warning/10">
                <PiggyBank className="h-5 w-5 text-warning" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Platform Fees</p>
                <p className="font-mono font-bold text-warning truncate">{formatUGX(metrics.totalPlatformFees)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-chart-5/10">
                <Building2 className="h-5 w-5 text-chart-5" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Pending Repayments</p>
                <p className="font-mono font-bold truncate">{formatUGX(metrics.pendingRepayments)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <TrendingUp className="h-5 w-5 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Marketplace Sales</p>
                <p className="font-mono font-bold text-primary truncate">{formatUGX(metrics.totalMarketplaceSales)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-card">
          <CardContent className="p-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-success/10">
                <Percent className="h-5 w-5 text-success" />
              </div>
              <div className="min-w-0">
                <p className="text-xs text-muted-foreground">Market Commissions</p>
                <p className="font-mono font-bold text-success truncate">{formatUGX(metrics.totalMarketplaceCommissions)}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Breakdown */}
      <Card className="glass-card">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Detailed Breakdown</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="money-flow" className="space-y-4">
            <TabsList className="w-full">
              <TabsTrigger value="money-flow" className="flex-1">Money Flow</TabsTrigger>
              <TabsTrigger value="agent-earnings" className="flex-1">Agent Earnings</TabsTrigger>
              <TabsTrigger value="users" className="flex-1">Users</TabsTrigger>
            </TabsList>

            <TabsContent value="money-flow" className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="flex items-center gap-3 p-4 rounded-lg bg-secondary/50">
                  <div className="p-2 rounded-lg bg-success/10">
                    <ArrowDownLeft className="h-4 w-4 text-success" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Deposits</p>
                    <p className="font-mono font-semibold text-success">{formatUGX(metrics.totalDeposits)}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 rounded-lg bg-secondary/50">
                  <div className="p-2 rounded-lg bg-destructive/10">
                    <ArrowUpRight className="h-4 w-4 text-destructive" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Withdrawals</p>
                    <p className="font-mono font-semibold text-destructive">{formatUGX(metrics.totalWithdrawals)}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 rounded-lg bg-secondary/50">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <TrendingUp className="h-4 w-4 text-primary" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Transfers</p>
                    <p className="font-mono font-semibold">{formatUGX(metrics.totalTransfers)}</p>
                  </div>
                </div>
              </div>

              <div className="p-4 rounded-lg bg-success/5 border border-success/20">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="h-5 w-5 text-success" />
                    <span className="font-medium">Net Flow (Deposits - Withdrawals)</span>
                  </div>
                  <span className={`font-mono font-bold ${metrics.totalDeposits - metrics.totalWithdrawals >= 0 ? 'text-success' : 'text-destructive'}`}>
                    {formatUGX(metrics.totalDeposits - metrics.totalWithdrawals)}
                  </span>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="agent-earnings" className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="flex items-center gap-3 p-4 rounded-lg bg-secondary/50">
                  <div className="p-2 rounded-lg bg-warning/10">
                    <TrendingUp className="h-4 w-4 text-warning" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Agent Earnings</p>
                    <p className="font-mono font-semibold text-warning">{formatUGX(metrics.totalAgentEarnings)}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 rounded-lg bg-secondary/50">
                  <div className="p-2 rounded-lg bg-success/10">
                    <Percent className="h-4 w-4 text-success" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Commissions</p>
                    <p className="font-mono font-semibold text-success">{formatUGX(metrics.totalCommissions)}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 rounded-lg bg-secondary/50">
                  <div className="p-2 rounded-lg bg-warning/10">
                    <Gift className="h-4 w-4 text-warning" />
                  </div>
                  <div>
                    <p className="text-sm text-muted-foreground">Total Bonuses</p>
                    <p className="font-mono font-semibold text-warning">{formatUGX(metrics.totalBonuses)}</p>
                  </div>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="users" className="space-y-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="flex items-center gap-3 p-4 rounded-lg bg-secondary/50">
                  <Users className="h-5 w-5 text-primary" />
                  <div>
                    <p className="text-sm text-muted-foreground">Tenants</p>
                    <p className="font-mono font-semibold">{metrics.tenantCount}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 rounded-lg bg-secondary/50">
                  <Users className="h-5 w-5 text-warning" />
                  <div>
                    <p className="text-sm text-muted-foreground">Agents</p>
                    <p className="font-mono font-semibold">{metrics.agentCount}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 rounded-lg bg-secondary/50">
                  <Users className="h-5 w-5 text-success" />
                  <div>
                    <p className="text-sm text-muted-foreground">Supporters</p>
                    <p className="font-mono font-semibold">{metrics.supporterCount}</p>
                  </div>
                </div>

                <div className="flex items-center gap-3 p-4 rounded-lg bg-secondary/50">
                  <Users className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm text-muted-foreground">Total Users</p>
                    <p className="font-mono font-semibold">{metrics.userCount}</p>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      {/* Financial Charts */}
      <FinancialCharts startDate={startDate} endDate={endDate} />

      {/* Period Comparison */}
      <PeriodComparison />

      {/* Financial Alerts */}
      <FinancialAlerts />
    </div>
  );
}
