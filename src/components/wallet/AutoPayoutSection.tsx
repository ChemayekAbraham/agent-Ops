import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Repeat, Loader2, Play, Pause, X, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { useAutoPayouts, type AutoPayoutFrequency } from '@/hooks/useAutoPayouts';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const fmt = (v: number) =>
  `UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(v || 0)}`;

interface AutoPayoutSectionProps {
  recipientId?: string;
  recipientName?: string;
  amount: string;
  description: string;
}

/**
 * Lets the sender turn the transfer they are composing into a repeating
 * payout, and manage the ones they already set up.
 *
 * Amounts above the approval cap are saved as "waiting for approval" and do
 * not send until a finance approver signs them off.
 */
export function AutoPayoutSection({
  recipientId,
  recipientName,
  amount,
  description,
}: AutoPayoutSectionProps) {
  const { schedules, cap, create, setState } = useAutoPayouts();
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState<AutoPayoutFrequency>('monthly');
  const [dayOfWeek, setDayOfWeek] = useState('1');
  const [dayOfMonth, setDayOfMonth] = useState('1');
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const amountNum = parseFloat(amount);
  const amountValid = !isNaN(amountNum) && amountNum > 0;
  const needsApproval = cap !== null && amountValid && amountNum > cap;

  const handleSave = async () => {
    if (!recipientId) {
      toast.error('Pick a recipient first');
      return;
    }
    if (!amountValid) {
      toast.error('Enter an amount greater than 0 UGX');
      return;
    }
    setSaving(true);
    try {
      await create({
        recipientId,
        amount: amountNum,
        frequency,
        dayOfWeek: Number(dayOfWeek),
        dayOfMonth: Number(dayOfMonth),
        description,
      });
      toast.success(
        needsApproval
          ? 'Saved. It will start sending once a finance approver signs it off.'
          : `Set up. ${fmt(amountNum)} will now go out ${frequency}.`,
      );
      setEnabled(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const changeState = async (id: string, state: 'active' | 'paused' | 'cancelled') => {
    setBusyId(id);
    try {
      await setState(id, state);
      toast.success(
        state === 'cancelled' ? 'Automatic transfer stopped' : state === 'paused' ? 'Paused' : 'Resumed',
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border border-border/60 bg-muted/30 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Label htmlFor="auto-payout" className="flex items-center gap-2">
            <Repeat className="h-3.5 w-3.5 text-muted-foreground" />
            Repeat this payment automatically
          </Label>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Send the same amount to {recipientName || 'this person'} on a schedule until you stop it.
          </p>
        </div>
        <Switch
          id="auto-payout"
          checked={enabled}
          onCheckedChange={setEnabled}
          aria-label="Repeat this payment automatically"
        />
      </div>

      {enabled && (
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">How often</Label>
              <Select value={frequency} onValueChange={(v) => setFrequency(v as AutoPayoutFrequency)}>
                <SelectTrigger className="h-11">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="daily">Every day</SelectItem>
                  <SelectItem value="weekly">Every week</SelectItem>
                  <SelectItem value="monthly">Every month</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {frequency === 'weekly' && (
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">Which day</Label>
                <Select value={dayOfWeek} onValueChange={setDayOfWeek}>
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DAYS.map((d, i) => (
                      <SelectItem key={d} value={String(i + 1)}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {frequency === 'monthly' && (
              <div className="space-y-1">
                <Label className="text-[11px] text-muted-foreground">Day of the month</Label>
                <Select value={dayOfMonth} onValueChange={setDayOfMonth}>
                  <SelectTrigger className="h-11">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {Array.from({ length: 28 }, (_, i) => String(i + 1)).map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>

          {needsApproval && (
            <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-500">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              Above the {fmt(cap as number)} automatic limit — it will be saved and wait for a finance
              approver before any money moves.
            </p>
          )}

          <Button
            type="button"
            onClick={handleSave}
            disabled={saving || !recipientId || !amountValid}
            className="h-11 w-full gap-2"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Repeat className="h-4 w-4" />}
            Save automatic payment
          </Button>
        </div>
      )}

      {schedules.length > 0 && (
        <div className="space-y-2 border-t border-border/60 pt-2">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Your automatic payments
          </p>
          {schedules.map((s) => (
            <div key={s.id} className="rounded-lg border border-border/60 bg-background/60 p-2.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-semibold">
                    {fmt(s.amount)} to {s.recipientName || 'Welile user'}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    {s.frequency === 'daily'
                      ? 'Every day'
                      : s.frequency === 'weekly'
                        ? `Every ${DAYS[(s.day_of_week || 1) - 1]}`
                        : `Every month on day ${s.day_of_month || 1}`}
                    {s.next_run_at && s.status === 'active'
                      ? ` · next ${new Date(s.next_run_at).toLocaleDateString()}`
                      : ''}
                  </p>
                  {s.last_error && s.status === 'paused' && (
                    <p className="mt-1 text-[11px] text-destructive">Stopped: {s.last_error}</p>
                  )}
                </div>
                <Badge
                  variant={
                    s.status === 'active' ? 'default' : s.status === 'paused' ? 'secondary' : 'outline'
                  }
                  className="shrink-0 text-[10px]"
                >
                  {s.status === 'pending_approval' ? 'Waiting for approval' : s.status}
                </Badge>
              </div>
              <div className="mt-2 flex gap-2">
                {s.status === 'active' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-9 flex-1 gap-1.5"
                    disabled={busyId === s.id}
                    onClick={() => changeState(s.id, 'paused')}
                  >
                    <Pause className="h-3.5 w-3.5" /> Pause
                  </Button>
                )}
                {s.status === 'paused' && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-9 flex-1 gap-1.5"
                    disabled={busyId === s.id}
                    onClick={() => changeState(s.id, 'active')}
                  >
                    <Play className="h-3.5 w-3.5" /> Resume
                  </Button>
                )}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-9 flex-1 gap-1.5 text-destructive"
                  disabled={busyId === s.id}
                  onClick={() => changeState(s.id, 'cancelled')}
                >
                  <X className="h-3.5 w-3.5" /> Stop
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
