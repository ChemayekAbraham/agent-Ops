import { useMemo } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { TrendingUp } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

interface SavingsGrowthChartProps {
  monthlyRent: number;
  monthsEnrolled: number;
  totalSavings: number;
}

const MONTHLY_GROWTH_RATE = 0.05;
const LANDLORD_FEE_RATE = 0.10;

export function SavingsGrowthChart({ 
  monthlyRent, 
  monthsEnrolled, 
  totalSavings 
}: SavingsGrowthChartProps) {
  const chartData = useMemo(() => {
    const data: { month: number; label: string; savings: number; projected: number }[] = [];
    const monthlyContribution = monthlyRent * LANDLORD_FEE_RATE;
    
    let actualBalance = 0;
    let projectedBalance = 0;
    
    // Generate data for each month enrolled + some future projection
    const totalMonths = Math.max(monthsEnrolled + 6, 12); // Show at least 12 months
    
    for (let i = 0; i <= totalMonths; i++) {
      // Calculate projected balance (compound interest model)
      projectedBalance = (projectedBalance * (1 + MONTHLY_GROWTH_RATE)) + monthlyContribution;
      
      // Actual balance (interpolate from current total)
      if (i <= monthsEnrolled) {
        actualBalance = (totalSavings / monthsEnrolled) * i;
      }
      
      const monthLabel = i === 0 ? 'Start' : `M${i}`;
      
      data.push({
        month: i,
        label: monthLabel,
        savings: i <= monthsEnrolled ? Math.round(actualBalance) : 0,
        projected: Math.round(projectedBalance),
      });
    }
    
    return data;
  }, [monthlyRent, monthsEnrolled, totalSavings]);

  const formatTooltipValue = (value: number) => formatUGX(value);
  
  const formatYAxis = (value: number) => {
    if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
    return value.toString();
  };

  return (
    <Card className="border-purple-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-purple-600" />
          Savings Growth
        </CardTitle>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="h-48 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
              <defs>
                <linearGradient id="savingsGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#22C55E" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#22C55E" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="projectedGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#9333EA" stopOpacity={0.2} />
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
                width={45}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'hsl(var(--background))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '8px',
                  fontSize: '12px',
                }}
                formatter={(value: number, name: string) => [
                  formatTooltipValue(value),
                  name === 'savings' ? 'Actual' : 'Projected'
                ]}
                labelFormatter={(label) => `Month: ${label}`}
              />
              <Area
                type="monotone"
                dataKey="projected"
                stroke="#9333EA"
                strokeWidth={2}
                strokeDasharray="4 4"
                fill="url(#projectedGradient)"
                dot={false}
              />
              <Area
                type="monotone"
                dataKey="savings"
                stroke="#22C55E"
                strokeWidth={2}
                fill="url(#savingsGradient)"
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        
        {/* Legend */}
        <div className="flex justify-center gap-4 mt-2">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 bg-emerald-500 rounded" />
            <span className="text-xs text-muted-foreground">Actual</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-0.5 bg-purple-600 rounded border-dashed" style={{ borderStyle: 'dashed' }} />
            <span className="text-xs text-muted-foreground">Projected</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
