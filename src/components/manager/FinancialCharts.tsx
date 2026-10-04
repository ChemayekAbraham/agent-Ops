import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { 
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from 'recharts';
import { format, subDays, startOfDay, eachDayOfInterval, parseISO } from 'date-fns';
import { TrendingUp, BarChart3, PieChartIcon, ShoppingCart } from 'lucide-react';

interface ChartData {
  date: string;
  deposits: number;
  withdrawals: number;
  transfers: number;
  rentRequests: number;
  earnings: number;
  marketplaceRevenue: number;
  orderCount: number;
  agentCommissions: number;
}

interface FinancialChartsProps {
  startDate?: Date;
  endDate?: Date;
}

const CHART_COLORS = {
  deposits: 'hsl(var(--success))',
  withdrawals: 'hsl(var(--destructive))',
  transfers: 'hsl(var(--primary))',
  rentRequests: 'hsl(var(--warning))',
  earnings: 'hsl(var(--chart-5))',
  marketplaceRevenue: 'hsl(160, 84%, 39%)',
  orderCount: 'hsl(262, 83%, 58%)',
  agentCommissions: 'hsl(25, 95%, 53%)',
};

const PIE_COLORS = [
  'hsl(var(--primary))',
  'hsl(var(--success))',
  'hsl(var(--warning))',
  'hsl(var(--destructive))',
  'hsl(var(--chart-5))',
  'hsl(160, 84%, 39%)',
];

export function FinancialCharts({ startDate, endDate }: FinancialChartsProps) {
  const [chartData, setChartData] = useState<ChartData[]>([]);
  const [distributionData, setDistributionData] = useState<any[]>([]);
  const [userDistribution, setUserDistribution] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchChartData();
  }, [startDate, endDate]);

  const fetchChartData = async () => {
    setLoading(true);

    const effectiveEndDate = endDate || new Date();
    const effectiveStartDate = startDate || subDays(effectiveEndDate, 30);

    // Generate date range
    const dateRange = eachDayOfInterval({
      start: startOfDay(effectiveStartDate),
      end: startOfDay(effectiveEndDate)
    });

    // Fetch only wallet + rent + earnings data (core), marketplace removed
    const [depositsRes, transfersRes, requestsRes, earningsRes, rolesRes] = await Promise.all([
      supabase
        .from('wallet_deposits')
        .select('amount, created_at')
        .gte('created_at', effectiveStartDate.toISOString())
        .lte('created_at', effectiveEndDate.toISOString()),
      supabase
        .from('wallet_transactions')
        .select('amount, created_at')
        .gte('created_at', effectiveStartDate.toISOString())
        .lte('created_at', effectiveEndDate.toISOString()),
      supabase
        .from('rent_requests')
        .select('rent_amount, created_at')
        .gte('created_at', effectiveStartDate.toISOString())
        .lte('created_at', effectiveEndDate.toISOString()),
      supabase
        .from('agent_earnings')
        .select('amount, created_at')
        .gte('created_at', effectiveStartDate.toISOString())
        .lte('created_at', effectiveEndDate.toISOString()),
      supabase.from('user_roles').select('role'),
    ]);
    const ordersRes = { data: [] as any[] };
    const withdrawalsRes = { data: [] as { amount: number; created_at: string }[] };

    const deposits = depositsRes.data || [];
    const withdrawals = withdrawalsRes.data || [];
    const transfers = transfersRes.data || [];
    const requests = requestsRes.data || [];
    const earnings = earningsRes.data || [];
    const roles = rolesRes.data || [];
    const orders = ordersRes.data || [];

    // Aggregate by date
    const dataByDate = dateRange.map(date => {
      const dateStr = format(date, 'yyyy-MM-dd');
      const displayDate = format(date, 'MMM d');

      const dayDeposits = deposits
        .filter(d => format(parseISO(d.created_at), 'yyyy-MM-dd') === dateStr)
        .reduce((sum, d) => sum + Number(d.amount), 0);

      const dayWithdrawals = withdrawals
        .filter(w => format(parseISO(w.created_at), 'yyyy-MM-dd') === dateStr)
        .reduce((sum, w) => sum + Number(w.amount), 0);

      const dayTransfers = transfers
        .filter(t => format(parseISO(t.created_at), 'yyyy-MM-dd') === dateStr)
        .reduce((sum, t) => sum + Number(t.amount), 0);

      const dayRequests = requests
        .filter(r => format(parseISO(r.created_at), 'yyyy-MM-dd') === dateStr)
        .reduce((sum, r) => sum + Number(r.rent_amount), 0);

      const dayEarnings = earnings
        .filter(e => format(parseISO(e.created_at), 'yyyy-MM-dd') === dateStr)
        .reduce((sum, e) => sum + Number(e.amount), 0);

      const dayOrders = orders.filter(o => format(parseISO(o.created_at), 'yyyy-MM-dd') === dateStr);
      const dayMarketplaceRevenue = dayOrders.reduce((sum, o) => sum + Number(o.total_price), 0);
      const dayOrderCount = dayOrders.length;
      const dayAgentCommissions = dayOrders.reduce((sum, o) => sum + Number(o.agent_commission), 0);

      return {
        date: displayDate,
        deposits: dayDeposits,
        withdrawals: dayWithdrawals,
        transfers: dayTransfers,
        rentRequests: dayRequests,
        earnings: dayEarnings,
        marketplaceRevenue: dayMarketplaceRevenue,
        orderCount: dayOrderCount,
        agentCommissions: dayAgentCommissions
      };
    });

    setChartData(dataByDate);

    // Calculate totals for pie chart
    const totalDeposits = deposits.reduce((sum, d) => sum + Number(d.amount), 0);
    const totalWithdrawals = withdrawals.reduce((sum, w) => sum + Number(w.amount), 0);
    const totalTransfers = transfers.reduce((sum, t) => sum + Number(t.amount), 0);
    const totalRent = requests.reduce((sum, r) => sum + Number(r.rent_amount), 0);
    const totalEarnings = earnings.reduce((sum, e) => sum + Number(e.amount), 0);

    const totalMarketplaceRevenue = orders.reduce((sum, o) => sum + Number(o.total_price), 0);

    setDistributionData([
      { name: 'Deposits', value: totalDeposits },
      { name: 'Withdrawals', value: totalWithdrawals },
      { name: 'Transfers', value: totalTransfers },
      { name: 'Rent Requests', value: totalRent },
      { name: 'Agent Earnings', value: totalEarnings },
      { name: 'Marketplace Sales', value: totalMarketplaceRevenue }
    ].filter(d => d.value > 0));

    // User distribution
    const tenants = roles.filter(r => r.role === 'tenant').length;
    const agents = roles.filter(r => r.role === 'agent').length;
    const supporters = roles.filter(r => r.role === 'supporter').length;
    const landlords = roles.filter(r => r.role === 'landlord').length;
    const managers = roles.filter(r => r.role === 'manager').length;

    setUserDistribution([
      { name: 'Tenants', value: tenants },
      { name: 'Agents', value: agents },
      { name: 'Supporters', value: supporters },
      { name: 'Landlords', value: landlords },
      { name: 'Managers', value: managers }
    ].filter(d => d.value > 0));

    setLoading(false);
  };

  const formatCurrency = (value: number) => {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
    return value.toString();
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="bg-popover/95 backdrop-blur-sm border border-border rounded-xl p-4 shadow-elevated animate-scale-in">
          <p className="font-semibold text-sm mb-3 pb-2 border-b border-border">{label}</p>
          <div className="space-y-2">
            {payload.map((entry: any, index: number) => (
              <div key={index} className="flex items-center justify-between gap-4 text-xs">
                <div className="flex items-center gap-2">
                  <div 
                    className="w-2.5 h-2.5 rounded-full" 
                    style={{ backgroundColor: entry.color }} 
                  />
                  <span className="text-muted-foreground">{entry.name}</span>
                </div>
                <span className="font-mono font-semibold">UGX {entry.value.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    return null;
  };

  if (loading) {
    return (
      <div className="rounded-xl border bg-card p-8 shadow-soft">
        <div className="flex flex-col items-center justify-center gap-3 text-muted-foreground">
          <div className="h-8 w-8 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Loading charts...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border bg-card shadow-soft overflow-hidden">
      <div className="p-5 border-b border-border bg-muted/30">
        <h3 className="text-base font-semibold flex items-center gap-2">
          <div className="p-2 rounded-lg bg-primary/10">
            <BarChart3 className="h-4 w-4 text-primary" />
          </div>
          Financial Trends
        </h3>
      </div>
      <div className="p-5">
        <Tabs defaultValue="trends" className="space-y-5">
          <TabsList className="w-full bg-muted/50">
            <TabsTrigger value="trends" className="flex-1 gap-2">
              <TrendingUp className="h-4 w-4" />
              <span className="hidden sm:inline">Trends</span>
            </TabsTrigger>
            <TabsTrigger value="marketplace" className="flex-1 gap-2">
              <ShoppingCart className="h-4 w-4" />
              <span className="hidden sm:inline">Marketplace</span>
            </TabsTrigger>
            <TabsTrigger value="comparison" className="flex-1 gap-2">
              <BarChart3 className="h-4 w-4" />
              <span className="hidden sm:inline">Comparison</span>
            </TabsTrigger>
            <TabsTrigger value="distribution" className="flex-1 gap-2">
              <PieChartIcon className="h-4 w-4" />
              <span className="hidden sm:inline">Distribution</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="trends" className="space-y-6">
            {/* Money Flow Area Chart */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <div className="w-1 h-4 rounded-full bg-primary" />
                Money Flow Over Time
              </h4>
              <div className="h-[300px] rounded-lg bg-muted/20 p-4">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorDeposits" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.deposits} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={CHART_COLORS.deposits} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorWithdrawals" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.withdrawals} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={CHART_COLORS.withdrawals} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted/30" />
                    <XAxis 
                      dataKey="date" 
                      tick={{ fontSize: 11 }} 
                      tickLine={false}
                      axisLine={false}
                      className="text-muted-foreground"
                    />
                    <YAxis 
                      tick={{ fontSize: 11 }} 
                      tickFormatter={formatCurrency}
                      tickLine={false}
                      axisLine={false}
                      className="text-muted-foreground"
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Area 
                      type="monotone" 
                      dataKey="deposits" 
                      name="Deposits"
                      stroke={CHART_COLORS.deposits} 
                      fill="url(#colorDeposits)"
                      strokeWidth={2}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="withdrawals" 
                      name="Withdrawals"
                      stroke={CHART_COLORS.withdrawals} 
                      fill="url(#colorWithdrawals)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Rent & Earnings Chart */}
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-muted-foreground">Rent Requests & Agent Earnings</h4>
              <div className="h-[250px]">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorRent" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.rentRequests} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={CHART_COLORS.rentRequests} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorEarnings" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.earnings} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={CHART_COLORS.earnings} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted/30" />
                    <XAxis 
                      dataKey="date" 
                      tick={{ fontSize: 11 }} 
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis 
                      tick={{ fontSize: 11 }} 
                      tickFormatter={formatCurrency}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Area 
                      type="monotone" 
                      dataKey="rentRequests" 
                      name="Rent Requests"
                      stroke={CHART_COLORS.rentRequests} 
                      fill="url(#colorRent)"
                      strokeWidth={2}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="earnings" 
                      name="Agent Earnings"
                      stroke={CHART_COLORS.earnings} 
                      fill="url(#colorEarnings)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="marketplace" className="space-y-6">
            {/* Marketplace Revenue Area Chart */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <div className="w-1 h-4 rounded-full bg-success" />
                Marketplace Revenue Over Time
              </h4>
              <div className="h-[300px] rounded-lg bg-muted/20 p-4">
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <defs>
                      <linearGradient id="colorMarketplace" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.marketplaceRevenue} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={CHART_COLORS.marketplaceRevenue} stopOpacity={0} />
                      </linearGradient>
                      <linearGradient id="colorCommissions" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={CHART_COLORS.agentCommissions} stopOpacity={0.3} />
                        <stop offset="95%" stopColor={CHART_COLORS.agentCommissions} stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted/30" />
                    <XAxis 
                      dataKey="date" 
                      tick={{ fontSize: 11 }} 
                      tickLine={false}
                      axisLine={false}
                      className="text-muted-foreground"
                    />
                    <YAxis 
                      tick={{ fontSize: 11 }} 
                      tickFormatter={formatCurrency}
                      tickLine={false}
                      axisLine={false}
                      className="text-muted-foreground"
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Area 
                      type="monotone" 
                      dataKey="marketplaceRevenue" 
                      name="Sales Revenue"
                      stroke={CHART_COLORS.marketplaceRevenue} 
                      fill="url(#colorMarketplace)"
                      strokeWidth={2}
                    />
                    <Area 
                      type="monotone" 
                      dataKey="agentCommissions" 
                      name="Agent Commissions"
                      stroke={CHART_COLORS.agentCommissions} 
                      fill="url(#colorCommissions)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            {/* Order Volume Bar Chart */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <div className="w-1 h-4 rounded-full bg-primary" />
                Daily Order Volume
              </h4>
              <div className="h-[250px] rounded-lg bg-muted/20 p-4">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted/30" />
                    <XAxis 
                      dataKey="date" 
                      tick={{ fontSize: 11 }} 
                      tickLine={false}
                      axisLine={false}
                      className="text-muted-foreground"
                    />
                    <YAxis 
                      tick={{ fontSize: 11 }} 
                      tickLine={false}
                      axisLine={false}
                      className="text-muted-foreground"
                      allowDecimals={false}
                    />
                    <Tooltip 
                      content={({ active, payload, label }) => {
                        if (active && payload && payload.length) {
                          return (
                            <div className="bg-popover/95 backdrop-blur-sm border border-border rounded-xl p-4 shadow-elevated">
                              <p className="font-semibold text-sm mb-2">{label}</p>
                              <p className="text-sm">
                                <span className="text-muted-foreground">Orders: </span>
                                <span className="font-mono font-semibold">{payload[0].value}</span>
                              </p>
                            </div>
                          );
                        }
                        return null;
                      }}
                    />
                    <Bar 
                      dataKey="orderCount" 
                      name="Orders" 
                      fill={CHART_COLORS.orderCount} 
                      radius={[4, 4, 0, 0]} 
                    />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="comparison" className="space-y-4">
            {/* Daily Comparison Bar Chart */}
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-muted-foreground">Daily Transaction Comparison</h4>
              <div className="h-[350px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-muted/30" />
                    <XAxis 
                      dataKey="date" 
                      tick={{ fontSize: 11 }} 
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis 
                      tick={{ fontSize: 11 }} 
                      tickFormatter={formatCurrency}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip content={<CustomTooltip />} />
                    <Legend />
                    <Bar dataKey="deposits" name="Deposits" fill={CHART_COLORS.deposits} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="withdrawals" name="Withdrawals" fill={CHART_COLORS.withdrawals} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="transfers" name="Transfers" fill={CHART_COLORS.transfers} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="distribution" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Transaction Distribution */}
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-muted-foreground text-center">Transaction Volume Distribution</h4>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={distributionData}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={100}
                        paddingAngle={2}
                        dataKey="value"
                        label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
                        labelLine={false}
                      >
                        {distributionData.map((_, index) => (
                          <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value: number) => `UGX ${value.toLocaleString()}`} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* User Distribution */}
              <div className="space-y-2">
                <h4 className="text-sm font-medium text-muted-foreground text-center">User Role Distribution</h4>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={userDistribution}
                        cx="50%"
                        cy="50%"
                        innerRadius={60}
                        outerRadius={100}
                        paddingAngle={2}
                        dataKey="value"
                        label={({ name, value }) => `${name}: ${value}`}
                        labelLine={false}
                      >
                        {userDistribution.map((_, index) => (
                          <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                        ))}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
