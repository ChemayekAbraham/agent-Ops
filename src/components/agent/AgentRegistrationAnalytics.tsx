import { useState, useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { 
  Users, Building2, TrendingUp, TrendingDown, 
  CheckCircle2, Clock, Target, Percent, ArrowRight, 
  Calendar, Minus, FileText, FileSpreadsheet, Share2
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { exportToCSV, exportToPDF } from '@/lib/exportUtils';
import { toast } from 'sonner';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, 
  Tooltip, ResponsiveContainer, PieChart, Pie, Cell,
  BarChart, Bar
} from 'recharts';
import { format, subDays, startOfDay, eachDayOfInterval, startOfMonth, subMonths, endOfMonth } from 'date-fns';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { AgentGoalCard } from './AgentGoalCard';
import { AgentLeaderboard } from './AgentLeaderboard';
import { ShareablePerformanceCard } from './ShareablePerformanceCard';
import { useProfile } from '@/hooks/useProfile';

interface RegistrationStats {
  total: number;
  pending: number;
  activated: number;
  tenants: number;
  landlords: number;
  conversionRate: number;
  thisWeek: number;
  lastWeek: number;
  weeklyGrowth: number;
}

interface PeriodComparison {
  current: {
    registrations: number;
    activations: number;
    tenants: number;
    landlords: number;
    conversionRate: number;
  };
  previous: {
    registrations: number;
    activations: number;
    tenants: number;
    landlords: number;
    conversionRate: number;
  };
}

interface DailyData {
  date: string;
  registrations: number;
  activations: number;
}

const COLORS = ['hsl(var(--success))', 'hsl(var(--warning))'];
const ROLE_COLORS = ['hsl(var(--primary))', 'hsl(var(--chart-2))'];

// Helper component for comparison rows
function ComparisonRow({ 
  label, 
  icon, 
  previous, 
  current, 
  isPercentage = false 
}: { 
  label: string; 
  icon: React.ReactNode; 
  previous: number; 
  current: number;
  isPercentage?: boolean;
}) {
  const change = previous > 0 
    ? Math.round(((current - previous) / previous) * 100) 
    : current > 0 ? 100 : 0;
  
  const formatValue = (val: number) => isPercentage ? `${val}%` : val;
  
  return (
    <div className="flex items-center justify-between p-2 rounded-lg bg-muted/30">
      <div className="flex items-center gap-2">
        <div className="text-muted-foreground">{icon}</div>
        <span className="text-sm font-medium">{label}</span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">{formatValue(previous)}</span>
        <ArrowRight className="h-3 w-3 text-muted-foreground" />
        <span className="text-sm font-bold">{formatValue(current)}</span>
        {change !== 0 ? (
          <Badge 
            variant="outline" 
            className={`gap-0.5 text-xs ${
              change > 0 
                ? 'bg-success/10 text-success border-success/20' 
                : 'bg-destructive/10 text-destructive border-destructive/20'
            }`}
          >
            {change > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            {change > 0 ? '+' : ''}{change}%
          </Badge>
        ) : (
          <Badge variant="outline" className="gap-0.5 text-xs bg-muted/50 text-muted-foreground border-muted">
            <Minus className="h-3 w-3" />
            0%
          </Badge>
        )}
      </div>
    </div>
  );
}

export function AgentRegistrationAnalytics() {
  const { user } = useAuth();
  const { profile } = useProfile();
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [showShareCard, setShowShareCard] = useState(false);
  const [leaderboardRank, setLeaderboardRank] = useState<number | undefined>(undefined);
  const reportRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<RegistrationStats>({
    total: 0,
    pending: 0,
    activated: 0,
    tenants: 0,
    landlords: 0,
    conversionRate: 0,
    thisWeek: 0,
    lastWeek: 0,
    weeklyGrowth: 0,
  });
  const [dailyData, setDailyData] = useState<DailyData[]>([]);
  const [comparisonPeriod, setComparisonPeriod] = useState<'week' | 'month'>('week');
  const [comparison, setComparison] = useState<PeriodComparison>({
    current: { registrations: 0, activations: 0, tenants: 0, landlords: 0, conversionRate: 0 },
    previous: { registrations: 0, activations: 0, tenants: 0, landlords: 0, conversionRate: 0 },
  });

  // Fetch leaderboard rank for the current user
  const fetchLeaderboardRank = async () => {
    if (!user) return;
    
    try {
      // Fetch all invites to calculate ranks
      const { data: invites } = await supabase
        .from('supporter_invites')
        .select('created_by, status')
        .in('role', ['tenant', 'landlord']);

      if (!invites) return;

      // Aggregate by agent
      const agentStats = new Map<string, number>();
      invites.forEach(invite => {
        const current = agentStats.get(invite.created_by) || 0;
        agentStats.set(invite.created_by, current + 1);
      });

      // Sort by total registrations to get rankings
      const sortedAgents = Array.from(agentStats.entries())
        .sort((a, b) => b[1] - a[1]);

      // Find current user's rank
      const userRankIndex = sortedAgents.findIndex(([id]) => id === user.id);
      if (userRankIndex !== -1) {
        setLeaderboardRank(userRankIndex + 1);
      }
    } catch (error) {
      console.error('Error fetching leaderboard rank:', error);
    }
  };

  const handleExportCSV = () => {
    try {
      const data = {
        headers: ['Metric', 'Value'],
        rows: [
          ['Total Registered', stats.total],
          ['Activated', stats.activated],
          ['Pending', stats.pending],
          ['Tenants', stats.tenants],
          ['Landlords', stats.landlords],
          ['Conversion Rate', `${stats.conversionRate}%`],
          ['This Week', stats.thisWeek],
          ['Last Week', stats.lastWeek],
          ['Weekly Growth', `${stats.weeklyGrowth}%`],
          ['', ''],
          ['--- Daily Data (Last 14 Days) ---', ''],
          ['Date', 'Registrations', 'Activations'],
          ...dailyData.map(d => [d.date, d.registrations, d.activations]),
          ['', ''],
          ['--- Period Comparison ---', ''],
          ['Metric', 'Previous Period', 'Current Period', 'Change'],
          ['Registrations', comparison.previous.registrations, comparison.current.registrations, 
            `${comparison.previous.registrations > 0 ? Math.round(((comparison.current.registrations - comparison.previous.registrations) / comparison.previous.registrations) * 100) : 0}%`],
          ['Activations', comparison.previous.activations, comparison.current.activations,
            `${comparison.previous.activations > 0 ? Math.round(((comparison.current.activations - comparison.previous.activations) / comparison.previous.activations) * 100) : 0}%`],
          ['Tenants', comparison.previous.tenants, comparison.current.tenants,
            `${comparison.previous.tenants > 0 ? Math.round(((comparison.current.tenants - comparison.previous.tenants) / comparison.previous.tenants) * 100) : 0}%`],
          ['Landlords', comparison.previous.landlords, comparison.current.landlords,
            `${comparison.previous.landlords > 0 ? Math.round(((comparison.current.landlords - comparison.previous.landlords) / comparison.previous.landlords) * 100) : 0}%`],
        ] as (string | number)[][],
      };
      
      exportToCSV(data, 'agent_performance_report');
      toast.success('CSV report downloaded');
    } catch (error) {
      console.error('CSV export failed:', error);
      toast.error('Failed to export CSV');
    }
  };

  const handleExportPDF = async () => {
    if (!reportRef.current) return;
    
    setExporting(true);
    try {
      await exportToPDF(reportRef.current, 'agent_performance_report', 'Agent Performance Report');
      toast.success('PDF report downloaded');
    } catch (error) {
      console.error('PDF export failed:', error);
      toast.error('Failed to export PDF');
    } finally {
      setExporting(false);
    }
  };

  useEffect(() => {
    if (user) {
      fetchAnalytics();
      fetchLeaderboardRank();
    }
  }, [user]);

  // Calculate period comparison whenever data or period changes
  useEffect(() => {
    if (!user) return;
    
    const calculateComparison = async () => {
      try {
        const { data: invites } = await supabase
          .from('supporter_invites')
          .select('*')
          .eq('created_by', user.id)
          .in('role', ['tenant', 'landlord']);

        const allInvites = invites || [];
        const now = new Date();
        
        let currentStart: Date, currentEnd: Date, previousStart: Date, previousEnd: Date;
        
        if (comparisonPeriod === 'week') {
          currentEnd = now;
          currentStart = subDays(startOfDay(now), 7);
          previousEnd = currentStart;
          previousStart = subDays(currentStart, 7);
        } else {
          // Month comparison
          currentStart = startOfMonth(now);
          currentEnd = now;
          const prevMonth = subMonths(now, 1);
          previousStart = startOfMonth(prevMonth);
          previousEnd = endOfMonth(prevMonth);
        }

        const filterByPeriod = (start: Date, end: Date) => {
          return allInvites.filter(i => {
            const date = new Date(i.created_at);
            return date >= start && date <= end;
          });
        };

        const currentInvites = filterByPeriod(currentStart, currentEnd);
        const previousInvites = filterByPeriod(previousStart, previousEnd);

        const calculateMetrics = (invites: typeof allInvites) => {
          const registrations = invites.length;
          const activations = invites.filter(i => i.status === 'activated').length;
          const tenants = invites.filter(i => i.role === 'tenant').length;
          const landlords = invites.filter(i => i.role === 'landlord').length;
          const conversionRate = registrations > 0 ? Math.round((activations / registrations) * 100) : 0;
          return { registrations, activations, tenants, landlords, conversionRate };
        };

        setComparison({
          current: calculateMetrics(currentInvites),
          previous: calculateMetrics(previousInvites),
        });
      } catch (error) {
        console.error('Error calculating comparison:', error);
      }
    };

    calculateComparison();
  }, [user, comparisonPeriod]);

  const fetchAnalytics = async () => {
    if (!user) return;
    setLoading(true);

    try {
      // Fetch all invites by this agent
      const { data: invites, error } = await supabase
        .from('supporter_invites')
        .select('*')
        .eq('created_by', user.id)
        .in('role', ['tenant', 'landlord'])
        .order('created_at', { ascending: true });

      if (error) throw error;

      const allInvites = invites || [];
      
      // Calculate stats
      const total = allInvites.length;
      const pending = allInvites.filter(i => i.status === 'pending').length;
      const activated = allInvites.filter(i => i.status === 'activated').length;
      const tenants = allInvites.filter(i => i.role === 'tenant').length;
      const landlords = allInvites.filter(i => i.role === 'landlord').length;
      const conversionRate = total > 0 ? Math.round((activated / total) * 100) : 0;

      // Weekly comparison
      const now = new Date();
      const thisWeekStart = subDays(startOfDay(now), 7);
      const lastWeekStart = subDays(startOfDay(now), 14);

      const thisWeek = allInvites.filter(i => 
        new Date(i.created_at) >= thisWeekStart
      ).length;

      const lastWeek = allInvites.filter(i => 
        new Date(i.created_at) >= lastWeekStart && 
        new Date(i.created_at) < thisWeekStart
      ).length;

      const weeklyGrowth = lastWeek > 0 
        ? Math.round(((thisWeek - lastWeek) / lastWeek) * 100) 
        : thisWeek > 0 ? 100 : 0;

      setStats({
        total,
        pending,
        activated,
        tenants,
        landlords,
        conversionRate,
        thisWeek,
        lastWeek,
        weeklyGrowth,
      });

      // Build daily data for last 14 days
      const days = eachDayOfInterval({
        start: subDays(now, 13),
        end: now,
      });

      const dailyStats = days.map(day => {
        const dayStart = startOfDay(day);
        const dayEnd = new Date(dayStart);
        dayEnd.setDate(dayEnd.getDate() + 1);

        const registrations = allInvites.filter(i => {
          const date = new Date(i.created_at);
          return date >= dayStart && date < dayEnd;
        }).length;

        const activations = allInvites.filter(i => {
          if (!i.activated_at) return false;
          const date = new Date(i.activated_at);
          return date >= dayStart && date < dayEnd;
        }).length;

        return {
          date: format(day, 'MMM d'),
          registrations,
          activations,
        };
      });

      setDailyData(dailyStats);
    } catch (error) {
      console.error('Error fetching analytics:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-32 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  const statusData = [
    { name: 'Activated', value: stats.activated },
    { name: 'Pending', value: stats.pending },
  ];

  const roleData = [
    { name: 'Tenants', value: stats.tenants },
    { name: 'Landlords', value: stats.landlords },
  ];

  return (
    <div className="space-y-4">
      {/* Export & Share Buttons */}
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setShowShareCard(true)}
          className="gap-1.5"
        >
          <Share2 className="h-4 w-4" />
          Share
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExportCSV}
          className="gap-1.5"
        >
          <FileSpreadsheet className="h-4 w-4" />
          CSV
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={handleExportPDF}
          disabled={exporting}
          className="gap-1.5"
        >
          <FileText className="h-4 w-4" />
          {exporting ? 'Exporting...' : 'PDF'}
        </Button>
      </div>

      {/* Shareable Performance Card Dialog */}
      <ShareablePerformanceCard
        stats={stats}
        userName={profile?.full_name || 'Agent'}
        open={showShareCard}
        onOpenChange={setShowShareCard}
        leaderboardRank={leaderboardRank}
      />

      {/* Report Content for PDF export */}
      <div ref={reportRef} className="space-y-4">
        {/* Monthly Goal Card */}
        <AgentGoalCard />
        <div className="grid grid-cols-2 gap-3">
        <Card className="bg-gradient-to-br from-primary/10 to-background">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Total Registered</p>
                <p className="text-2xl font-bold">{stats.total}</p>
              </div>
              <div className="p-2 rounded-lg bg-primary/20">
                <Users className="h-5 w-5 text-primary" />
              </div>
            </div>
            <div className="mt-2 flex items-center gap-1 text-xs">
              {stats.weeklyGrowth >= 0 ? (
                <Badge variant="outline" className="bg-success/10 text-success border-success/20 gap-1">
                  <TrendingUp className="h-3 w-3" />
                  +{stats.weeklyGrowth}%
                </Badge>
              ) : (
                <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20 gap-1">
                  <TrendingDown className="h-3 w-3" />
                  {stats.weeklyGrowth}%
                </Badge>
              )}
              <span className="text-muted-foreground">vs last week</span>
            </div>
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-success/10 to-background">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">Conversion Rate</p>
                <p className="text-2xl font-bold">{stats.conversionRate}%</p>
              </div>
              <div className="p-2 rounded-lg bg-success/20">
                <Percent className="h-5 w-5 text-success" />
              </div>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3 text-success" />
                {stats.activated} active
              </span>
              <span className="flex items-center gap-1">
                <Clock className="h-3 w-3 text-warning" />
                {stats.pending} pending
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">This Week</p>
                <p className="text-2xl font-bold">{stats.thisWeek}</p>
              </div>
              <div className="p-2 rounded-lg bg-primary/10">
                <Target className="h-5 w-5 text-primary" />
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {stats.lastWeek} last week
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground">By Role</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="flex items-center gap-1 text-sm font-medium">
                    <Users className="h-3 w-3 text-blue-500" />
                    {stats.tenants}
                  </span>
                  <span className="flex items-center gap-1 text-sm font-medium">
                    <Building2 className="h-3 w-3 text-emerald-500" />
                    {stats.landlords}
                  </span>
                </div>
              </div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Tenants & Landlords
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Registration Trend Chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            Registration Trend (14 days)
          </CardTitle>
        </CardHeader>
        <CardContent className="pb-4">
          <div className="h-48">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dailyData} margin={{ top: 5, right: 5, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="regGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                  </linearGradient>
                  <linearGradient id="actGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--success))" stopOpacity={0.3}/>
                    <stop offset="95%" stopColor="hsl(var(--success))" stopOpacity={0}/>
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
                <XAxis 
                  dataKey="date" 
                  tick={{ fontSize: 10 }} 
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis 
                  tick={{ fontSize: 10 }} 
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip 
                  contentStyle={{ 
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '8px',
                    fontSize: '12px'
                  }}
                />
                <Area 
                  type="monotone" 
                  dataKey="registrations" 
                  stroke="hsl(var(--primary))" 
                  fill="url(#regGradient)"
                  strokeWidth={2}
                  name="Registered"
                />
                <Area 
                  type="monotone" 
                  dataKey="activations" 
                  stroke="hsl(var(--success))" 
                  fill="url(#actGradient)"
                  strokeWidth={2}
                  name="Activated"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-center gap-4 mt-2 text-xs">
            <span className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-full bg-primary" />
              Registered
            </span>
            <span className="flex items-center gap-1">
              <div className="w-3 h-3 rounded-full bg-success" />
              Activated
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Status & Role Distribution */}
      <div className="grid grid-cols-2 gap-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Status</CardTitle>
          </CardHeader>
          <CardContent className="pb-4">
            <div className="h-32">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={statusData}
                    cx="50%"
                    cy="50%"
                    innerRadius={25}
                    outerRadius={45}
                    paddingAngle={5}
                    dataKey="value"
                  >
                    {statusData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                      fontSize: '11px'
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div className="flex justify-center gap-3 text-xs">
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-success" />
                Active
              </span>
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-warning" />
                Pending
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Roles</CardTitle>
          </CardHeader>
          <CardContent className="pb-4">
            <div className="h-32">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={roleData} layout="vertical" margin={{ left: -10 }}>
                  <XAxis type="number" hide />
                  <YAxis 
                    type="category" 
                    dataKey="name" 
                    tick={{ fontSize: 10 }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip 
                    contentStyle={{ 
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                      fontSize: '11px'
                    }}
                  />
                  <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                    {roleData.map((_, index) => (
                      <Cell key={`cell-${index}`} fill={ROLE_COLORS[index % ROLE_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Period Comparison */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <Calendar className="h-4 w-4 text-primary" />
              Performance Comparison
            </CardTitle>
            <ToggleGroup
              type="single"
              value={comparisonPeriod}
              onValueChange={(value) => value && setComparisonPeriod(value as 'week' | 'month')}
              className="h-7"
            >
              <ToggleGroupItem value="week" className="text-xs px-2 h-7">
                Weekly
              </ToggleGroupItem>
              <ToggleGroupItem value="month" className="text-xs px-2 h-7">
                Monthly
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          <div className="flex items-center justify-center gap-4 mb-4">
            <Badge variant="outline" className="text-xs">
              Previous {comparisonPeriod === 'week' ? 'Week' : 'Month'}
            </Badge>
            <ArrowRight className="h-4 w-4 text-muted-foreground" />
            <Badge variant="default" className="text-xs">
              Current {comparisonPeriod === 'week' ? 'Week' : 'Month'}
            </Badge>
          </div>
          
          <div className="space-y-3">
            <ComparisonRow 
              label="Registrations"
              icon={<Users className="h-4 w-4" />}
              previous={comparison.previous.registrations}
              current={comparison.current.registrations}
            />
            <ComparisonRow 
              label="Activations"
              icon={<CheckCircle2 className="h-4 w-4" />}
              previous={comparison.previous.activations}
              current={comparison.current.activations}
            />
            <ComparisonRow 
              label="Tenants"
              icon={<Users className="h-4 w-4" />}
              previous={comparison.previous.tenants}
              current={comparison.current.tenants}
            />
            <ComparisonRow 
              label="Landlords"
              icon={<Building2 className="h-4 w-4" />}
              previous={comparison.previous.landlords}
              current={comparison.current.landlords}
            />
            <ComparisonRow 
              label="Conversion Rate"
              icon={<Percent className="h-4 w-4" />}
              previous={comparison.previous.conversionRate}
              current={comparison.current.conversionRate}
              isPercentage
            />
          </div>
        </CardContent>
      </Card>

      {/* Agent Leaderboard */}
      <AgentLeaderboard />
      </div>
    </div>
  );
}

export default AgentRegistrationAnalytics;
