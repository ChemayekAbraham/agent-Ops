import * as React from 'react';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Calendar, RefreshCw, CalendarClock } from 'lucide-react';

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
  { value: 'daily', label: 'Daily', hint: 'Pays out automatically every day.' },
  { value: 'weekly', label: 'Weekly', hint: 'Pays out once a week on the chosen weekday.' },
  { value: 'monthly', label: 'Monthly', hint: 'Pays out once a month on the chosen day.' },
  { value: 'interval', label: 'Every N days', hint: 'Pays out repeatedly after a fixed number of days.' },
];

export function describeSchedule(c: PayoutScheduleConfig): string {
  switch (c.frequency) {
    case 'daily':
      return 'Every day';
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
    <div className="rounded-lg border p-3 space-y-3 bg-muted/20">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <RefreshCw className="h-4 w-4 text-primary" />
          <Label className="text-xs font-semibold cursor-pointer">Automate this payout (standing order)</Label>
        </div>
        <Switch checked={enabled} onCheckedChange={onToggle} />
      </div>

      {enabled && (
        <div className="space-y-3 pl-6">
          <p className="text-[10px] text-muted-foreground">
            The system repeats this exact payout automatically, moving money from the company to the user's wallet.
            The receiver gets an SMS each time.
          </p>

          <div className="flex items-center gap-2">
            <CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />
            <Label className="text-xs">How often:</Label>
            <Select value={config.frequency} onValueChange={(v) => update({ frequency: v as PayoutFrequency })}>
              <SelectTrigger className="w-36 h-7 text-xs">
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
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <Label className="text-xs">Day of month:</Label>
              <Select value={String(config.dayOfMonth)} onValueChange={(v) => update({ dayOfMonth: Number(v) })}>
                <SelectTrigger className="w-20 h-7 text-xs">
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
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <Label className="text-xs">Day of week:</Label>
              <Select value={String(config.dayOfWeek)} onValueChange={(v) => update({ dayOfWeek: Number(v) })}>
                <SelectTrigger className="w-32 h-7 text-xs">
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
              <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
              <Label className="text-xs">Every</Label>
              <Input
                type="number"
                min={1}
                max={365}
                value={config.intervalDays}
                onChange={(e) => update({ intervalDays: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })}
                className="w-16 h-7 text-xs"
              />
              <span className="text-xs text-muted-foreground">day(s)</span>
            </div>
          )}

          {activeHint && <p className="text-[10px] text-muted-foreground italic">{activeHint}</p>}
          {config.frequency === 'monthly' && (
            <p className="text-[10px] text-muted-foreground italic">Max day is 28 to stay consistent across all months.</p>
          )}
        </div>
      )}
    </div>
  );
}
