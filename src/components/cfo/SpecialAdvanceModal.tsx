import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, Globe, Loader2, Lock, Sparkles, User } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UserSearchPicker, type UserResult } from '@/components/cfo/UserSearchPicker';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { kampalaLabel, kampalaTodayYmd } from '@/lib/kampalaDays';
import {
  RATE_BASIS_LABEL, RATE_MAX_BY_BASIS, RATE_MAX_PERCENT, SPECIAL_ADVANCE_FREQUENCIES, SPECIAL_ADVANCE_RATE_PRESETS, SPECIAL_ADVANCE_TERMS,
  TERM_MAX_DAYS, TERM_MIN_DAYS, previewSpecialAdvance, rateLabel, type RateBasis, type SpecialAdvanceFrequency,
} from '@/lib/specialAdvancePreview';
import { cn } from '@/lib/utils';

interface Borrower {
  id?: string;
  full_name: string;
  phone: string;
  isExternal?: boolean;
  nin?: string;
  organization?: string;
}
interface Gates { labels: string[]; blocked: boolean }

const CUSTOM = 'custom';

/**
 * Special Advances — preview modal.
 *
 * PREVIEW ONLY: there is deliberately no issue/submit action. The CFO must pick the borrower's agreed rate (1%/day,
 * 15%/month, 28%/month or a custom rate with an explicit basis) and term (7/14/30 days or custom) — nothing is
 * pre-selected, so no rate is assumed. Figures come from src/lib/specialAdvancePreview.ts. The only server call is the
 * read-only `agent_advance_blocking_gates` eligibility check; the rate is not sent to it because the existing tier
 * rules do not govern an individually agreed Special Advance rate (exemption pending server-side).
 */
