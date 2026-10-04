import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { TrendingUp, Zap } from 'lucide-react';

interface EarningPrediction {
  predicted_earnings: number;
  confidence: number;
  assumptions: Record<string, unknown>;
  created_at: string;
}

interface EarningBaseline {
  avg_weekly_earnings: number;
  receipt_count_7d: number;
  referral_count_7d: number;
}

export default function EarningPredictionCard() {
  const { user } = useAuth();
  const [prediction, setPrediction] = useState<EarningPrediction | null>(null);
  const [baseline, setBaseline] = useState<EarningBaseline | null>(null);

  useEffect(() => {
    if (!user) return;
    Promise.all([
      supabase
        .from('earning_predictions')
        .select('predicted_earnings, confidence, assumptions, created_at')
        .eq('user_id', user.id)
        .eq('period', 'weekly')
        .order('created_at', { ascending: false })
        .limit(1)
        .single(),
      supabase
        .from('earning_baselines')
        .select('avg_weekly_earnings, receipt_count_7d, referral_count_7d')
        .eq('user_id', user.id)
        .single(),
    ]).then(([predRes, baseRes]) => {
      if (predRes.data) setPrediction(predRes.data as EarningPrediction);
      if (baseRes.data) setBaseline(baseRes.data as EarningBaseline);
    });
  }, [user]);

  if (!prediction) return null;

  const formatUGX = (n: number) =>
    `UGX ${n.toLocaleString('en-UG')}`;

  const growth = baseline?.avg_weekly_earnings && baseline.avg_weekly_earnings > 0
    ? Math.round(((prediction.predicted_earnings - baseline.avg_weekly_earnings) / baseline.avg_weekly_earnings) * 100)
    : null;

  return (
    <div className="mx-4 mb-3 rounded-xl bg-gradient-to-r from-primary/10 to-primary/5 border border-primary/20 p-3">
      <div className="flex items-center gap-2 mb-1.5">
        <div className="h-6 w-6 rounded-full bg-primary/20 flex items-center justify-center">
          <TrendingUp className="h-3.5 w-3.5 text-primary" />
        </div>
        <span className="text-xs font-semibold text-primary">Your Earning Potential</span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-lg font-bold text-foreground">
          {formatUGX(prediction.predicted_earnings)}
        </span>
        <span className="text-xs text-muted-foreground">/week</span>
        {growth !== null && growth > 0 && (
          <span className="ml-auto flex items-center gap-0.5 text-xs font-medium text-primary">
            <Zap className="h-3 w-3" />
            +{growth}%
          </span>
        )}
      </div>
      <p className="text-[11px] text-muted-foreground mt-1">
        Based on {baseline?.receipt_count_7d || 0} receipts & {baseline?.referral_count_7d || 0} referrals this week
      </p>
    </div>
  );
}
