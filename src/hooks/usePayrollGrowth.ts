import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface PayrollGrowthSummary {
  currentBalance: number;
  accruedGrowth: number;
  dailyRate: number;
  activeRows: number;
}

/**
 * Returns a summary of the user's un-withdrawn payroll balances that are
 * accruing the daily 0.5% loyalty bonus. Returns null while loading or when
 * the user has no active payroll growth rows.
 */
export function usePayrollGrowth(userId: string | null | undefined) {
  const [data, setData] = useState<PayrollGrowthSummary | null>(null);

  useEffect(() => {
    if (!userId) { setData(null); return; }
    let cancelled = false;

    const load = async () => {
      const { data: rows, error } = await supabase
        .from('payroll_growth_balances')
        .select('current_balance, accrued_growth, daily_rate')
        .eq('user_id', userId)
        .eq('status', 'active');
      if (cancelled) return;
      if (error || !rows || rows.length === 0) { setData(null); return; }
      const summary = rows.reduce<PayrollGrowthSummary>((acc, r) => ({
        currentBalance: acc.currentBalance + Number(r.current_balance || 0),
        accruedGrowth: acc.accruedGrowth + Number(r.accrued_growth || 0),
        dailyRate: Number(r.daily_rate || 0.005),
        activeRows: acc.activeRows + 1,
      }), { currentBalance: 0, accruedGrowth: 0, dailyRate: 0.005, activeRows: 0 });
      setData(summary.currentBalance > 0 ? summary : null);
    };

    load();
    // refresh every 5 minutes — growth itself only posts daily
    const id = window.setInterval(load, 5 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [userId]);

  return data;
}