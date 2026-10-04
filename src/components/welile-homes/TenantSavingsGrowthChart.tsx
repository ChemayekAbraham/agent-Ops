import { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendingUp, Target } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { Badge } from '@/components/ui/badge';

interface TenantSavingsGrowthChartProps {
  monthlyRent: number;
  monthsEnrolled: number;
  totalSavings: number;
  contributions?: Array<{ amount: number; created_at: string }>;
}

const MONTHLY_GROWTH_RATE = 0.05;
const LANDLORD_FEE_RATE = 0.10;

export function TenantSavingsGrowthChart({ 
  monthlyRent, 
  monthsEnrolled, 
  totalSavings,
  contributions = []
}: TenantSavingsGrowthChartProps) {
  const chartData = useMemo(() => {
    const data: { month: number; label: string; actual: number; projected: number }[] = [];
    const monthlyContribution = monthlyRent * LANDLORD_FEE_RATE;
    
    let projectedBalance = 0;
    
    // Show actual history + future projection up to 60 months or more
    const totalMonths = Math.max(monthsEnrolled + 12, 24);
    
    for (let i = 0; i <= totalMonths; i++) {
      // Calculate projected balance
      projectedBalance = (projectedBalance * (1 + MONTHLY_GROWTH_RATE)) + monthlyContribution;
      
      // Actual balance - interpolate for past months
      let actualBalance = 0;
      if (monthsEnrolled > 0 && i <= monthsEnrolled) {
        actualBalance = (totalSavings / monthsEnrolled) * i;
      }
      
      const monthLabel = i === 0 ? 'Start' : i <= 12 ? `M${i}` : `Y${Math.floor(i/12)}`;
      
      data.push({
        month: i,
        label: monthLabel,
        actual: i <= monthsEnrolled ? Math.round(actualBalance) : 0,
        projected: Math.round(projectedBalance),
      });
    }
    
    return data;
  }, [monthlyRent, monthsEnrolled, totalSavings]);

  // Calculate milestones for reference
  const milestones = useMemo(() => {
    const monthlyContribution = monthlyRent * LANDLORD_FEE_RATE;
    const getMilestone = (months: number) => {
      let balance = 0;
      for (let i = 0; i < months; i++) {
        balance = (balance * (1 + MONTHLY_GROWTH_RATE)) + monthlyContribution;
      }
      return Math.round(balance);
    };
    return {
      year1: getMilestone(12),
      year2: getMilestone(24),
      year5: getMilestone(60),
    };
  }, [monthlyRent]);

  const formatTooltipValue = (value: number) => formatUGX(value);
  
  const formatYAxis = (value: number) => {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
    return value.toString();
  };

  // Calculate current progress percentage
  const progressPercent = monthsEnrolled > 0 ? Math.round((monthsEnrolled / 60) * 100) : 0;

  return (
    <Card className="border-purple-200 overflow-hidden">
      <CardHeader className="pb-2 bg-gradient-to-r from-purple-50 to-white">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-purple-600" />
            Your Savings Growth
          </CardTitle>
          <Badge variant="outline" className="text-[10px] bg-purple-50 border-purple-200">
            {progressPercent}% to Goal
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-2 pb-4">
        <div className="h-52 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <defs>
                <linearGradient id="tenantActualGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22C55E" stopOpacity={0.4} />
                  <stop offset="95%" stopColor="#22C55E" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="tenantProjectedGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#9333EA" stopOpacity={0.15} />
                  <stop offset="95%" stopColor="#9333EA" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis 
                dataKey="label" 
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                interval="preserveStartEnd"
              />
              <YAxis 
                axisLine={false}
                tickLine={false}
                tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
                tickFormatter={formatYAxis}
                width={50}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--background))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                  fontSize: '12px',
                  boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
                }}
                formatter={(value: number, name: string) => [
                  formatTooltipValue(value),
                  name === 'actual' ? 'Your Savings' : 'Projected'
                ]}
                labelFormatter={(label) => `Month: ${label}`}
              />
              {/* Current position reference line */}
              {monthsEnrolled > 0 && (
                <ReferenceLine 
                  x={monthsEnrolled <= 12 ? `M${monthsEnrolled}` : `Y${Math.floor(monthsEnrolled/12)}`}
                  stroke="#9333EA"
                  strokeDasharray="3 3"
                  strokeWidth={1}
                />
              )}
              <Area
                type="monotone"
                dataKey="projected"
                stroke="#9333EA"
                strokeWidth={2}
                strokeDasharray="5 5"
                fill="url(#tenantProjectedGradient)"
                dot={false}
              />
              <Area
                type="monotone"
                dataKey="actual"
                stroke="#22C55E"
                strokeWidth={2.5}
                fill="url(#tenantActualGradient)"
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        
        {/* Legend & Milestones */}
        <div className="mt-3 space-y-3">
          {/* Legend */}
          <div className="flex justify-center gap-6">
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-1 bg-emerald-500 rounded" />
              <span className="text-xs text-muted-foreground">Your Savings</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-4 h-1 bg-purple-600 rounded opacity-60" style={{ backgroundImage: 'repeating-linear-gradient(90deg, #9333EA 0, #9333EA 4px, transparent 4px, transparent 8px)' }} />
              <span className="text-xs text-muted-foreground">Projected</span>
            </div>
          </div>
          
          {/* Milestone Summary */}
          <div className="grid grid-cols-3 gap-2">
            <div className="text-center p-2 bg-purple-50 rounded-lg">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Target className="h-3 w-3 text-purple-600" />
                <span className="text-[10px] font-medium text-purple-600">1 Year</span>
              </div>
              <p className="text-xs font-bold">{formatUGX(milestones.year1)}</p>
            </div>
            <div className="text-center p-2 bg-purple-50 rounded-lg">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Target className="h-3 w-3 text-purple-600" />
                <span className="text-[10px] font-medium text-purple-600">2 Years</span>
              </div>
              <p className="text-xs font-bold">{formatUGX(milestones.year2)}</p>
            </div>
            <div className="text-center p-2 bg-gradient-to-br from-purple-100 to-amber-50 rounded-lg border border-purple-200">
              <div className="flex items-center justify-center gap-1 mb-1">
                <Target className="h-3 w-3 text-purple-700" />
                <span className="text-[10px] font-medium text-purple-700">5 Years</span>
              </div>
              <p className="text-xs font-bold text-purple-800">{formatUGX(milestones.year5)}</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
