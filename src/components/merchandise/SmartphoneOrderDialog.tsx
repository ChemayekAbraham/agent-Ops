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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Checkbox } from '@/components/ui/checkbox';
import { Smartphone, FileText, AlertTriangle, Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import smartphonePromoAsset from '@/assets/smartphone-promo.jpg.asset.json';
import { useSmartphoneCatalog, type SmartphoneOsType } from '@/components/executive/agent-ops/SmartphoneCatalogDialog';
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
  const [osType, setOsType] = useState<SmartphoneOsType>('android');
  const [catalogId, setCatalogId] = useState('');
  const [months, setMonths] = useState<string>('12');
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

  const cap = Number(eligibility?.max_amount || 0);

  const options = useMemo(
    () =>
      catalog
        .filter((c) => c.is_active && Number(c.default_amount || 0) > 0)
        .filter((c) => cap <= 0 || Number(c.default_amount) <= cap)
        .filter((c) => c.os_type === osType),
    [catalog, cap, osType],
  );

  const selected = options.find((c) => c.id === catalogId);
  const price = Math.max(0, Math.round(Number(selected?.default_amount ?? 0)));

  useEffect(() => {
    setCatalogId('');
  }, [osType]);

  const period = PERIODS.find((p) => String(p.months) === months) ?? PERIODS[PERIODS.length - 1];
  const schedule = smartphoneSchedule(price, period.months);
  const totalRepayable = schedule.total;
  const dailyAmount = schedule.daily;

  // Applications are open to every agent — only a duplicate open application
  // stops a submission. Portfolio and document checks are review inputs shown
  // to the Agent Ops manager, never a block here.
  const hasOpenApplication = !!eligibility?.has_open_application;
  const canSubmit = !hasOpenApplication && !!selected && price > 0 && docsReady;

  const reset = () => {
    setCatalogId('');
    setMonths('12');
    setDocsReady(false);
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
              <Select value={months} onValueChange={setMonths} disabled={hasOpenApplication}>
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

            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 p-3">
              <Checkbox
                id="docs-ready"
                checked={docsReady}
                onCheckedChange={(v) => setDocsReady(v === true)}
                disabled={hasOpenApplication}
                className="mt-0.5"
              />
              <Label htmlFor="docs-ready" className="text-[11px] leading-snug text-muted-foreground font-normal cursor-pointer">
                I confirm I will present my <span className="font-medium text-foreground">National ID</span> and a{' '}
                <span className="font-medium text-foreground">workplace photo</span> for verification on phone
                collection day. The phone is not released without them.
              </Label>
            </div>

            <p className="text-[11px] text-muted-foreground">
              Your application is reviewed internally, then the supplier is paid directly.
              Nothing is deducted from your wallet before your phone is released.
            </p>
          </TabsContent>

          <TabsContent value="tnc" className="mt-3">
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
