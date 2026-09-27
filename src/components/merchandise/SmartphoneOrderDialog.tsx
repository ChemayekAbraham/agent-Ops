import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { Checkbox } from '@/components/ui/checkbox';
import { Smartphone, AlertTriangle, Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import smartphonePromoAsset from '@/assets/smartphone-promo.jpg.asset.json';
import { useSmartphoneCatalog, type SmartphoneOsType, type SmartphoneCatalogEntry } from '@/components/executive/agent-ops/SmartphoneCatalogDialog';
import { SMARTPHONE_PERIODS as PERIODS, smartphoneSchedule } from '@/lib/smartphoneAdvance';
import { downPaymentCopy } from '@/lib/moBanjaIphone';

const db = supabase as any;

interface Eligibility {
  user_id: string;
  rank: number | null;
  collected_30d: number;
  
  active_tenant_count?: number;
  required_active_tenants?: number;
  has_national_id: boolean;
  has_workplace_verification: boolean;
  has_open_application: boolean;
  eligible: boolean;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string;
}

/**
 * Agent Smartphone Advance application. Open to agents and sub-agents with at
 * least 3 active tenants on the Welile network. Every active catalog phone is selectable.
 * Every active, priced model is offered; Agent Ops assigns the supplier to the
 * order after submission. The applicant sees the daily
 * amount, the chosen period and the terms — never the internal programme charge.
 */
export default function SmartphoneOrderDialog({ open, onOpenChange, userId }: Props) {
  const queryClient = useQueryClient();
  const [osType, setOsType] = useState<SmartphoneOsType>('android');
  const [catalogId, setCatalogId] = useState('');
  const [months, setMonths] = useState<string>('');
  const [paymentMethod, setPaymentMethod] = useState<'full' | 'installments'>('installments');
  const [submitting, setSubmitting] = useState(false);
  const [docsReady, setDocsReady] = useState(false);

  const { data: eligibility, isLoading: eligLoading } = useQuery<Eligibility | null>({
    queryKey: ['smartphone-eligibility', userId],
    enabled: open,
    queryFn: async () => {
      const { data, error } = await db.rpc('get_agent_smartphone_eligibility', { p_user_id: null });
      if (error) throw error;
      return (data || null) as Eligibility | null;
    },
  });

  const { data: catalog = [], isLoading: catalogLoading } = useSmartphoneCatalog();

  const isIOSDevice = (c: SmartphoneCatalogEntry) =>
    c.os_type === 'ios' ||
    c.brand.trim().toLowerCase() === 'apple' ||
    c.brand.trim().toLowerCase().startsWith('iphone');

  const options = useMemo(
    () =>
      catalog
        .filter((c) => c.is_active && Number(c.default_amount || 0) > 0)
        .filter((c) => (osType === 'ios' ? isIOSDevice(c) : !isIOSDevice(c))),
    [catalog, osType],
  );


  const selected = options.find((c) => c.id === catalogId);
  const dpCopy = downPaymentCopy(selected?.brand ?? (osType === 'ios' ? 'Apple' : 'Android'), selected?.model_name);
  const price = Math.max(0, Math.round(Number(selected?.default_amount ?? 0)));
  const cashTopUp = Math.round(price / 2);
  const totalOnCollection = price + cashTopUp;

  useEffect(() => {
    setCatalogId('');
  }, [osType]);

  // Deductions begin 7 days after the phone is released, so the schedule the
  // applicant sees is anchored there too.
  const startDate = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  }, []);

  const period = months ? PERIODS.find((p) => String(p.months) === months) : undefined;
  const schedule = period ? smartphoneSchedule(price, period.months, startDate) : null;
  const totalRepayable = schedule?.total ?? 0;
  const dailyAmount = schedule?.daily ?? 0;
  const lastDaily = schedule?.dailyLast ?? 0;
  const scheduleDays = schedule?.days ?? 0;
  const scheduleRows = schedule?.schedule.rows ?? [];

  // Applications are open to every agent — only a duplicate open application
  // stops a submission. Portfolio and document checks are review inputs shown
  // to the Agent Ops manager, never a block here.
  const hasOpenApplication = !!eligibility?.has_open_application;
  const canSubmit =
    !hasOpenApplication && !!selected && price > 0 && docsReady && (paymentMethod === 'full' || !!period);

  const reset = () => {
    setOsType('android');
    setCatalogId('');
    setMonths('');
    setPaymentMethod('installments');
    setDocsReady(false);
  };

  const submit = async () => {
    if (!selected) {
      toast.error('Select a phone from the catalogue');
      return;
    }
    if (paymentMethod === 'installments' && !period) {
      toast.error('Choose a repayment period');
      return;
    }
    setSubmitting(true);
    const { error } =
      paymentMethod === 'full'
        ? await db.rpc('agent_order_smartphone_full', { p_catalog_id: selected.id })
        : await db.rpc('agent_order_smartphone', {
            p_catalog_id: selected.id,
            p_period_months: period!.months,
          });
    setSubmitting(false);
    if (error) {
      toast.error(error.message || 'Could not submit your application');
      return;
    }
    toast.success('Application submitted for Agent Ops review.');
    reset();
    onOpenChange(false);
    queryClient.invalidateQueries({ queryKey: ['smartphone-eligibility', userId] });
    queryClient.invalidateQueries({ queryKey: ['my-smartphone-orders', userId] });
    queryClient.invalidateQueries({ queryKey: ['my-merchandise-plans', userId] });
    queryClient.invalidateQueries({ queryKey: ['my-merchandise-deductions', userId] });
  };


  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <DialogContent className="max-w-sm max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" /> Smartphone advance
          </DialogTitle>
        </DialogHeader>

        <div className="w-full space-y-3">
            <img
              src={smartphonePromoAsset.url}
              alt="Welile smartphone selection"
              className="w-full h-36 object-cover rounded-lg border border-border"
            />

            {eligLoading ? (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading your profile…
              </p>
            ) : hasOpenApplication ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1">
                <p className="text-xs font-semibold flex items-center gap-1.5 text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" /> Application in progress
                </p>
                <p className="text-[11px] text-muted-foreground">
                  You already have a smartphone application under review. You can apply again once it is
                  decided.
                </p>
              </div>
            ) : null}

            <div className="space-y-2">
              <Label className="text-xs">Choose phone type</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={hasOpenApplication}
                  onClick={() => setOsType('android')}
                  className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                    osType === 'android'
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-card hover:bg-muted'
                  } disabled:opacity-50`}
                >
                  <Smartphone className="h-4 w-4" /> Android
                </button>
                <button
                  type="button"
                  disabled={hasOpenApplication}
                  onClick={() => setOsType('ios')}
                  className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                    osType === 'ios'
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-card hover:bg-muted'
                  } disabled:opacity-50`}
                >
                  <Smartphone className="h-4 w-4" /> iPhone
                </button>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Phone</Label>
              <Select
                value={options.some((o) => o.id === catalogId) ? catalogId : ''}
                onValueChange={setCatalogId}
                disabled={catalogLoading || hasOpenApplication || options.length === 0}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      catalogLoading
                        ? 'Loading phones…'
                        : options.length
                          ? 'Select a phone'
                          : `No ${osType === 'ios' ? 'iPhone' : 'Android'} phones available`
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {options.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.brand}{c.model_name ? ` · ${c.model_name}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {selected && price > 0 && (
              <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-2">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{dpCopy.amountLabelShort} Welile funds</span>
                  <span className="font-bold tabular-nums">{formatUGX(price)}</span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Cash you bring (50% of the down payment)</span>
                  <span className="font-bold tabular-nums text-primary">{formatUGX(Math.round(price / 2))}</span>
                </div>
                <p className="text-[11px] text-muted-foreground flex gap-1.5 pt-1 border-t border-border">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <span>
                    To qualify, come with an extra <span className="font-medium text-foreground">{formatUGX(Math.round(price / 2))}</span> in
                    cash — half of the down payment. Welile funds the down payment and your cash top-up
                    reduces what you repay overall.
                  </span>
                </p>
              </div>
            )}

            <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
              <p className="text-xs font-semibold">
                {dpCopy.partner ? `How the ${dpCopy.partner} iPhone works` : 'How this phone works'}
              </p>
              <p className="text-[11px] text-muted-foreground">{dpCopy.amountNote}</p>
              <ul className="space-y-1 text-[11px] text-muted-foreground">
                {dpCopy.twoLegs.map((line) => (
                  <li key={line} className="flex gap-1.5">
                    <span className="text-primary">•</span>
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
              {dpCopy.lockNotice && (
                <p className="text-[11px] text-muted-foreground flex gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <span>{dpCopy.lockNotice}</span>
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label className="text-xs">Payment method</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  disabled={hasOpenApplication}
                  onClick={() => setPaymentMethod('full')}
                  className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                    paymentMethod === 'full'
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-card hover:bg-muted'
                  } disabled:opacity-50`}
                >
                  Full payment
                </button>
                <button
                  type="button"
                  disabled={hasOpenApplication}
                  onClick={() => setPaymentMethod('installments')}
                  className={`rounded-xl border px-3 py-2.5 text-sm font-medium transition-colors ${
                    paymentMethod === 'installments'
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-card hover:bg-muted'
                  } disabled:opacity-50`}
                >
                  Installments
                </button>
              </div>
            </div>

            {paymentMethod === 'installments' && (
              <div className="space-y-1">
                <Label className="text-xs">Repayment period</Label>
                <Select value={months} onValueChange={setMonths} disabled={hasOpenApplication}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a period" />
                  </SelectTrigger>
                  <SelectContent>
                    {PERIODS.map((p) => (
                      <SelectItem key={p.months} value={String(p.months)}>
                        {p.months} month{p.months === 1 ? '' : 's'} ({p.days} days)
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3 text-sm">
              <h4 className="font-semibold">Terms &amp; Conditions</h4>
              <ol className="list-decimal pl-4 space-y-2 text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">Eligibility:</span> Open to active operational
                  agents with 3+ active tenants and a National ID recorded on their Welile profile.
                </li>
                <li>
                  <span className="font-medium text-foreground">Collection day:</span> you must present your
                  National ID and a workplace photo. Both are captured and verified before the phone is released
                  to you — no documents, no phone.
                </li>
                <li>
                  <span className="font-medium text-foreground">Supplier:</span> Welile pays the registered
                  supplier directly; you receive the phone, not cash.
                </li>
                <li>
                  <span className="font-medium text-foreground">Cash top-up:</span> you must bring an extra
                  50% of the down payment in cash on collection day. Welile funds the down payment; your cash
                  top-up reduces the overall repayment burden.
                </li>
                <li>
                  <span className="font-medium text-foreground">Repayment:</span> a daily amount is deducted
                  from your Welile Wallet over the period you choose (1 to 12 months). The amount
                  reduces every month as your balance comes down.
                </li>
                <li>
                  <span className="font-medium text-foreground">Deductions start:</span> 7 days after your
                  phone is released (grace period), then daily until cleared.
                </li>
                <li>
                  <span className="font-medium text-foreground">Late charge:</span> once you are 30 days behind
                  schedule, UGX 50,000 is added to your balance each month until you catch up.
                </li>
              </ol>
            </div>

            {paymentMethod === 'full' && price > 0 && (
              <div className="rounded-lg border border-border bg-muted/40 p-3 text-center space-y-1">
                <p className="text-xs text-muted-foreground">
                  {dpCopy.amountLabel} — due in full
                </p>
                <p className="text-2xl font-bold tabular-nums">{formatUGX(price)}</p>
                <p className="text-[11px] text-muted-foreground">
                  The full amount is collected from your Welile Wallet. No daily deductions.
                </p>
              </div>
            )}

            {paymentMethod === 'installments' && dailyAmount > 0 && (
              <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-2">
                <div className="text-center space-y-1">
                  <p className="text-xs text-muted-foreground">
                    Daily repayment to Welile — first month
                  </p>
                  <p className="text-2xl font-bold tabular-nums text-green-600">
                    {formatUGX(dailyAmount)}
                    <span className="text-sm font-medium text-green-600">/day</span>
                  </p>
                  <p className="text-[11px] font-bold text-muted-foreground">
                    Reduces to {formatUGX(lastDaily)}/day in your last month · {scheduleDays} days ·{' '}
                    {formatUGX(totalRepayable)} in total. Deductions start 7 days after your phone is
                    released.
                    {` This covers the Welile down payment only — you also repay ${
                      dpCopy.partner ?? 'the supplier'
                    } on their own plan, directly to them.`}
                  </p>
                </div>

                <div className="rounded-md border border-border bg-background/60 overflow-hidden">
                  <div className="grid grid-cols-3 gap-1 px-2 py-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                    <span>Month</span>
                    <span className="text-right">Amount</span>
                    <span className="text-right">Per day</span>
                  </div>
                  {scheduleRows.map((r) => (
                    <div
                      key={r.monthIndex}
                      className="grid grid-cols-3 gap-1 border-t border-border px-2 py-1.5 text-[11px] tabular-nums"
                    >
                      <span className="text-muted-foreground">Month {r.monthIndex}</span>
                      <span className="text-right font-medium">{formatUGX(r.totalDue)}</span>
                      <span className="text-right font-medium">{formatUGX(r.dailyDeduction)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3">
              <Checkbox
                id="docs-ready"
                checked={docsReady}
                onCheckedChange={(v) => setDocsReady(v === true)}
                disabled={hasOpenApplication}
                className="mt-0.5"
              />
              <Label htmlFor="docs-ready" className="text-[11px] leading-snug text-muted-foreground font-normal cursor-pointer">
                I confirm I will present my <span className="font-medium text-primary">National ID</span> and a{' '}
                <span className="font-medium text-primary">workplace photo</span> for verification on phone
                collection day. The phone is not released without them.
              </Label>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Your application is reviewed internally, then the supplier is paid directly.
              {paymentMethod === 'full'
                ? ' The full amount is collected from your Welile Wallet once your phone is released.'
                : ' Nothing is deducted from your wallet before your phone is released.'}
            </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting || !canSubmit}>
            {submitting ? 'Submitting…' : 'Submit application'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
