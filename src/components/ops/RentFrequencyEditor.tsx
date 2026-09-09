/**
 * Tenant Ops → All Tenants → Tenant details → Payment frequency.
 *
 * Lets an authorised officer switch a tenant's rent plan between Daily and
 * Weekly. It writes nothing itself: the switch goes through the
 * `ops_set_rent_plan_frequency` RPC, and every figure shown here comes from the
 * shared schedule engine in `@/lib/agentMonitoringSchedule` — the same rules
 * Agent Monitoring and agent eligibility already use.
 */

import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { CalendarDays, CalendarIcon, CircleDot, Loader2, Pencil, Repeat2 } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { describePlanSchedule, type SchedulePlanInput } from '@/lib/agentMonitoringSchedule';

const fmtUGX = (v: unknown) => `UGX ${Number(v ?? 0).toLocaleString('en-UG')}`;

const toIso = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fromIso = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

/** Kampala "today" — the day every schedule position is measured against. */
const kampalaToday = () =>
  fromIso(
    new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala', dateStyle: 'short' })
      .format(new Date())
      .slice(0, 10),
  );

interface Props {
  activeRr: any;
  canEdit: boolean;
  onSaved: () => void;
}

export function RentFrequencyEditor({ activeRr, canEdit, onSaved }: Props) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>(
    String(activeRr?.repayment_frequency || 'daily').toLowerCase() === 'weekly' ? 'weekly' : 'daily',
  );
  const [startsOn, setStartsOn] = useState<Date | undefined>(
    activeRr?.repayment_starts_on ? fromIso(activeRr.repayment_starts_on) : undefined,
  );
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const today = useMemo(() => kampalaToday(), []);

  const plan: SchedulePlanInput = {
    daily_repayment: Number(activeRr?.daily_repayment ?? 0),
    total_repayment: Number(activeRr?.total_repayment ?? 0),
    amount_repaid: Number(activeRr?.amount_repaid ?? 0),
    repayment_frequency: activeRr?.repayment_frequency ?? null,
    repayment_starts_on: activeRr?.repayment_starts_on ?? null,
    created_at: activeRr?.created_at ?? new Date().toISOString(),
  };

  const current = useMemo(() => describePlanSchedule(plan, today), [
    plan.daily_repayment, plan.total_repayment, plan.amount_repaid,
    plan.repayment_frequency, plan.repayment_starts_on, plan.created_at, today,
  ]);

  // What the tenant's position becomes under the officer's pending choice.
  const preview = useMemo(
    () =>
      describePlanSchedule(
        {
          ...plan,
          repayment_frequency: frequency,
          repayment_starts_on: startsOn ? toIso(startsOn) : plan.repayment_starts_on,
        },
        today,
      ),
    [plan, frequency, startsOn, today],
  );

  const changed =
    frequency !== (current.weekly ? 'weekly' : 'daily') ||
    (!!startsOn && toIso(startsOn) !== (activeRr?.repayment_starts_on ?? null));

  const cancel = () => {
    setEditing(false);
    setFrequency(current.weekly ? 'weekly' : 'daily');
    setStartsOn(activeRr?.repayment_starts_on ? fromIso(activeRr.repayment_starts_on) : undefined);
    setReason('');
  };

  const save = async () => {
    if (!changed) {
      toast.error('Choose a different frequency or start date first');
      return;
    }
    if (reason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }
    setSaving(true);
    try {
      const { data, error } = await (supabase as any).rpc('ops_set_rent_plan_frequency', {
        p_rent_request_id: activeRr.id,
        p_frequency: frequency,
        p_starts_on: startsOn ? toIso(startsOn) : null,
        p_reason: reason.trim(),
      });
      if (error) throw error;
      const res: any = data ?? {};
      toast.success(
        `Switched to ${String(res.new_frequency ?? frequency)} — ${fmtUGX(res.instalment_amount)} per ${
          String(res.new_frequency ?? frequency) === 'weekly' ? 'week' : 'day'
        }`,
      );
      setEditing(false);
      setReason('');
      onSaved();
      // Every screen that reads a plan's schedule must pick the new frequency up.
      qc.invalidateQueries({
        predicate: (q) =>
          q.queryKey.some(
            (k) => typeof k === 'string' && /tenant|agent|rent|monitor|eligib|collect/i.test(k),
          ),
      });
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not change the payment frequency');
    } finally {
      setSaving(false);
    }
  };

  const PositionLine = ({ s }: { s: typeof current }) => (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
      <span className="text-muted-foreground">
        Due per {s.unit}: <span className="font-semibold text-foreground">{fmtUGX(s.periodAmount)}</span>
      </span>
      {s.arrears > 0 ? (
        <span className="font-medium text-red-600">
          Behind {fmtUGX(s.arrears)}
          {s.periodsBehind > 0 ? ` · ${s.periodsBehind} ${s.unit}${s.periodsBehind === 1 ? '' : 's'}` : ''}
        </span>
      ) : s.aheadAmount > 0 ? (
        <span className="font-medium text-green-600">
          Ahead {fmtUGX(s.aheadAmount)}
          {s.periodsAhead > 0 ? ` · ${s.periodsAhead} ${s.unit}${s.periodsAhead === 1 ? '' : 's'}` : ''}
        </span>
      ) : (
        <span className="font-medium text-green-600">Up to date</span>
      )}
      {s.weekly && s.nextDueDate && (
        <span className="text-muted-foreground">Next: {format(fromIso(s.nextDueDate), 'dd MMM yyyy')}</span>
      )}
    </div>
  );

  return (
    <div className="rounded-lg border bg-muted/30 p-2.5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={cn(
              'gap-1 text-[10px]',
              current.weekly
                ? 'border-amber-300 bg-amber-50 text-amber-700'
                : 'border-blue-300 bg-blue-50 text-blue-700',
            )}
          >
            {current.weekly ? <CalendarDays className="h-3 w-3" /> : <CircleDot className="h-3 w-3" />}
            {current.weekly ? 'Weekly' : 'Daily'}
          </Badge>
          <span className="text-xs font-medium">Payment frequency</span>
        </div>
        {canEdit && !editing && (
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" onClick={() => setEditing(true)}>
            <Pencil className="h-3 w-3" /> Change
          </Button>
        )}
      </div>

      <PositionLine s={current} />

      {editing && (
        <div className="space-y-2.5 rounded-md border bg-background p-2.5">
          <div className="space-y-1">
            <Label className="text-xs">New frequency</Label>
            <div className="grid grid-cols-2 gap-2">
              {(['daily', 'weekly'] as const).map((value) => (
                <Button
                  key={value}
                  type="button"
                  variant={frequency === value ? 'default' : 'outline'}
                  size="sm"
                  className="h-9 justify-center gap-1.5 text-xs capitalize"
                  onClick={() => setFrequency(value)}
                >
                  {value === 'weekly' ? <CalendarDays className="h-3.5 w-3.5" /> : <CircleDot className="h-3.5 w-3.5" />}
                  {value}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">
              {frequency === 'weekly' ? 'Weekly payment day (schedule anchor)' : 'Schedule start date'}
            </Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn('h-8 w-full justify-start text-left text-xs font-normal sm:w-[180px]', !startsOn && 'text-muted-foreground')}
                >
                  <CalendarIcon className="mr-1.5 h-3.5 w-3.5" />
                  {startsOn ? format(startsOn, 'dd MMM yyyy') : 'Keep current start'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={startsOn}
                  onSelect={(d) => setStartsOn(d ?? undefined)}
                  initialFocus
                  className={cn('p-3 pointer-events-auto')}
                />
              </PopoverContent>
            </Popover>
            <p className="text-[10px] text-muted-foreground">
              {frequency === 'weekly'
                ? 'A weekly plan is due on this weekday each week.'
                : 'A daily plan is due every day from this date.'}
            </p>
          </div>

          <div className="rounded-md border border-primary/30 bg-primary/5 p-2 space-y-1">
            <div className="flex items-center gap-1.5 text-[11px] font-medium">
              <Repeat2 className="h-3.5 w-3.5 text-primary" /> Position after the switch
            </div>
            <PositionLine s={preview} />
            <p className="text-[10px] text-muted-foreground">
              Payments already received ({fmtUGX(plan.amount_repaid)}) are kept and re-applied to the new schedule.
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Reason (min 10 chars)</Label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="text-sm"
              placeholder="Why is this tenant moving to a different payment frequency?"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" className="h-8 px-3 text-xs" onClick={save} disabled={saving || !changed}>
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Save frequency'}
            </Button>
            <Button size="sm" variant="ghost" className="h-8 px-3 text-xs" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
