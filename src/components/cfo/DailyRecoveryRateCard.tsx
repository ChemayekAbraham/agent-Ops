import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Percent } from 'lucide-react';
import { toast } from 'sonner';

/**
 * CFO control for the daily advance-recovery percentage.
 * The daily sweep recovers only this % of an agent's withdrawable commission
 * toward their outstanding advance; the rest stays withdrawable.
 * Stored as a fraction (10% -> 0.10) on advance_fee_config.daily_recovery_rate.
 */
export function DailyRecoveryRateCard() {
  const { user } = useAuth();
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);

  const { data: config, refetch } = useQuery({
    queryKey: ['advance-fee-config'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('advance_fee_config')
        .select('id, daily_recovery_rate')
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  const currentPct = config?.daily_recovery_rate != null
    ? Math.round(Number(config.daily_recovery_rate) * 100)
    : 10;

  const handleSave = async () => {
    const pct = Number(value);
    if (!Number.isFinite(pct) || pct < 1 || pct > 100) {
      toast.error('Enter a percentage between 1 and 100');
      return;
    }
    if (!config?.id) {
      toast.error('Advance config not found');
      return;
    }
    setSaving(true);
    try {
      const fraction = Math.round(pct) / 100;
      const { error } = await supabase
        .from('advance_fee_config')
        .update({ daily_recovery_rate: fraction, updated_by: user?.id })
        .eq('id', config.id);
      if (error) throw error;

      await supabase.from('audit_logs').insert({
        user_id: user?.id,
        action_type: 'cfo_advance_recovery_rate_update',
        table_name: 'advance_fee_config',
        record_id: config.id,
        metadata: {
          old_rate: config.daily_recovery_rate,
          new_rate: fraction,
          reason: `CFO set daily advance recovery rate to ${Math.round(pct)}% of agent withdrawable commission`,
        },
      });

      toast.success(`Daily recovery rate set to ${Math.round(pct)}%`);
      setValue('');
      refetch();
    } catch (e: any) {
      toast.error(e.message || 'Failed to save recovery rate');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="w-full rounded-xl border-border/80 shadow-2xs flex flex-col justify-between">
      <CardHeader className="pb-3 border-b border-border/50">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
            <Percent className="h-3.5 w-3.5" />
          </span>
          <div>
            <CardTitle className="text-sm font-semibold">Daily Recovery Rate</CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Automated daily sweep share of withdrawable commission
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="pt-4 flex-1 flex flex-col justify-between gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="rounded-lg border border-border/60 bg-muted/30 px-3.5 py-2 shrink-0">
            <Label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground block">
              Current rate
            </Label>
            <p className="text-2xl font-black tracking-tight tabular-nums text-primary leading-tight mt-0.5">
              {currentPct}%
            </p>
          </div>
          <div className="flex-1 space-y-1.5">
            <Label className="text-xs font-medium text-muted-foreground">New rate (%)</Label>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={1}
                max={100}
                placeholder={String(currentPct)}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="h-9 text-sm tabular-nums"
              />
              <Button onClick={handleSave} disabled={saving || !value} size="sm" className="h-9 px-4 shrink-0">
                {saving ? 'Saving...' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground leading-relaxed bg-muted/20 rounded-md px-2.5 py-1.5 border border-border/40">
          Each day the recovery job takes this % of an agent&apos;s withdrawable commission toward their
          outstanding advance; the rest stays withdrawable.
        </p>
      </CardContent>
    </Card>
  );
}
