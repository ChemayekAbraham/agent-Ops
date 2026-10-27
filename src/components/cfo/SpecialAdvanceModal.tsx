import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CalendarDays, CheckCircle2, Globe, Loader2, Lock, Sparkles, User } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { UserSearchPicker, type UserResult } from '@/components/cfo/UserSearchPicker';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { kampalaLabel, kampalaTodayYmd } from '@/lib/kampalaDays';
import {
  RATE_BASIS_LABEL, RATE_MAX_BY_BASIS, RATE_MAX_PERCENT, SPECIAL_ADVANCE_FREQUENCIES, SPECIAL_ADVANCE_RATE_PRESETS, SPECIAL_ADVANCE_TERMS,
  TERM_MAX_DAYS, TERM_MIN_DAYS, previewSpecialAdvance, rateLabel, type RateBasis, type SpecialAdvanceFrequency,
} from '@/lib/specialAdvancePreview';
import {
  PURPOSE_MAX, PURPOSE_MIN, buildCreateRequest, buildRequest, describeSpecialAdvanceError, eligibilityText, fieldText,
  newIdempotencyKey, type BorrowerRequest, type TermsRequest,
} from '@/lib/specialAdvances';
import { useCreateSpecialAdvance, useSpecialAdvanceQuote } from '@/hooks/useSpecialAdvances';
import { cn } from '@/lib/utils';

const CUSTOM = 'custom';

/** Debounced copy of a value (keeps the server quote from firing on every keystroke). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface ShownRow { number: number; dueYmd: string; amount: number; accessFee: number; registrationFee: number; principal: number; balanceAfter: number }

/**
 * Special Advances — record an agreement.
 *
 * The CFO picks the borrower's agreed rate (1%/day, 15%/month, 28%/month or a custom rate with an explicit basis) and
 * term (7/14/30 days or custom); nothing is pre-selected. The schedule shown is the SERVER's (`special_advance_quote`);
 * the local preview (src/lib/specialAdvancePreview.ts, identical arithmetic) only fills in while the quote loads.
 * Eligibility also comes from the server. Recording (`special_advance_create`) needs the server's issuance flag on, an
 * eligible borrower, a purpose and the CFO's explicit confirmation of the server total; it creates a PENDING agreement
 * — approval and payout are separate steps. Nothing here moves money.
 */
