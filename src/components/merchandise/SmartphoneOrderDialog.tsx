import { useMemo, useState } from 'react';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Smartphone, FileText, ShieldCheck, AlertTriangle, Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import smartphonePromoAsset from '@/assets/smartphone-promo.jpg.asset.json';
import { useSmartphoneCatalog } from '@/components/executive/agent-ops/SmartphoneCatalogDialog';
import { SMARTPHONE_PERIODS as PERIODS, smartphoneSchedule } from '@/lib/smartphoneAdvance';

const db = supabase as any;

interface Eligibility {
  user_id: string;
  rank: number | null;
  collected_30d: number;
  max_amount: number;
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
 * least 3 active tenants on the Welile network, up to the programme ceiling.
 * Every active, priced model is offered; Agent Ops assigns the supplier to the
 * order after submission. The applicant sees the daily
 * amount, the chosen period and the terms — never the internal programme charge.
 */
export default function SmartphoneOrderDialog({ open, onOpenChange, userId }: Props) {
  const queryClient = useQueryClient();
  const [catalogId, setCatalogId] = useState('');
  const [months, setMonths] = useState<string>('12');
  const [submitting, setSubmitting] = useState(false);

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

  const cap = Number(eligibility?.max_amount || 0);

  const options = useMemo(
    () =>
      catalog
        .filter((c) => c.is_active && Number(c.default_amount || 0) > 0)
        .filter((c) => cap <= 0 || Number(c.default_amount) <= cap),
    [catalog, cap],
  );

  const selected = options.find((c) => c.id === catalogId);
  const price = Math.max(0, Math.round(Number(selected?.default_amount ?? 0)));
  const period = PERIODS.find((p) => String(p.months) === months) ?? PERIODS[PERIODS.length - 1];
  const schedule = smartphoneSchedule(price, period.months);
  const totalRepayable = schedule.total;
  const dailyAmount = schedule.daily;

  const canSubmit = !!eligibility?.eligible && !!selected && price > 0;

  const reset = () => {
    setCatalogId('');
    setMonths('12');
  };

  const submit = async () => {
    if (!selected) {
      toast.error('Select a phone from the catalogue');
      return;
    }
    setSubmitting(true);
    const { error } = await db.rpc('agent_order_smartphone', {
      p_catalog_id: selected.id,
      p_period_months: period.months,
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

  const activeTenants = Number(eligibility?.active_tenant_count || 0);
  const requiredTenants = Number(eligibility?.required_active_tenants || 3);
  const tenantShortfall = !!eligibility && !eligibility.eligible && !eligibility.has_open_application && activeTenants < requiredTenants;

  const blockers: string[] = [];
  if (eligibility) {
    if (eligibility.has_open_application) blockers.push('You already have an application in progress.');
    if (tenantShortfall) {
      blockers.push(
        `You need at least ${requiredTenants} active tenants to apply — you currently have ${activeTenants}.`,
      );
    } else if (!eligibility.eligible && !eligibility.has_open_application) {
      blockers.push('Eligibility is open to active agents and sub-agents on the Welile network.');
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!submitting) onOpenChange(o); }}>
      <DialogContent className="max-w-sm max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-primary" /> Smartphone advance
          </DialogTitle>
        </DialogHeader>

        <Tabs defaultValue="order" className="w-full">
          <TabsList className="w-full">
            <TabsTrigger value="order" className="flex-1">Apply</TabsTrigger>
            <TabsTrigger value="tnc" className="flex-1">
              <FileText className="h-3.5 w-3.5 mr-1.5" /> View T&amp;C
            </TabsTrigger>
          </TabsList>

          <TabsContent value="order" className="space-y-3 mt-3">
            <img
              src={smartphonePromoAsset.url}
              alt="Welile smartphone selection"
              className="w-full h-36 object-cover rounded-lg border border-border"
            />

            {eligLoading ? (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking your eligibility…
              </p>
            ) : eligibility?.eligible ? (
              <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-1">
                <p className="text-xs font-semibold flex items-center gap-1.5">
                  <ShieldCheck className="h-3.5 w-3.5 text-primary" /> You qualify
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Open to all active operational agents — phones up to{' '}
                  <span className="font-semibold text-foreground">{formatUGX(cap)}</span>.
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1">
                <p className="text-xs font-semibold flex items-center gap-1.5 text-destructive">
                  <AlertTriangle className="h-3.5 w-3.5" /> Not eligible yet
                </p>
                <ul className="list-disc pl-4 text-[11px] text-muted-foreground space-y-0.5">
                  {blockers.map((b) => <li key={b}>{b}</li>)}
                </ul>
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs">Phone</Label>
              <Select
                value={options.some((o) => o.id === catalogId) ? catalogId : ''}
                onValueChange={setCatalogId}
                disabled={catalogLoading || !eligibility?.eligible || options.length === 0}
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      catalogLoading
                        ? 'Loading phones…'
                        : options.length
                          ? 'Select a phone'
                          : 'No phones available for your limit'
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

            <div className="space-y-1">
              <Label className="text-xs">Repayment period</Label>
              <Select value={months} onValueChange={setMonths} disabled={!eligibility?.eligible}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a period" />
                </SelectTrigger>
                <SelectContent>
                  {PERIODS.map((p) => (
                    <SelectItem key={p.months} value={String(p.months)}>
                      {p.months} months ({p.days} days)
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {dailyAmount > 0 && (
              <div className="rounded-lg border border-border bg-muted/40 p-3 text-center space-y-1">
                <p className="text-xs text-muted-foreground">Daily repayment</p>
                <p className="text-2xl font-bold tabular-nums">
                  {formatUGX(dailyAmount)}
                  <span className="text-sm font-medium text-muted-foreground">/day</span>
                </p>
                <p className="text-[11px] text-muted-foreground">
                  {period.days} days · {formatUGX(totalRepayable)} in total. Deductions start 14 days after your
                  phone is released.
                </p>
              </div>
            )}

            <p className="text-[11px] text-muted-foreground">
              Your application is reviewed internally, then the supplier is paid directly.
              Nothing is deducted from your wallet before your phone is released. Your national ID and a
              workplace photo are captured on the day you collect the phone, not now.
            </p>
          </TabsContent>

          <TabsContent value="tnc" className="mt-3">
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3 text-sm">
              <h4 className="font-semibold">Terms &amp; Conditions</h4>
              <ol className="list-decimal pl-4 space-y-2 text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">Eligibility:</span> Open to all active
                  operational agents on the Welile network. No ID or workplace visit is needed to apply.
                </li>
                <li>
                  <span className="font-medium text-foreground">Collection day:</span> your national ID and a
                  workplace photo must be captured and verified before the phone is released to you.
                </li>
                <li>
                  <span className="font-medium text-foreground">Limit:</span> the phone price must be within the
                  programme ceiling of UGX 1,000,000.
                </li>
                <li>
                  <span className="font-medium text-foreground">Supplier:</span> Welile pays the registered
                  supplier directly; you receive the phone, not cash.
                </li>
                <li>
                  <span className="font-medium text-foreground">Repayment:</span> a fixed daily amount is
                  deducted from your Welile Wallet over the period you choose (3, 6, 9 or 12 months).
                </li>
                <li>
                  <span className="font-medium text-foreground">Grace period:</span> deductions begin 14 days
                  after the phone is released.
                </li>
                <li>
                  <span className="font-medium text-foreground">Late charge:</span> once you are 30 days behind
                  schedule, UGX 50,000 is added to your balance each month until you catch up.
                </li>
              </ol>
            </div>
          </TabsContent>
        </Tabs>

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
