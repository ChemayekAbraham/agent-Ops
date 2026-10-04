import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { format } from 'date-fns';
import { Calculator, Loader2, Percent, Save, Users, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import {
  useCloseServiceCentreReceivable,
  useServiceCentreReceivable,
  useSetServiceCentreReceivable,
  type SCDurationUnit,
  type SCReceivableMode,
} from '@/hooks/useServiceCentre360';

const UNITS: SCDurationUnit[] = ['days', 'months', 'years'];
const DAYS_PER_UNIT: Record<SCDurationUnit, number> = { days: 1, months: 30, years: 365 };

interface AgentLite {
  agent_id: string;
  agent_name: string;
}

interface Props {
  serviceCentreId: string;
  /** Agents attached to the centre — the people the daily charge is split across. */
  agents: AgentLite[];
  /** CFO-approved money put into the centre; seeds the principal. */
  approvedAmount?: number | null;
}

/**
 * Service Centre receivable: the money put into the centre, the charge on top of
 * it (mark-up % or a flat figure), the duration, the resulting daily amount, and
 * how that daily amount is split across the agents attached to the centre.
 *
 * Mark-up example: 10,000,000 at 30% → 13,000,000 repayable → 3,000,000 charge
 * → over 30 days → 100,000 per day → split 60/40 → 60,000 and 40,000 per day.
 */
export function ServiceCentreReceivablePanel({ serviceCentreId, agents, approvedAmount }: Props) {
  const { data, isLoading } = useServiceCentreReceivable(serviceCentreId);
  const save = useSetServiceCentreReceivable(serviceCentreId);
  const close = useCloseServiceCentreReceivable(serviceCentreId);

  const [mode, setMode] = useState<SCReceivableMode>('markup');
  const [principal, setPrincipal] = useState('');
  const [markup, setMarkup] = useState('33');
  const [flat, setFlat] = useState('');
  const [durationValue, setDurationValue] = useState('30');
  const [durationUnit, setDurationUnit] = useState<SCDurationUnit>('days');
  const [notes, setNotes] = useState('');
  const [shares, setShares] = useState<Record<string, string>>({});

  // Load the saved plan (or seed a sensible new one) once the data arrives.
  useEffect(() => {
    if (!data) return;
    const r = data.receivable;
    if (r) {
      setMode(r.mode);
      setPrincipal(String(Number(r.principal_amount) || ''));
      setMarkup(r.markup_percent != null ? String(Number(r.markup_percent)) : '33');
      setFlat(r.mode === 'flat' ? String(Number(r.recoverable_amount) || '') : '');
      setDurationValue(String(r.duration_value));
      setDurationUnit(r.duration_unit);
      setNotes(r.notes || '');
    } else if (approvedAmount != null) {
      setPrincipal(String(Number(approvedAmount) || ''));
    }
    const next: Record<string, string> = {};
    data.splits.forEach((s) => { next[s.agent_id] = String(Number(s.share_percent)); });
    setShares(next);
  }, [data, approvedAmount]);

  const num = (v: string) => {
    const n = Number(String(v).replace(/[^0-9.]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };

  const calc = useMemo(() => {
    const days = Math.max(1, num(durationValue) * DAYS_PER_UNIT[durationUnit]);
    const p = num(principal);
    const recoverable = mode === 'markup' ? Math.round(p * (num(markup) / 100)) : num(flat);
    const total = mode === 'markup' ? p + recoverable : p + recoverable;
    return { days, principal: p, recoverable, total, daily: recoverable > 0 ? recoverable / days : 0 };
  }, [mode, principal, markup, flat, durationValue, durationUnit]);

  const shareTotal = useMemo(
    () => agents.reduce((sum, a) => sum + num(shares[a.agent_id] ?? ''), 0),
    [agents, shares],
  );
  const shareEntries = agents.filter((a) => num(shares[a.agent_id] ?? '') > 0);
  const splitReady = shareEntries.length > 0 && Math.abs(shareTotal - 100) <= 0.5;

  const spreadEvenly = () => {
    if (agents.length === 0) return;
    const each = Math.round((100 / agents.length) * 100) / 100;
    const next: Record<string, string> = {};
    agents.forEach((a, i) => {
      next[a.agent_id] = String(i === agents.length - 1
        ? Math.round((100 - each * (agents.length - 1)) * 100) / 100
        : each);
    });
    setShares(next);
  };

  const onSave = () => {
    if (mode === 'markup' && calc.principal <= 0) return toast.error('Enter the amount put into the centre');
    if (mode === 'flat' && num(flat) <= 0) return toast.error('Enter the amount you are charging');
    if (calc.recoverable <= 0) return toast.error('The charge must be greater than zero');
    if (shareEntries.length > 0 && !splitReady) return toast.error('Agent shares must add up to 100%');

    save.mutate(
      {
        mode,
        principal: calc.principal,
        markupPercent: num(markup),
        flatAmount: mode === 'flat' ? num(flat) : null,
        durationValue: Math.max(1, num(durationValue)),
        durationUnit,
        notes: notes.trim() || null,
        splits: splitReady
          ? shareEntries.map((a) => ({ agent_id: a.agent_id, share_percent: num(shares[a.agent_id]) }))
          : null,
      },
      {
        onSuccess: () => toast.success('Receivable saved — it now shows in COO & CFO receivables'),
        onError: (e: any) => toast.error(friendly(e?.message)),
      },
    );
  };

  const onCancelPlan = () => {
    const r = data?.receivable;
    if (!r) return;
    const reason = window.prompt('Why is this receivable being cancelled? (min 10 characters)')?.trim();
    if (!reason || reason.length < 10) return toast.error('A reason of at least 10 characters is required');
    close.mutate({ receivableId: r.id, status: 'cancelled', reason }, {
      onSuccess: () => toast.success('Receivable cancelled'),
      onError: (e: any) => toast.error(friendly(e?.message)),
    });
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-10">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const live = data?.receivable ?? null;

  return (
    <div className="space-y-4">
      {live && (
        <div className="rounded-xl border bg-muted/30 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Badge variant="outline" className="border-0 bg-emerald-500/15 text-[10px] text-emerald-600">
              Active receivable
            </Badge>
            <span className="text-[11px] text-muted-foreground">
              {format(new Date(live.start_date), 'dd MMM yyyy')}
              {live.end_date ? ` → ${format(new Date(live.end_date), 'dd MMM yyyy')}` : ''}
              {live.created_by_name ? ` · set by ${live.created_by_name}` : ''}
            </span>
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-4">
            <Stat label="Put into centre" value={formatUGX(Number(live.principal_amount))} />
            <Stat label="Total repayable" value={formatUGX(Number(live.total_repayable))} />
            <Stat label="Charge (receivable)" value={formatUGX(Number(live.recoverable_amount))} tone="text-amber-600" />
            <Stat label="Per day" value={formatUGX(Number(live.daily_amount))} tone="text-primary" />
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Day {live.days_elapsed ?? 0} of {live.duration_days} · expected so far{' '}
            <span className="font-mono">{formatUGX(Number(live.expected_to_date ?? 0))}</span>
          </p>
        </div>
      )}

      {/* ── how the charge is worked out ── */}
      <div className="space-y-3 rounded-xl border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Calculator className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs font-semibold">How the charge is worked out</p>
          <div className="ml-auto flex gap-1">
            {(['markup', 'flat'] as SCReceivableMode[]).map((m) => (
              <Button
                key={m}
                type="button"
                size="sm"
                variant={mode === m ? 'default' : 'outline'}
                className="h-7 text-[11px]"
                onClick={() => setMode(m)}
              >
                {m === 'markup' ? 'Amount + %' : 'Flat figure'}
              </Button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Money put into the centre (UGX)">
            <Input inputMode="numeric" value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="10000000" />
          </Field>
          {mode === 'markup' ? (
            <Field label="Mark-up on top (%)">
              <div className="relative">
                <Input inputMode="decimal" value={markup} onChange={(e) => setMarkup(e.target.value)} placeholder="33" />
                <Percent className="absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              </div>
            </Field>
          ) : (
            <Field label="Amount you are charging (UGX)">
              <Input inputMode="numeric" value={flat} onChange={(e) => setFlat(e.target.value)} placeholder="3000000" />
            </Field>
          )}
          <Field label="Duration">
            <Input inputMode="numeric" value={durationValue} onChange={(e) => setDurationValue(e.target.value)} placeholder="30" />
          </Field>
          <Field label="Counted in">
            <div className="flex gap-1">
              {UNITS.map((u) => (
                <Button
                  key={u}
                  type="button"
                  size="sm"
                  variant={durationUnit === u ? 'default' : 'outline'}
                  className="h-9 flex-1 text-[11px] capitalize"
                  onClick={() => setDurationUnit(u)}
                >
                  {u}
                </Button>
              ))}
            </div>
          </Field>
        </div>

        <div className="grid gap-2 sm:grid-cols-4">
          <Stat label="Total repayable" value={formatUGX(calc.total)} />
          <Stat label="Charge (receivable)" value={formatUGX(calc.recoverable)} tone="text-amber-600" />
          <Stat label="Over" value={`${calc.days} day${calc.days === 1 ? '' : 's'}`} />
          <Stat label="Per day" value={formatUGX(Math.round(calc.daily))} tone="text-primary" />
        </div>

        <Field label="Note (optional)">
          <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What this covers…" />
        </Field>
      </div>

      {/* ── split across the attached agents ── */}
      <div className="space-y-3 rounded-xl border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <p className="text-xs font-semibold">Who pays the daily charge</p>
          <Button type="button" size="sm" variant="outline" className="ml-auto h-7 text-[11px]" onClick={spreadEvenly}>
            Split evenly
          </Button>
        </div>

        {agents.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            Attach agents to this centre first (Agents tab), then share the daily charge between them.
          </p>
        ) : (
          <>
            <div className="space-y-2">
              {agents.map((a) => {
                const pct = num(shares[a.agent_id] ?? '');
                return (
                  <div key={a.agent_id} className="flex items-center gap-2 rounded-lg bg-muted/40 p-2">
                    <span className="min-w-0 flex-1 truncate text-xs font-medium">{a.agent_name}</span>
                    <div className="relative w-20 shrink-0">
                      <Input
                        inputMode="decimal"
                        className="h-8 pr-5 text-right text-xs"
                        value={shares[a.agent_id] ?? ''}
                        onChange={(e) => setShares((s) => ({ ...s, [a.agent_id]: e.target.value }))}
                        placeholder="0"
                      />
                      <span className="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground">%</span>
                    </div>
                    <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums">
                      {formatUGX(Math.round((calc.daily * pct) / 100))}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className={cn('text-[11px]', Math.abs(shareTotal - 100) <= 0.5 ? 'text-emerald-600' : 'text-muted-foreground')}>
              Shares total {shareTotal.toFixed(2)}% {Math.abs(shareTotal - 100) <= 0.5 ? '· ready' : '· must reach 100% to save a split'}
            </p>
          </>
        )}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button onClick={onSave} disabled={save.isPending} className="flex-1">
          {save.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          {live ? 'Update receivable' : 'Create receivable'}
        </Button>
        {live && (
          <Button variant="outline" onClick={onCancelPlan} disabled={close.isPending} className="text-destructive">
            <XCircle className="mr-2 h-4 w-4" />
            Cancel plan
          </Button>
        )}
      </div>

      {!!data?.history?.length && (
        <div className="space-y-1">
          <p className="text-[11px] font-medium text-muted-foreground">Earlier plans</p>
          {data.history.map((h) => (
            <p key={h.id} className="text-[11px] text-muted-foreground">
              {format(new Date(h.created_at), 'dd MMM yyyy')} · {formatUGX(Number(h.recoverable_amount))} over{' '}
              {h.duration_days} days · {h.status}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function friendly(msg?: string) {
  if (!msg) return 'Could not save the receivable';
  if (msg.includes('not_authorized')) return 'You do not have permission to set service centre receivables';
  if (msg.includes('splits_must_total_100')) return 'Agent shares must add up to 100%';
  if (msg.includes('principal_required')) return 'Enter the amount put into the centre';
  if (msg.includes('flat_amount_required')) return 'Enter the amount you are charging';
  return msg;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-background/70 px-2 py-1.5">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={cn('font-mono text-xs font-bold tabular-nums', tone)}>{value}</p>
    </div>
  );
}