export function SpecialAdvanceModal({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [borrowerType, setBorrowerType] = useState<'welile' | 'external'>('welile');
  const [welileUser, setWelileUser] = useState<UserResult | null>(null);
  const [externalKind, setExternalKind] = useState<'individual' | 'entity'>('individual');
  const [externalName, setExternalName] = useState('');
  const [externalPhone, setExternalPhone] = useState('');
  const [externalNin, setExternalNin] = useState('');
  const [externalReg, setExternalReg] = useState('');
  const [externalOrg, setExternalOrg] = useState('');
  const [amount, setAmount] = useState('');
  const [ratePreset, setRatePreset] = useState<string | null>(null);
  const [customBasis, setCustomBasis] = useState<RateBasis | null>(null);
  const [customRate, setCustomRate] = useState('');
  const [frequency, setFrequency] = useState<SpecialAdvanceFrequency>('daily');
  const [termPreset, setTermPreset] = useState<string | null>(null);
  const [customTerm, setCustomTerm] = useState('');
  const [purpose, setPurpose] = useState('');
  const [plannedDate, setPlannedDate] = useState('');
  const [confirmedTotal, setConfirmedTotal] = useState<number | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const idempotencyKey = useRef(newIdempotencyKey());
  const create = useCreateSpecialAdvance();

  useEffect(() => {
    if (open) return;
    setBorrowerType('welile');
    setWelileUser(null);
    setExternalKind('individual');
    setExternalName('');
    setExternalPhone('');
    setExternalNin('');
    setExternalReg('');
    setExternalOrg('');
    setAmount('');
    setRatePreset(null);
    setCustomBasis(null);
    setCustomRate('');
    setFrequency('daily');
    setTermPreset(null);
    setCustomTerm('');
    setPurpose('');
    setPlannedDate('');
    setConfirmedTotal(null);
    setSubmitError(null);
    idempotencyKey.current = newIdempotencyKey();
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

  const todayYmd = kampalaTodayYmd();
  const issueYmd = plannedDate && plannedDate >= todayYmd ? plannedDate : todayYmd;

  const ratePercent = rate?.ratePercent ?? null;
  const rateBasis = rate?.basis ?? null;
  const preview = useMemo(
    () => (principal > 0 && ratePercent !== null && rateBasis && termDays
      ? previewSpecialAdvance({ principal, ratePercent, rateBasis, termDays, frequency, issueYmd })
      : null),
    [principal, ratePercent, rateBasis, termDays, frequency, issueYmd],
  );

  const borrower: BorrowerRequest | null = borrowerType === 'welile'
    ? (welileUser?.id ? { kind: 'welile_user', user_id: welileUser.id } : null)
    : externalName.trim()
      ? { kind: 'external', borrower_type: externalKind, full_name: externalName.trim(), phone: externalPhone.trim(),
          national_id: externalKind === 'individual' ? externalNin.trim() || null : null,
          registration_number: externalKind === 'entity' ? externalReg.trim() || null : null,
          organization: externalOrg.trim() || null }
      : null;
  const terms: TermsRequest | null = preview && rateBasis && ratePercent !== null && termDays
    ? { principal, rate_percent: ratePercent, rate_basis: rateBasis, term_days: termDays, frequency }
    : null;
  const plannedPayoutDate = plannedDate && plannedDate >= todayYmd ? plannedDate : null;

  // Server quote: debounced, only once the terms are complete (the server is asked even without a borrower).
  const quoteRequest = useDebounced(terms ? buildRequest({ borrower, terms, plannedPayoutDate }) : null, 300);
  const quote = useSpecialAdvanceQuote(quoteRequest);
  const q = quote.data;
  const quoteIsCurrent = !!terms && JSON.stringify(quoteRequest) === JSON.stringify(buildRequest({ borrower, terms, plannedPayoutDate }));
  const server = quoteIsCurrent ? q?.schedule ?? null : null;
  const serverTotal = server?.total_repayable ?? null;
  const issuanceEnabled = q?.issuance_enabled ?? false;

  // Anything that changes the server total withdraws the CFO's confirmation.
  useEffect(() => { setConfirmedTotal((c) => (c !== null && c !== serverTotal ? null : c)); }, [serverTotal]);
  useEffect(() => { setSubmitError(null); }, [quoteRequest, purpose]);

  const shown: { source: 'server' | 'preview'; accessFee: number; registrationFee: number; totalRepayable: number; instalments: number;
    instalmentAmount: number; finalInstalmentAmount: number; firstDueYmd: string; finalDueYmd: string; rows: ShownRow[] } | null =
    server ? {
      source: 'server', accessFee: server.access_fee, registrationFee: server.registration_fee, totalRepayable: server.total_repayable,
      instalments: server.instalments, instalmentAmount: server.instalment_amount, finalInstalmentAmount: server.final_instalment_amount,
      firstDueYmd: server.first_due_date, finalDueYmd: server.final_due_date,
      rows: server.schedule.map((r) => ({ number: r.number, dueYmd: r.due_date, amount: r.amount, accessFee: r.access_fee,
        registrationFee: r.registration_fee, principal: r.principal, balanceAfter: r.balance_after })),
    } : preview ? {
      source: 'preview', accessFee: preview.accessFee, registrationFee: preview.registrationFee, totalRepayable: preview.totalRepayable,
      instalments: preview.instalments, instalmentAmount: preview.instalmentAmount, finalInstalmentAmount: preview.finalInstalmentAmount,
      firstDueYmd: preview.firstDueYmd, finalDueYmd: preview.finalDueYmd, rows: preview.schedule,
    } : null;

  const borrowerProblems = quoteIsCurrent && q ? [...q.borrower_errors.map((f) => `Check the ${fieldText(f)}.`), ...q.eligibility.map(eligibilityText)] : [];
  const purposeValid = purpose.trim().length >= PURPOSE_MIN && purpose.trim().length <= PURPOSE_MAX;
  const confirmed = serverTotal !== null && confirmedTotal === serverTotal;
  const blockers = [
    !quoteIsCurrent || quote.isFetching ? 'Waiting for the server calculation.' : null,
    quote.isError ? describeSpecialAdvanceError(quote.error) : null,
    q && quoteIsCurrent && !issuanceEnabled ? 'Special Advance issuance is switched off on the server.' : null,
    !borrower ? 'Choose the borrower.' : null,
    borrowerProblems.length ? 'The borrower cannot receive a Special Advance (see above).' : null,
    !purposeValid ? `Describe the purpose (${PURPOSE_MIN}–${PURPOSE_MAX} characters).` : null,
    !confirmed ? 'Confirm the agreed terms and the server total.' : null,
  ].filter(Boolean) as string[];
  const canSubmit = !!server && blockers.length === 0 && !create.isPending;

  const submit = async () => {
    if (!canSubmit || !borrower || !terms || serverTotal === null) return;
    setSubmitError(null);
    try {
      const saved = await create.mutateAsync(buildCreateRequest({
        borrower, terms, purpose, plannedPayoutDate, confirmedTotal: serverTotal, idempotencyKey: idempotencyKey.current }));
      toast.success(`${saved.reference} recorded — pending approval`);
      idempotencyKey.current = newIdempotencyKey();
      onOpenChange(false);
    } catch (e) {
      setSubmitError(describeSpecialAdvanceError(e));
    }
  };

  const freqLabel = SPECIAL_ADVANCE_FREQUENCIES.find((f) => f.value === frequency)?.label ?? 'Daily';
  const missing = [
    principal > 0 ? null : 'principal',
    rate ? null : isCustomRate && !customBasis ? 'rate basis' : 'agreed rate',
    termDays ? null : 'term',
  ].filter(Boolean);
  const borrowerLabel = borrowerType === 'welile' ? welileUser?.full_name : externalName.trim();

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
            Record the borrower's agreed terms. The server calculates every figure; nothing is paid out from this screen.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-3">
            <div>
              <Label className="text-sm font-medium">Borrower Type</Label>
              <div className="mt-1.5 flex gap-2">
                <Chip id="borrower-type-welile" active={borrowerType === 'welile'} onClick={() => setBorrowerType('welile')}>
                  <User className="mr-1.5 h-3.5 w-3.5 inline" /> Welile User (Any Role)
                </Chip>
                <Chip id="borrower-type-external" active={borrowerType === 'external'} onClick={() => setBorrowerType('external')}>
                  <Globe className="mr-1.5 h-3.5 w-3.5 inline" /> External Borrower (Outside Welile)
                </Chip>
              </div>
            </div>

            {borrowerType === 'welile' ? (
              <div>
                <UserSearchPicker
                  label="Welile Account"
                  placeholder="Search any user by name or phone..."
                  selectedUser={welileUser}
                  onSelect={(u) => setWelileUser(u ?? null)}
                />
              </div>
            ) : (
              <div className="space-y-3 rounded-xl border border-dashed border-border p-3.5 bg-muted/20">
                <div className="flex gap-2" role="group" aria-label="External borrower kind">
                  <Chip id="external-kind-individual" active={externalKind === 'individual'} onClick={() => setExternalKind('individual')}>Individual</Chip>
                  <Chip id="external-kind-entity" active={externalKind === 'entity'} onClick={() => setExternalKind('entity')}>Company / entity</Chip>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <Label htmlFor="special-advance-external-name">Full Name *</Label>
                    <Input id="special-advance-external-name" className="mt-1" placeholder={externalKind === 'entity' ? 'e.g. Acme Supplies Ltd' : 'e.g. John Mukasa'}
                      value={externalName} onChange={(e) => setExternalName(e.target.value)} />
                  </div>
                  <div>
                    <Label htmlFor="special-advance-external-phone">Phone Number *</Label>
                    <Input id="special-advance-external-phone" className="mt-1" placeholder="e.g. 0772 123 456"
                      value={externalPhone} onChange={(e) => setExternalPhone(e.target.value)} />
                  </div>
                  {externalKind === 'individual' ? (
                    <div>
                      <Label htmlFor="special-advance-external-nin">National ID / NIN *</Label>
                      <Input id="special-advance-external-nin" className="mt-1" placeholder="e.g. CM900000000000"
                        value={externalNin} onChange={(e) => setExternalNin(e.target.value)} />
                    </div>
                  ) : (
                    <div>
                      <Label htmlFor="special-advance-external-reg">Company registration number *</Label>
                      <Input id="special-advance-external-reg" className="mt-1" placeholder="e.g. 80020001234567"
                        value={externalReg} onChange={(e) => setExternalReg(e.target.value)} />
                    </div>
                  )}
                  <div>
                    <Label htmlFor="special-advance-external-org">Organization / Note (Optional)</Label>
                    <Input id="special-advance-external-org" className="mt-1" placeholder="e.g. External Supplier / Contractor"
                      value={externalOrg} onChange={(e) => setExternalOrg(e.target.value)} />
                  </div>
                </div>
                <p className="text-[11px] text-muted-foreground flex items-center gap-1.5">
                  <Globe className="h-3.5 w-3.5 text-primary shrink-0" />
                  External borrower outside Welile. Paid out and repaid off-platform; every payment is recorded by the CFO with its reference.
                </p>
              </div>
            )}

            {borrower && quoteIsCurrent && quote.isFetching && (
              <p className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking eligibility...
              </p>
            )}
            {borrower && quoteIsCurrent && q && !quote.isFetching && (borrowerProblems.length ? (
              <div id="special-advance-gates" role="alert" className="space-y-1 rounded-xl border border-amber-500/40 bg-amber-500/10 p-3">
                {borrowerProblems.map((l) => (
                  <p key={l} className="flex gap-1.5 text-xs text-amber-700 dark:text-amber-400">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {l}
                  </p>
                ))}
              </div>
            ) : (
              <p className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-600">
                <CheckCircle2 className="h-3.5 w-3.5" /> No eligibility conditions raised
              </p>
            ))}
          </section>

          <section className="space-y-4">
            <div>
              <Label htmlFor="special-advance-principal">Principal (UGX)</Label>
              <Input
                id="special-advance-principal" inputMode="numeric" className="mt-1" placeholder="e.g. 500,000"
                value={amount ? Number(amount).toLocaleString() : ''}
                onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, '').slice(0, 12))}
              />
              {principal > 0 && principal < 10_000 && <p className="mt-1 text-[11px] text-destructive">The minimum principal is UGX 10,000.</p>}
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

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="special-advance-frequency">Repayment frequency</Label>
                <Select value={frequency} onValueChange={(v) => setFrequency(v as SpecialAdvanceFrequency)}>
                  <SelectTrigger id="special-advance-frequency" className="mt-1"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {SPECIAL_ADVANCE_FREQUENCIES.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="special-advance-planned-date">Planned payout date (optional)</Label>
                <Input id="special-advance-planned-date" type="date" className="mt-1" min={todayYmd} value={plannedDate}
                  onChange={(e) => setPlannedDate(e.target.value)} />
              </div>
            </div>
          </section>

          {shown ? (
            <section id="special-advance-preview" className="space-y-3 rounded-2xl border border-border bg-gradient-to-br from-muted/40 to-background p-4">
              <div id="special-advance-agreed-terms" className="flex flex-wrap gap-1.5 text-[11px]">
                {borrowerLabel && <Tag>Borrower: {borrowerLabel} ({borrowerType === 'external' ? 'External' : 'Welile'})</Tag>}
                <Tag>Rate {rateLabel(ratePercent ?? 0, rateBasis ?? 'monthly')}</Tag>
                <Tag>Basis {RATE_BASIS_LABEL[rateBasis ?? 'monthly']}</Tag>
                <Tag>Term {termDays} days</Tag>
                <Tag>{freqLabel} repayments</Tag>
              </div>
              <p id="special-advance-figures-source" className={cn('text-[11px] font-medium', shown.source === 'server' ? 'text-emerald-600' : 'text-muted-foreground')}>
                {shown.source === 'server'
                  ? 'Server calculation — these are the figures that will be recorded.'
                  : quote.isError ? 'Preview only — the server calculation is unavailable.' : 'Preview — waiting for the server calculation...'}
              </p>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Figure label="Principal" value={formatUGX(principal)} />
                <Figure label="Access fee" value={formatUGX(shown.accessFee)} />
                <Figure label="Registration fee" value={formatUGX(shown.registrationFee)} />
                <Figure label="Total repayable" value={formatUGX(shown.totalRepayable)} strong />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-background/70 px-3 py-2 text-xs">
                <span>
                  <span className="font-semibold">{shown.instalments}</span> {freqLabel.toLowerCase()} instalment{shown.instalments === 1 ? '' : 's'} of{' '}
                  <span className="font-mono font-semibold">{formatUGX(shown.instalmentAmount)}</span>
                  {shown.finalInstalmentAmount !== shown.instalmentAmount && (
                    <> (last <span className="font-mono">{formatUGX(shown.finalInstalmentAmount)}</span>)</>
                  )}
                </span>
                <span className="inline-flex items-center gap-1 text-muted-foreground">
                  <CalendarDays className="h-3.5 w-3.5" /> {kampalaLabel(shown.firstDueYmd)} to {kampalaLabel(shown.finalDueYmd)}
                </span>
              </div>

              <div className="max-h-64 overflow-auto rounded-xl border border-border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-muted/80 text-[10px] uppercase tracking-wide text-muted-foreground backdrop-blur">
                    <tr>
                      <th className="px-2.5 py-2 text-left font-medium">#</th>
                      <th className="px-2.5 py-2 text-left font-medium">Due (if paid out {plannedPayoutDate ? 'as planned' : 'today'})</th>
                      <th className="px-2.5 py-2 text-right font-medium">Instalment</th>
                      <th className="hidden px-2.5 py-2 text-right font-medium sm:table-cell">Access fee</th>
                      <th className="hidden px-2.5 py-2 text-right font-medium sm:table-cell">Reg. fee</th>
                      <th className="hidden px-2.5 py-2 text-right font-medium sm:table-cell">Principal</th>
                      <th className="px-2.5 py-2 text-right font-medium">Balance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60 tabular-nums">
                    {shown.rows.map((s) => (
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
                The access fee is the agreed rate prorated by days ({rateBasis === 'monthly' ? 'monthly rate × days ÷ 30' : 'daily rate × days'}),
                never compounded. The term and due dates run from the day the advance is actually paid out; the amounts are fixed
                once the agreement is recorded.
              </p>
            </section>
          ) : (
            <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
              Choose the {missing.join(', ')} to see the repayment schedule.
            </p>
          )}

          {server && (
            <section id="special-advance-record" className="space-y-3 rounded-2xl border border-border p-4">
              <div>
                <Label htmlFor="special-advance-purpose">Purpose of the advance *</Label>
                <Textarea id="special-advance-purpose" className="mt-1" rows={2} maxLength={PURPOSE_MAX}
                  placeholder="e.g. Working capital for verified supplier stock" value={purpose} onChange={(e) => setPurpose(e.target.value)} />
              </div>
              <label htmlFor="special-advance-confirm" className="flex items-start gap-2 text-xs">
                <Checkbox id="special-advance-confirm" checked={confirmed} disabled={serverTotal === null}
                  onCheckedChange={(v) => setConfirmedTotal(v === true ? serverTotal : null)} />
                <span>
                  I confirm the borrower agreed these terms and a total repayable of{' '}
                  <span className="font-mono font-semibold">{formatUGX(serverTotal ?? 0)}</span> (server calculation).
                </span>
              </label>
              {blockers.length > 0 && (
                <ul id="special-advance-blockers" className="space-y-0.5 text-[11px] text-muted-foreground">
                  {blockers.map((b) => <li key={b}>• {b}</li>)}
                </ul>
              )}
              {submitError && <p role="alert" className="text-xs text-destructive">{submitError}</p>}
            </section>
          )}
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Lock className="h-3.5 w-3.5" />
            {q && !issuanceEnabled ? 'Issuance is switched off on the server — preview only.' : 'CFO authorization only. Recording creates a pending agreement; payout is a separate step.'}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
            {server && (
              <Button id="special-advance-submit" disabled={!canSubmit} onClick={() => void submit()}>
                {create.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Record Special Advance
              </Button>
            )}
          </div>
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
