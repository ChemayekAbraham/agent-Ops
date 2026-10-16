import { useState } from 'react';
import { Save, Loader2, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useLandlordFloatBudgetActions } from '@/hooks/useLandlordFloatBudget';
import { LANDLORD_FLOAT_MIN_REASON, landlordFloatErrorCode, landlordFloatErrorText, type LandlordFloatBudgetStatus } from '@/lib/landlordFloatBudget';
import { formatUGX } from '@/lib/rentCalculations';

export function budgetTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' }) : '—';
}

function PeriodBudgetForm({ periodType, status }: { periodType: 'daily' | 'weekly'; status: LandlordFloatBudgetStatus }) {
  const period = status[periodType];
  const daily = periodType === 'daily';
  const label = daily ? 'Daily' : 'Weekly';
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [serverRequiresReason, setServerRequiresReason] = useState(false);
  const [error, setError] = useState('');
  const { setBudget } = useLandlordFloatBudgetActions();
  const numericAmount = Number(amount.replaceAll(',', ''));
  const mismatch = amount.trim() !== '' && (daily
    ? status.weekly.amount !== null && numericAmount > Number(status.weekly.amount)
    : status.daily.amount !== null && numericAmount < Number(status.daily.amount));
  const requiresReason = mismatch || serverRequiresReason;
  const validAmount = amount.trim() !== '' && /^\d+(?:\.\d{1,2})?$/.test(amount.replaceAll(',', '')) && Number.isFinite(numericAmount) && numericAmount >= 0;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!validAmount || (requiresReason && reason.trim().length < LANDLORD_FLOAT_MIN_REASON) || !status.can_set_budget) return;
    setError('');
    try {
      await setBudget.mutateAsync({ periodType, amount: numericAmount, reason: reason.trim() || undefined });
      toast.success(`${label} landlord float budget saved`, { description: formatUGX(numericAmount) });
      setAmount('');
      setReason('');
      setServerRequiresReason(false);
    } catch (err) {
      if (landlordFloatErrorCode(err) === 'OVER_WEEKLY_REASON_REQUIRED') setServerRequiresReason(true);
      setError(landlordFloatErrorText(err));
    }
  }

  return <section className="min-w-0 space-y-4 border-b border-border py-5">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h2 className="text-lg font-semibold">{label} budget</h2>
      <span className="text-sm text-muted-foreground">{daily ? status.day : `${status.week_start} – ${status.week_end}`}</span>
    </div>
    <p className="text-2xl font-semibold tabular-nums break-words">{period.amount === null ? 'Not set' : formatUGX(period.amount)}</p>
    <dl className="grid grid-cols-3 gap-3 text-sm">
      {([['Used', period.used], ['Miscellaneous', period.misc_used], ['Remaining', period.remaining]] as const).map(([name, value]) => <div key={name} className="min-w-0"><dt className="text-muted-foreground">{name}</dt><dd className="mt-1 font-medium tabular-nums break-words">{value === null ? '—' : formatUGX(value)}</dd></div>)}
    </dl>
    <p className="text-xs text-muted-foreground break-words">Set by {period.set_by_name || '—'} · {budgetTimestamp(period.set_at)} (Kampala)</p>
    {status.can_set_budget && <form onSubmit={save} className="space-y-3">
      <div className="space-y-1.5"><Label htmlFor={`${periodType}-budget-amount`}>{label} amount (UGX)</Label><Input id={`${periodType}-budget-amount`} inputMode="decimal" placeholder={period.amount === null ? 'Enter amount' : Number(period.amount).toLocaleString('en-US')} value={amount} disabled={setBudget.isPending} onChange={e => { setAmount(e.target.value); setError(''); }} /></div>
      {requiresReason && <>
        <p className="flex items-start gap-2 text-sm text-warning" role="status"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{daily ? 'Daily budget exceeds this week’s budget.' : 'Weekly budget is below today’s daily budget.'} A reason is required.</p>
        <div className="space-y-1.5"><Label htmlFor={`${periodType}-budget-reason`}>Reason (at least 10 characters)</Label><Textarea id={`${periodType}-budget-reason`} value={reason} disabled={setBudget.isPending} onChange={e => setReason(e.target.value)} minLength={LANDLORD_FLOAT_MIN_REASON} required /><p className="text-xs text-muted-foreground">{reason.trim().length} / {LANDLORD_FLOAT_MIN_REASON} characters minimum</p></div>
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={setBudget.isPending || !validAmount || (requiresReason && reason.trim().length < LANDLORD_FLOAT_MIN_REASON)} className="gap-2">{setBudget.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Save {label.toLowerCase()} budget</Button>
    </form>}
  </section>;
}

export function LandlordFloatBudgetSetter({ status }: { status: LandlordFloatBudgetStatus }) {
  return <div className="grid gap-x-8 md:grid-cols-2"><PeriodBudgetForm periodType="daily" status={status} /><PeriodBudgetForm periodType="weekly" status={status} /></div>;
}