import * as React from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar, RefreshCw, CalendarClock, Sparkles } from 'lucide-react';

export type PayoutFrequency = 'daily' | 'weekly' | 'monthly' | 'interval';

export interface PayoutScheduleConfig {
  frequency: PayoutFrequency;
  dayOfMonth: number;
  dayOfWeek: number;
  intervalDays: number;
}

interface PayoutAutomationToggleProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  config: PayoutScheduleConfig;
  onConfigChange: (next: PayoutScheduleConfig) => void;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const FREQUENCIES: { value: PayoutFrequency; label: string; hint: string }[] = [
  { value: 'daily', label: 'Daily', hint: 'Pays out automatically every weekday (EAT).' },
  { value: 'weekly', label: 'Weekly', hint: 'Pays out once a week on the chosen weekday.' },
  { value: 'monthly', label: 'Monthly', hint: 'Pays out once a month on the chosen day.' },
  { value: 'interval', label: 'Every N days', hint: 'Pays out repeatedly after a fixed number of days.' },
];

export function describeSchedule(c: PayoutScheduleConfig): string {
  switch (c.frequency) {
    case 'daily':
      return 'Monday–Friday';
    case 'weekly':
      return `Every ${WEEKDAYS[c.dayOfWeek] ?? 'Monday'}`;
    case 'interval':
      return `Every ${c.intervalDays} day${c.intervalDays === 1 ? '' : 's'}`;
    case 'monthly':
    default:
      return `Monthly on day ${c.dayOfMonth}`;
  }
}

export function PayoutAutomationToggle({ enabled, onToggle, config, onConfigChange }: PayoutAutomationToggleProps) {
  const update = (patch: Partial<PayoutScheduleConfig>) => onConfigChange({ ...config, ...patch });
  const activeHint = FREQUENCIES.find(f => f.value === config.frequency)?.hint;

  return (
    <div className={`rounded-2xl border transition-all ${
      enabled
        ? 'border-primary/30 bg-primary/[0.03] shadow-xs'
        : 'border-border/70 bg-muted/20 hover:border-border'
    } p-4 space-y-3.5`}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors ${
            enabled ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
          }`}>
            <RefreshCw className={`h-4 w-4 ${enabled ? 'text-primary' : ''}`} />
          </div>
          <div>
            <Label className="text-sm font-semibold cursor-pointer text-foreground block">
              Automate this payout (standing order)
            </Label>
            <p className="text-xs text-muted-foreground mt-0.5">
              Repeat this payout automatically on a recurring schedule with instant SMS notifications.
            </p>
          </div>
        </div>
        <Switch checked={enabled} onCheckedChange={onToggle} />
      </div>

      {enabled && (
        <div className="pt-3 border-t border-border/60 space-y-3.5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <CalendarClock className="h-4 w-4 text-primary shrink-0" />
              <Label className="text-xs font-medium text-foreground">Frequency:</Label>
              <Select value={config.frequency} onValueChange={(v) => update({ frequency: v as PayoutFrequency })}>
                <SelectTrigger className="w-36 h-8 text-xs font-medium rounded-lg">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FREQUENCIES.map(f => (
                    <SelectItem key={f.value} value={f.value} className="text-xs">{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {config.frequency === 'monthly' && (
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                <Label className="text-xs font-medium text-foreground">Day of month:</Label>
                <Select value={String(config.dayOfMonth)} onValueChange={(v) => update({ dayOfMonth: Number(v) })}>
                  <SelectTrigger className="w-24 h-8 text-xs font-medium rounded-lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 28 }, (_, i) => i + 1).map(d => (
                      <SelectItem key={d} value={String(d)} className="text-xs">{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {config.frequency === 'weekly' && (
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                <Label className="text-xs font-medium text-foreground">Day of week:</Label>
                <Select value={String(config.dayOfWeek)} onValueChange={(v) => update({ dayOfWeek: Number(v) })}>
                  <SelectTrigger className="w-36 h-8 text-xs font-medium rounded-lg">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WEEKDAYS.map((d, i) => (
                      <SelectItem key={d} value={String(i)} className="text-xs">{d}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {config.frequency === 'interval' && (
              <div className="flex items-center gap-2">
                <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
                <Label className="text-xs font-medium text-foreground">Every</Label>
                <Input
                  type="number"
                  min={1}
                  max={365}
                  value={config.intervalDays}
                  onChange={(e) => update({ intervalDays: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })}
                  className="w-16 h-8 text-xs text-center rounded-lg"
                />
                <span className="text-xs text-muted-foreground">day(s)</span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground bg-background/60 p-2.5 rounded-xl border border-border/40">
            <Sparkles className="h-3.5 w-3.5 text-primary shrink-0" />
            <span>Schedule: <strong className="text-foreground">{describeSchedule(config)}</strong></span>
            {activeHint && <span className="text-muted-foreground">· {activeHint}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
