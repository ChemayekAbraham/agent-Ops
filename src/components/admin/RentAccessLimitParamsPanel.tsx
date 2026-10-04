import { useEffect, useState } from 'react';
import { Loader2, Save, RotateCcw, Sliders } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useRentAccessLimitParams,
  DEFAULT_RENT_ACCESS_LIMIT_PARAMS,
} from '@/hooks/useRentAccessLimitParams';

const parseUgx = (raw: string) => Number(raw.replace(/[^0-9]/g, '')) || 0;
const fmtInput = (n: number) => (n > 0 ? n.toLocaleString('en-UG') : '');

export default function RentAccessLimitParamsPanel() {
  const { params, loading, refresh } = useRentAccessLimitParams();
  const { toast } = useToast();
  const [paid, setPaid] = useState('');
  const [missed, setMissed] = useState('');
  const [cap, setCap] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setPaid(fmtInput(params.paid_increment_ugx));
    setMissed(fmtInput(params.missed_decrement_ugx));
    setCap(fmtInput(params.max_limit_ugx));
  }, [params.paid_increment_ugx, params.missed_decrement_ugx, params.max_limit_ugx]);

  const paidN = parseUgx(paid);
  const missedN = parseUgx(missed);
  const capN = parseUgx(cap);

  const errors: string[] = [];
  if (paidN <= 0) errors.push('Paid-day bump must be greater than 0.');
  if (missedN < 0) errors.push('Missed-day drop cannot be negative.');
  if (capN < paidN) errors.push('Ceiling must be at least one paid-day bump.');
  if (capN > 1_000_000_000) errors.push('Ceiling looks too high (max 1B UGX).');

  const dirty =
    paidN !== params.paid_increment_ugx ||
    missedN !== params.missed_decrement_ugx ||
    capN !== params.max_limit_ugx;

  const handleSave = async () => {
    if (errors.length > 0) {
      toast({ title: 'Fix the errors first', description: errors[0], variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase
        .from('system_config')
        .update({
          value: {
            paid_increment_ugx: paidN,
            missed_decrement_ugx: missedN,
            max_limit_ugx: capN,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('key', 'rent_access_limit_params');
      if (error) throw error;
      toast({
        title: 'Rent access limit updated',
        description: `+${formatUGX(paidN)} / −${formatUGX(missedN)} · cap ${formatUGX(capN)}`,
      });
      await refresh();
    } catch (err: any) {
      toast({
        title: 'Could not save',
        description: err?.message || 'You may not have permission to update these settings.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = () => {
    setPaid(fmtInput(DEFAULT_RENT_ACCESS_LIMIT_PARAMS.paid_increment_ugx));
    setMissed(fmtInput(DEFAULT_RENT_ACCESS_LIMIT_PARAMS.missed_decrement_ugx));
    setCap(fmtInput(DEFAULT_RENT_ACCESS_LIMIT_PARAMS.max_limit_ugx));
  };

  // Preview: limit after 30 paid days, 0 missed
  const preview30Paid = Math.min(capN, 30 * paidN);

  return (
    <div className="rounded-2xl border border-border bg-card p-4 sm:p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
          <Sliders className="h-4.5 w-4.5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-foreground">Rent Access Limit Controls</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Drives every tenant's profile card. Changes take effect immediately for everyone.
          </p>
        </div>
        {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Field
          label="Paid-day bump (+UGX)"
          help="Added to a tenant's limit each on-time payment day"
          value={paid}
          onChange={(v) => setPaid(fmtInput(parseUgx(v)))}
          tone="success"
        />
        <Field
          label="Missed-day drop (−UGX)"
          help="Subtracted each day a tenant skips"
          value={missed}
          onChange={(v) => setMissed(fmtInput(parseUgx(v)))}
          tone="destructive"
        />
        <Field
          label="Ceiling (UGX)"
          help="Hard cap a tenant can ever reach"
          value={cap}
          onChange={(v) => setCap(fmtInput(parseUgx(v)))}
          tone="primary"
        />
      </div>

      <div className="rounded-xl bg-muted/40 border border-border/60 p-3 text-xs space-y-1">
        <p className="font-semibold text-foreground">Live preview</p>
        <p className="text-muted-foreground">
          Tenant who pays 30 days straight (no misses) would reach{' '}
          <span className="font-bold text-foreground">{formatUGX(preview30Paid)}</span>
          {preview30Paid >= capN && capN > 0 ? ' (hits ceiling)' : ''}.
        </p>
      </div>

      {errors.length > 0 && (
        <ul className="text-xs text-destructive space-y-0.5 list-disc list-inside">
          {errors.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}

      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={handleSave}
          disabled={!dirty || errors.length > 0 || saving}
          className="flex-1 h-10 font-bold"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Save className="h-4 w-4 mr-1.5" />}
          Save changes
        </Button>
        <Button type="button" variant="outline" onClick={handleReset} className="h-10" disabled={saving}>
          <RotateCcw className="h-4 w-4 mr-1.5" />
          Defaults
        </Button>
      </div>
    </div>
  );
}

function Field({
  label, help, value, onChange, tone,
}: {
  label: string; help: string; value: string;
  onChange: (v: string) => void;
  tone: 'success' | 'destructive' | 'primary';
}) {
  const toneClass =
    tone === 'success'
      ? 'border-success/40 focus-visible:ring-success/40'
      : tone === 'destructive'
      ? 'border-destructive/40 focus-visible:ring-destructive/40'
      : 'border-primary/40 focus-visible:ring-primary/40';
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <Input
        inputMode="numeric"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={`h-11 text-sm font-mono font-semibold ${toneClass}`}
      />
      <span className="text-[11px] text-muted-foreground block">{help}</span>
    </label>
  );
}
