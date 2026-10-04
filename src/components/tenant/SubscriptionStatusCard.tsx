import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { CalendarCheck, AlertTriangle, Clock, ShieldCheck } from 'lucide-react';
import { motion } from 'framer-motion';

interface SubscriptionStatus {
  charges_completed: number;
  charges_remaining: number;
  next_charge_date: string;
  accumulated_debt: number;
  charge_amount: number;
  tenant_failed_at: string | null;
}

export function SubscriptionStatusCard({ userId }: { userId: string }) {
  const [sub, setSub] = useState<SubscriptionStatus | null>(null);

  useEffect(() => {
    const fetch = async () => {
      const { data } = await supabase
        .from('subscription_charges')
        .select('charges_completed, charges_remaining, next_charge_date, accumulated_debt, charge_amount, tenant_failed_at')
        .eq('tenant_id', userId)
        .eq('status', 'active')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) setSub(data);
    };
    fetch();
  }, [userId]);

  if (!sub) return null;

  const totalDays = sub.charges_completed + sub.charges_remaining;
  const progress = totalDays > 0 ? (sub.charges_completed / totalDays) * 100 : 0;
  const debt = Number(sub.accumulated_debt || 0);
  const nextDate = new Date(sub.next_charge_date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  nextDate.setHours(0, 0, 0, 0);
  const daysAhead = Math.max(0, Math.floor((nextDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24)));

  const hasDebt = debt > 0;
  const isPaidAhead = daysAhead > 0 && !hasDebt;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-2xl border-2 p-4 space-y-3 ${
        hasDebt
          ? 'border-destructive/40 bg-destructive/5'
          : isPaidAhead
          ? 'border-success/40 bg-success/5'
          : 'border-border bg-muted/30'
      }`}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {hasDebt ? (
            <AlertTriangle className="h-4 w-4 text-destructive" />
          ) : isPaidAhead ? (
            <ShieldCheck className="h-4 w-4 text-success" />
          ) : (
            <CalendarCheck className="h-4 w-4 text-primary" />
          )}
          <span className="text-sm font-semibold">
            {hasDebt ? 'Outstanding Debt' : isPaidAhead ? `${daysAhead} Day${daysAhead !== 1 ? 's' : ''} Ahead` : 'Daily Charges'}
          </span>
        </div>
        <span className="text-xs text-muted-foreground">
          {sub.charges_completed}/{totalDays} days
        </span>
      </div>

      {/* Progress bar */}
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.8, ease: 'easeOut' }}
          className={`h-full rounded-full ${
            hasDebt ? 'bg-destructive' : 'bg-success'
          }`}
        />
      </div>

      {/* Stats row */}
      <div className="flex items-center justify-between text-xs">
        {hasDebt ? (
          <span className="font-bold text-destructive">
            Debt: {formatUGX(debt)}
          </span>
        ) : isPaidAhead ? (
          <span className="font-medium text-success">
            Paid ahead ✓
          </span>
        ) : (
          <span className="text-muted-foreground">Up to date</span>
        )}
        <span className="flex items-center gap-1 text-muted-foreground">
          <Clock className="h-3 w-3" />
          Next: {new Date(sub.next_charge_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
        </span>
      </div>
    </motion.div>
  );
}