export function SpecialAdvanceModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [borrowerType, setBorrowerType] = useState<'welile' | 'external'>('welile');
  const [borrower, setBorrower] = useState<Borrower | null>(null);
  const [externalName, setExternalName] = useState('');
  const [externalPhone, setExternalPhone] = useState('');
  const [externalNin, setExternalNin] = useState('');
  const [externalOrg, setExternalOrg] = useState('');
  const [amount, setAmount] = useState('');
  const [ratePreset, setRatePreset] = useState<string | null>(null);
  const [customBasis, setCustomBasis] = useState<RateBasis | null>(null);
  const [customRate, setCustomRate] = useState('');
  const [frequency, setFrequency] = useState<SpecialAdvanceFrequency>('daily');
  const [termPreset, setTermPreset] = useState<string | null>(null);
  const [customTerm, setCustomTerm] = useState('');
  const [gates, setGates] = useState<Gates | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (open) return;
    setBorrowerType('welile');
    setBorrower(null);
    setExternalName('');
    setExternalPhone('');
    setExternalNin('');
    setExternalOrg('');
    setAmount('');
    setRatePreset(null);
    setCustomBasis(null);
    setCustomRate('');
    setFrequency('daily');
    setTermPreset(null);
    setCustomTerm('');
    setGates(null);
  }, [open]);

  const principal = Number(amount) || 0;

  const preset = SPECIAL_ADVANCE_RATE_PRESETS.find((p) => p.id === ratePreset);
  const isCustomRate = ratePreset === CUSTOM;
  const customRateNum = Number(customRate);
  // Same limits as the server (_special_advance_term_errors): > 0, at most 1% per day or 28% per month, 2 decimals.
  const customRateMax = customBasis ? RATE_MAX_BY_BASIS[customBasis] : RATE_MAX_PERCENT;
  const customRateValid = customRate.trim() !== '' && Number.isFinite(customRateNum) && customRateNum > 0
    && customRateNum <= customRateMax && /^\d+(\.\d{1,2})?$/.test(customRate.trim());
  const rate: { ratePercent: number; basis: RateBasis } | null = preset
    ? { ratePercent: preset.ratePercent, basis: preset.basis }
    : isCustomRate && customBasis && customRateValid ? { ratePercent: customRateNum, basis: customBasis } : null;

  const isCustomTerm = termPreset === CUSTOM;
  const customTermNum = Number(customTerm);
  const customTermValid = customTerm !== '' && Number.isInteger(customTermNum) && customTermNum >= TERM_MIN_DAYS && customTermNum <= TERM_MAX_DAYS;
  const termDays = termPreset && !isCustomTerm ? Number(termPreset) : isCustomTerm && customTermValid ? customTermNum : null;

  const issueYmd = kampalaTodayYmd();

  const ratePercent = rate?.ratePercent ?? null;
  const rateBasis = rate?.basis ?? null;
  const preview = useMemo(
    () => (principal > 0 && ratePercent !== null && rateBasis && termDays
      ? previewSpecialAdvance({ principal, ratePercent, rateBasis, termDays, frequency, issueYmd })
      : null),
    [principal, ratePercent, rateBasis, termDays, frequency, issueYmd],
  );

  // Read-only eligibility preview for registered Welile accounts. External borrowers bypass internal agent gates.
  useEffect(() => {
    if (!borrower || borrower.isExternal || !borrower.id) {
      setGates(null);
      return;
    }
    let live = true;
    const t = setTimeout(async () => {
      setChecking(true);
      try {
        const { data, error } = await supabase.rpc('agent_advance_blocking_gates' as never, {
          p_agent_id: borrower.id,
          p_principal: principal > 0 ? principal : null,
          p_monthly_rate: null,
        } as never);
        if (error) throw error;
        const g = (data ?? {}) as { labels?: string[]; blocked?: boolean };
        if (live) setGates({ labels: Array.isArray(g.labels) ? g.labels : [], blocked: !!g.blocked });
      } catch (e) {
        if (live) setGates({ labels: [e instanceof Error ? e.message : 'Eligibility check failed - treat as blocked.'], blocked: true });
      } finally {
        if (live) setChecking(false);
      }
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [borrower, principal]);

  const freqLabel = SPECIAL_ADVANCE_FREQUENCIES.find((f) => f.value === frequency)?.label ?? 'Daily';
  const missing = [
    principal > 0 ? null : 'principal',
    rate ? null : isCustomRate && !customBasis ? 'rate basis' : 'agreed rate',
    termDays ? null : 'term',
  ].filter(Boolean);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Sparkles className="h-4 w-4" />
            </span>
            Special Advance
          </DialogTitle>
          <DialogDescription>
            Repayment preview for the borrower's agreed terms. Nothing is issued from this screen.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-3">
            <div>
              <Label className="text-sm font-medium">Borrower Type</Label>
              <div className="mt-1.5 flex gap-2">
                <Chip
                  id="borrower-type-welile"
                  active={borrowerType === 'welile'}
                  onClick={() => {
                    setBorrowerType('welile');
                    setBorrower(null);
                  }}
                >
                  <User className="mr-1.5 h-3.5 w-3.5 inline" /> Welile User (Any Role)
                </Chip>
                <Chip
                  id="borrower-type-external"
                  active={borrowerType === 'external'}
                  onClick={() => {
                    setBorrowerType('external');
                    if (externalName.trim()) {
                      setBorrower({
                        full_name: externalName,
                        phone: externalPhone,
                        nin: externalNin,
                        organization: externalOrg,
                        isExternal: true,
                      });
                    } else {
                      setBorrower(null);
                    }
                  }}
                >
                  <Globe className="mr-1.5 h-3.5 w-3.5 inline" /> External Borrower (Outside Welile)
                </Chip>
              </div>
            </div>

            {borrowerType === 'welile' ? (
              <div>
                <UserSearchPicker
                  label="Welile Account"
                  placeholder="Search any user by name or phone..."
                  selectedUser={borrower && !borrower.isExternal && borrower.id ? (borrower as UserResult) : null}
                  onSelect={(u) => setBorrower(u ? { id: u.id, full_name: u.full_name, phone: u.phone, isExternal: false } : null)}
                />
                {borrower && !borrower.isExternal && checking && (
                  <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking eligibility...
                  </p>
                )}
                {borrower && !borrower.isExternal && !checking && gates && (gates.blocked ? (
                  <div id="special-advance-gates" className="mt-2 space-y-1 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
                    {gates.labels.map((l) => (
                      <p key={l} className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {l}
                      </p>
                    ))}
                  </div>
                ) : (
                  <p className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                    <CheckCircle2 className="h-3.5 w-3.5" /> No eligibility conditions raised
                  </p>
                ))}
              </div>
            ) : (
              <div className="space-y-3 rounded-xl border border-dashed border-border p-3.5 bg-muted/20">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="special-advance-external-name">Full Name *</Label>
                    <Input
                      id="special-advance-external-name"
                      className="mt-1"
                      placeholder="e.g. John Mukasa"
                      value={externalName}
                      onChange={(e) => {
                        const val = e.target.value;
                        setExternalName(val);
                        if (val.trim()) {
                          setBorrower({
                            full_name: val,
                            phone: externalPhone,
                            nin: externalNin,
                            organization: externalOrg,
                            isExternal: true,
                          });
                        } else {
                          setBorrower(null);
                        }
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor="special-advance-external-phone">Phone Number *</Label>
                    <Input
                      id="special-advance-external-phone"
                      className="mt-1"
                      placeholder="e.g. 0772 123 456"
                      value={externalPhone}
                      onChange={(e) => {
                        const val = e.target.value;
                        setExternalPhone(val);
                        if (externalName.trim()) {
                          setBorrower({
                            full_name: externalName,
                            phone: val,
                            nin: externalNin,
                            organization: externalOrg,
                            isExternal: true,
                          });
                        }
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor="special-advance-external-nin">National ID / NIN (Optional)</Label>
                    <Input
                      id="special-advance-external-nin"
                      className="mt-1"
                      placeholder="e.g. CM900000000000"
                      value={externalNin}
                      onChange={(e) => {
                        const val = e.target.value;
                        setExternalNin(val);
                        if (externalName.trim()) {
                          setBorrower((prev) => (prev ? { ...prev, nin: val } : null));
                        }
                      }}
                    />
                  </div>
                  <div>
                    <Label htmlFor="special-advance-external-org">Organization / Note (Optional)</Label>
                    <Input
                      id="special-advance-external-org"
                      className="mt-1"
                      placeholder="e.g. External Supplier / Contractor"
                      value={externalOrg}
                      onChange={(e) => {
                        const val = e.target.value;
                        setExternalOrg(val);
                        if (externalName.trim()) {
                          setBorrower((prev) => (prev ? { ...prev, organization: val } : null));
                        }
                      }}
                    />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                  <Globe className="h-3.5 w-3.5 text-primary shrink-0" />
                  External borrower outside Welile. Repayments tracked directly without in-app wallet sweeps.
                </p>
              </div>
            )}
          </section>

          <section className="space-y-4">
            <div>
              <Label htmlFor="special-advance-principal">Principal (UGX)</Label>
              <Input
                id="special-advance-principal" inputMode="numeric" className="mt-1" placeholder="e.g. 500,000"
                value={amount ? Number(amount).toLocaleString() : ''}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, '').slice(0, 12))}
              />
            </div>

            <fieldset>
              <legend className="text-sm font-medium">Agreed access fee rate</legend>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {SPECIAL_ADVANCE_RATE_PRESETS.map((p) => (
                  <Chip key={p.id} id={`special-advance-rate-${p.id}`} active={ratePreset === p.id} onClick={() => setRatePreset(p.id)}>
                    {rateLabel(p.ratePercent, p.basis)}
                  </Chip>
                ))}
                <Chip id="special-advance-rate-custom" active={isCustomRate} onClick={() => setRatePreset(CUSTOM)}>Custom rate</Chip>
              </div>
              {isCustomRate && (
                <div className="mt-3 grid grid-cols-2 gap-3 rounded-xl border border-dashed border-border p-3">
                  <div>
                    <span className="text-xs font-medium text-muted-foreground">Rate basis</span>
                    <div className="mt-1 flex gap-2" role="group" aria-label="Rate basis">
                      {(['daily', 'monthly'] as const).map((b) => (
                        <Chip key={b} id={`special-advance-basis-${b}`} active={customBasis === b} onClick={() => setCustomBasis(b)}>
                          {RATE_BASIS_LABEL[b].replace(/^per /, 'Per ')}
                        </Chip>
                      ))}
                    </div>
                  </div>
                  <div>
                    <Label htmlFor="special-advance-custom-rate" className="text-xs text-muted-foreground">Agreed rate (%)</Label>
                    <Input
                      id="special-advance-custom-rate" inputMode="decimal" className="mt-1" placeholder="e.g. 20"
                      value={customRate} onChange={(e) => setCustomRate(e.target.value.replace(/[^0-9.]/g, '').slice(0, 6))}
                    />
                  </div>
                  {!customBasis && <p className="col-span-2 text-[11px] text-amber-600">Choose whether the agreed rate is per day or per month.</p>}
                  {customRate !== '' && !customRateValid && (
                    <p className="col-span-2 text-[11px] text-destructive">
                      Enter a rate above 0 and up to {customRateMax}%{customBasis ? ` ${RATE_BASIS_LABEL[customBasis]}` : ''} (at most 2 decimals).
                    </p>
                  )}
                </div>
              )}
            </fieldset>

            <fieldset>
              <legend className="text-sm font-medium">Agreed term</legend>
              <div className="mt-1.5 flex flex-wrap gap-2">
                {SPECIAL_ADVANCE_TERMS.map((d) => (
                  <Chip key={d} id={`special-advance-term-${d}`} active={termPreset === String(d)} onClick={() => setTermPreset(String(d))}>
                    {d} days
                  </Chip>
                ))}
                <Chip id="special-advance-term-custom" active={isCustomTerm} onClick={() => setTermPreset(CUSTOM)}>Custom days</Chip>
              </div>
              {isCustomTerm && (
                <div className="mt-3 max-w-[12rem]">
                  <Label htmlFor="special-advance-custom-term" className="text-xs text-muted-foreground">Term (days)</Label>
                  <Input
                    id="special-advance-custom-term" inputMode="numeric" className="mt-1" placeholder="e.g. 21"
                    value={customTerm} onChange={(e) => setCustomTerm(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
                  />
                  {customTerm !== '' && !customTermValid && (
                    <p className="mt-1 text-[11px] text-destructive">Enter whole days between {TERM_MIN_DAYS} and {TERM_MAX_DAYS}.</p>
                  )}
                </div>
              )}
            </fieldset>

            <div className="max-w-[16rem]">
              <Label htmlFor="special-advance-frequency">Repayment frequency</Label>
              <Select value={frequency} onValueChange={(v) => setFrequency(v as SpecialAdvanceFrequency)}>
                <SelectTrigger id="special-advance-frequency" className="mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SPECIAL_ADVANCE_FREQUENCIES.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </section>

          {preview ? (
            <section id="special-advance-preview" className="space-y-3 rounded-2xl border border-border bg-gradient-to-br from-muted/40 to-background p-4">
              <div id="special-advance-agreed-terms" className="flex flex-wrap gap-1.5 text-[11px]">
                {borrower && (
                  <Tag>
                    Borrower: {borrower.full_name} ({borrower.isExternal ? 'External' : 'Welile'})
                  </Tag>
                )}
                <Tag>Rate {rateLabel(preview.ratePercent, preview.rateBasis)}</Tag>
                <Tag>Basis {RATE_BASIS_LABEL[preview.rateBasis]}</Tag>
                <Tag>Term {preview.termDays} days</Tag>
                <Tag>{freqLabel} repayments</Tag>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Figure label="Principal" value={formatUGX(preview.principal)} />
                <Figure label="Access fee" value={formatUGX(preview.accessFee)} />
                <Figure label="Registration fee" value={formatUGX(preview.registrationFee)} />
                <Figure label="Total repayable" value={formatUGX(preview.totalRepayable)} strong />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-background/70 px-3 py-2 text-xs">
                <span>
                  <span className="font-semibold">{preview.instalments}</span> {freqLabel.toLowerCase()} instalment{preview.instalments === 1 ? '' : 's'} of{' '}
                  <span className="font-mono font-semibold">{formatUGX(preview.instalmentAmount)}</span>
                  {preview.finalInstalmentAmount !== preview.instalmentAmount && (
                    <> (last <span className="font-mono">{formatUGX(preview.finalInstalmentAmount)}</span>)</>
                  )}
                </span>
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <CalendarDays className="h-3.5 w-3.5" /> {kampalaLabel(preview.firstDueYmd)} to {kampalaLabel(preview.finalDueYmd)}
                </span>
              </div>

              <div className="max-h-64 overflow-auto rounded-xl border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/80 text-[10px] uppercase tracking-wide text-muted-foreground backdrop-blur">
                    <tr>
                      <th className="px-2.5 py-2 text-left font-medium">#</th>
                      <th className="px-2.5 py-2 text-left font-medium">Due (indicative)</th>
                      <th className="px-2.5 py-2 text-right font-medium">Instalment</th>
                      <th className="hidden px-2.5 py-2 text-right font-medium sm:table-cell">Access fee</th>
                      <th className="hidden px-2.5 py-2 text-right font-medium sm:table-cell">Reg. fee</th>
                      <th className="hidden px-2.5 py-2 text-right font-medium sm:table-cell">Principal</th>
                      <th className="px-2.5 py-2 text-right font-medium">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60 tabular-nums">
                    {preview.schedule.map((s) => (
                      <tr key={s.number}>
                        <td className="px-2.5 py-1.5 text-muted-foreground">{s.number}</td>
                        <td className="whitespace-nowrap px-2.5 py-1.5">{kampalaLabel(s.dueYmd)}</td>
                        <td className="px-2.5 py-1.5 text-right font-medium">{formatUGX(s.amount)}</td>
                        <td className="hidden px-2.5 py-1.5 text-right text-muted-foreground sm:table-cell">{formatUGX(s.accessFee)}</td>
                        <td className="hidden px-2.5 py-1.5 text-right text-muted-foreground sm:table-cell">{formatUGX(s.registrationFee)}</td>
                        <td className="hidden px-2.5 py-1.5 text-right text-muted-foreground sm:table-cell">{formatUGX(s.principal)}</td>
                        <td className="px-2.5 py-1.5 text-right">{formatUGX(s.balanceAfter)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                The access fee is the agreed rate prorated by days ({preview.rateBasis === 'monthly' ? 'monthly rate × days ÷ 30' : 'daily rate × days'}),
                never compounded. Due dates and the fee/principal split are indicative: they assume issue today and every
                instalment paid in full and on time. The agreed terms are fixed once approved.
              </p>
            </section>
          ) : (
            <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
              Choose the {missing.join(', ')} to see the repayment preview.
            </p>
          )}
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Lock className="h-3.5 w-3.5" /> CFO authorization only. Issuing is not connected yet
          </span>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Chip({ id, active, onClick, children }: { id: string; active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button" id={id} aria-pressed={active} onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1.5 text-xs font-medium transition-all duration-150 active:scale-95',
        active
          ? 'border-primary bg-primary text-primary-foreground shadow-sm'
          : 'border-border bg-background text-foreground hover:border-primary/50 hover:bg-primary/5',
      )}
    >
      {children}
    </button>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary">{children}</span>;
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="rounded-xl bg-background/70 p-2.5">
      <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className={`mt-0.5 font-mono ${strong ? 'text-base font-bold text-primary' : 'text-sm font-semibold text-foreground'}`}>{value}</p>
    </div>
  );
}

export default SpecialAdvanceModal;
