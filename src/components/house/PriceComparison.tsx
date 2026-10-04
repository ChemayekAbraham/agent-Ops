import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { TrendingDown, TrendingUp, Minus } from 'lucide-react';

interface PriceComparisonProps {
  region: string;
  category: string;
  dailyRate: number;
  houseId: string;
}

export default function PriceComparison({ region, category, dailyRate, houseId }: PriceComparisonProps) {
  const [avgRate, setAvgRate] = useState<number | null>(null);

  useEffect(() => {
    async function fetchAvg() {
      const { data } = await supabase
        .from('house_listings')
        .select('daily_rate')
        .eq('region', region)
        .eq('house_category', category)
        .neq('id', houseId)
        .eq('status', 'available')
        .eq('verified', true);

      if (data && data.length >= 2) {
        const avg = data.reduce((s, r) => s + r.daily_rate, 0) / data.length;
        setAvgRate(avg);
      }
    }
    fetchAvg();
  }, [region, category, houseId]);

  if (avgRate === null) return null;

  const diff = ((dailyRate - avgRate) / avgRate) * 100;
  const isLower = diff < -3;
  const isHigher = diff > 3;

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium border ${
      isLower
        ? 'bg-success/10 border-success/20 text-success'
        : isHigher
        ? 'bg-destructive/10 border-destructive/20 text-destructive'
        : 'bg-muted/50 border-border/50 text-muted-foreground'
    }`}>
      {isLower ? (
        <TrendingDown className="h-4 w-4 shrink-0" />
      ) : isHigher ? (
        <TrendingUp className="h-4 w-4 shrink-0" />
      ) : (
        <Minus className="h-4 w-4 shrink-0" />
      )}
      <span>
        {isLower
          ? `${Math.abs(Math.round(diff))}% cheaper than avg ${formatUGX(avgRate)}/day in ${region}`
          : isHigher
          ? `${Math.round(diff)}% above avg ${formatUGX(avgRate)}/day in ${region}`
          : `Around average price for ${region}`
        }
      </span>
    </div>
  );
}
