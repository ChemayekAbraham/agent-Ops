import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CheckCircle2, Download, FileText, Handshake, Loader2, Pencil, Plus, Send, Trash2, Upload, Wallet, X } from 'lucide-react';
import { PARTNERSHIP_AGREEMENT_URL } from '@/lib/welileSchoolsAgreements';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import type { SchoolRow } from '@/lib/welileSchools';
import {
  MOBILE_MONEY_PROVIDERS, STATUS_LABEL, agreementUrl, deleteTerm, emptyTermDraft, fetchSchoolSetup, isAgentEditable,
  missingForSubmit, parseAmount, partnershipDraftErrors, partnershipErrorMessage, planDueDate, savePartnership, saveTerm,
  submitPartnership, termDraftErrors, termLengthDays, termToDraft, todayKampala, uploadAgreement,
  type FeeRow, type PartnershipDraft, type PartnershipRow, type PartnershipStatus, type TermDraft, type TermRow,
} from '@/lib/welileSchoolsPartnership';

const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-UG')}`;

const STATUS_TONE: Record<PartnershipStatus, string> = {
  draft: 'bg-muted text-foreground',
  submitted: 'bg-amber-100 text-amber-900 dark:bg-amber-900/30 dark:text-amber-200',
  changes_requested: 'bg-orange-100 text-orange-900 dark:bg-orange-900/30 dark:text-orange-200',
  approved: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-200',
  rejected: 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
  suspended: 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
};

function draftFrom(p: PartnershipRow | null): PartnershipDraft {
  return {
    bursar_name: p?.bursar_name ?? '',
    bursar_phone: p?.bursar_phone ?? '',
    payout_method: p?.payout_method ?? '',
    payout_provider: p?.payout_provider ?? '',
    payout_account_name: p?.payout_account_name ?? '',
    payout_account_number: p?.payout_account_number ?? '',
  };
}

function Field({ label, error, children, htmlFor }: { label: string; error?: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <Label htmlFor={htmlFor} className="text-sm">{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function Toggle<T extends string>({ options, value, onChange, disabled, label }: { options: { value: T; label: string }[]; value: T | ''; onChange: (v: T) => void; disabled?: boolean; label: string }) {
  return (
    <div className="flex flex-wrap gap-2" role="group" aria-label={label}>
      {options.map((o) => (
        <Button key={o.value} type="button" variant="outline" disabled={disabled} aria-pressed={value === o.value} onClick={() => onChange(o.value)}
          className={cn('min-h-[44px] rounded-xl px-3 text-sm', value === o.value ? 'border-primary bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground' : 'bg-card')}>
          {o.label}
        </Button>
      ))}
    </div>
  );
}

/** Agent-facing set-up of a school's Welile Schools partnership (PRD screens 1–2 and submit). */
export default function SchoolPartnershipPanel({ school }: { school: SchoolRow }) {
  const qc = useQueryClient();
  const queryKey = ['welile-school-setup', school.id];
  const { data, isLoading, error } = useQuery({ queryKey, queryFn: () => fetchSchoolSetup(school.id) });
  const partnership = data?.partnership ?? null;
  const terms = useMemo(() => data?.terms ?? [], [data]);
  const fees = useMemo(() => data?.fees ?? [], [data]);
  const editable = isAgentEditable(partnership?.status);
  const refresh = () => qc.invalidateQueries({ queryKey });

  const [submitting, setSubmitting] = useState(false);
  const missing = useMemo(() => missingForSubmit(partnership, terms, fees, todayKampala()), [partnership, terms, fees]);

  if (isLoading) return <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-primary" /></div>;
  if (error) return <Card className="p-4 text-sm text-destructive">Could not load this school's partnership: {partnershipErrorMessage(error)}</Card>;

  const submit = async () => {
    setSubmitting(true);
    try {
      await submitPartnership(school.id);
      toast.success('Sent to Welile ops for approval');
      refresh();
    } catch (e) {
      toast.error('Could not submit', { description: partnershipErrorMessage(e) });
    } finally {
      setSubmitting(false);
    }
  };

  const status = partnership?.status ?? 'draft';

  return (
    <div className="space-y-4">
      <Card className="space-y-2 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 font-semibold"><Handshake className="h-5 w-5 shrink-0 text-primary" />School partnership</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">Set this school up so families can apply for School Fees Plans.</p>
          </div>
          <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold', STATUS_TONE[status])}>{STATUS_LABEL[status]}</span>
        </div>
        {partnership?.review_note && (status === 'changes_requested' || status === 'rejected') && (
          <p className="rounded-xl bg-orange-50 p-3 text-sm text-orange-900 dark:bg-orange-900/20 dark:text-orange-100">
            <span className="font-semibold">Ops note: </span>{partnership.review_note}
          </p>
        )}
        {status === 'submitted' && <p className="text-sm text-muted-foreground">Ops is reviewing this school. You can edit again if they send it back.</p>}
        {status === 'approved' && <p className="text-sm text-muted-foreground">This school is a Welile Schools partner. If its terms or fees change, ask Welile ops to update them.</p>}
      </Card>

      <PartnershipDetailsCard school={school} partnership={partnership} editable={editable} onSaved={refresh} />
      <TermsCard schoolId={school.id} terms={terms} fees={fees} editable={editable} onSaved={refresh} />
      <AgreementCard school={school} partnership={partnership} editable={editable} onSaved={refresh} />

      {editable && (
        <Card className="space-y-3 p-4">
          {missing.length > 0 ? (
            <p className="text-sm text-muted-foreground"><span className="font-semibold text-foreground">Before submitting, add: </span>{missing.join(', ')}.</p>
          ) : (
            <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400"><CheckCircle2 className="h-4 w-4" />Everything ops needs is here.</p>
          )}
          <Button className="min-h-[48px] w-full gap-2" disabled={missing.length > 0 || submitting} onClick={submit}>
            {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            {status === 'changes_requested' ? 'Resubmit for approval' : 'Submit for approval'}
          </Button>
        </Card>
      )}
    </div>
  );
}

function PartnershipDetailsCard({ school, partnership, editable, onSaved }: { school: SchoolRow; partnership: PartnershipRow | null; editable: boolean; onSaved: () => void }) {
  const [draft, setDraft] = useState<PartnershipDraft>(() => draftFrom(partnership));
  const [saving, setSaving] = useState(false);
  useEffect(() => { setDraft(draftFrom(partnership)); }, [partnership]);
  const errors = partnershipDraftErrors(draft);
  const set = (patch: Partial<PartnershipDraft>) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftFrom(partnership));

  const save = async () => {
    if (Object.keys(errors).length) { toast.error('Check the highlighted fields'); return; }
    setSaving(true);
    try {
      await savePartnership(school.id, draft, null);
      toast.success('School details saved');
      onSaved();
    } catch (e) {
      toast.error('Could not save', { description: partnershipErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-4 p-4">
      <h3 className="flex items-center gap-2 font-semibold"><Wallet className="h-4 w-4 text-primary" />Bursar and payout account</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Bursar name" htmlFor="ws-bursar-name">
          <Input id="ws-bursar-name" value={draft.bursar_name} disabled={!editable} onChange={(e) => set({ bursar_name: e.target.value })} placeholder="Full name" />
        </Field>
        <Field label="Bursar phone" htmlFor="ws-bursar-phone" error={errors.bursar_phone}>
          <Input id="ws-bursar-phone" inputMode="tel" value={draft.bursar_phone} disabled={!editable} onChange={(e) => set({ bursar_phone: e.target.value })} placeholder="07XX XXX XXX" />
        </Field>
      </div>
      <Field label="Welile pays the school's fees into">
        <Toggle label="Payout method" disabled={!editable} value={draft.payout_method}
          options={[{ value: 'bank', label: 'Bank account' }, { value: 'mobile_money', label: 'Mobile money' }]}
          onChange={(v) => set({ payout_method: v, payout_provider: v === draft.payout_method ? draft.payout_provider : '' })} />
      </Field>
      {draft.payout_method === 'mobile_money' && (
        <Field label="Network">
          <Toggle label="Mobile money network" disabled={!editable} value={draft.payout_provider as (typeof MOBILE_MONEY_PROVIDERS)[number]}
            options={MOBILE_MONEY_PROVIDERS.map((p) => ({ value: p, label: p }))} onChange={(v) => set({ payout_provider: v })} />
        </Field>
      )}
      {draft.payout_method === 'bank' && (
        <Field label="Bank name" htmlFor="ws-bank-name">
          <Input id="ws-bank-name" value={draft.payout_provider} disabled={!editable} onChange={(e) => set({ payout_provider: e.target.value })} placeholder="e.g. Stanbic Bank" />
        </Field>
      )}
      {draft.payout_method && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Account name" htmlFor="ws-account-name">
            <Input id="ws-account-name" value={draft.payout_account_name} disabled={!editable} onChange={(e) => set({ payout_account_name: e.target.value })} placeholder="As registered" />
          </Field>
          <Field label={draft.payout_method === 'bank' ? 'Account number' : 'Mobile money number'} htmlFor="ws-account-number" error={errors.payout_account_number}>
            <Input id="ws-account-number" inputMode={draft.payout_method === 'bank' ? 'numeric' : 'tel'} value={draft.payout_account_number} disabled={!editable} onChange={(e) => set({ payout_account_number: e.target.value })} />
          </Field>
        </div>
      )}
      {editable && (
        <Button variant="outline" className="min-h-[44px] w-full" disabled={!dirty || saving} onClick={save}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save details
        </Button>
      )}
    </Card>
  );
}

function TermsCard({ schoolId, terms, fees, editable, onSaved }: { schoolId: string; terms: TermRow[]; fees: FeeRow[]; editable: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState<TermDraft | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const remove = async (term: TermRow) => {
    if (!window.confirm(`Delete ${term.name} and its fees?`)) return;
    setBusyId(term.id);
    try {
      await deleteTerm(term.id);
      toast.success(`${term.name} deleted`);
      onSaved();
    } catch (e) {
      toast.error('Could not delete', { description: partnershipErrorMessage(e) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Card className="space-y-3 p-4">
      <h3 className="flex items-center gap-2 font-semibold"><CalendarDays className="h-4 w-4 text-primary" />Terms and fees</h3>
      {terms.length === 0 && !editing && <p className="text-sm text-muted-foreground">No terms yet. Add the current or next term with its fee per class.</p>}
      {terms.map((t) => {
        const termFees = fees.filter((f) => f.term_id === t.id);
        if (editing?.id === t.id) return null;
        return (
          <div key={t.id} className="rounded-xl border border-border p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-medium">{t.name}</p>
                <p className="text-xs text-muted-foreground">{t.start_date} to {t.end_date} · plans due {t.plan_due_date}</p>
              </div>
              {editable && (
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="icon" className="h-10 w-10" aria-label={`Edit ${t.name}`} onClick={() => setEditing(termToDraft(t, fees))}><Pencil className="h-4 w-4" /></Button>
                  <Button variant="ghost" size="icon" className="h-10 w-10 text-destructive" aria-label={`Delete ${t.name}`} disabled={busyId === t.id} onClick={() => remove(t)}><Trash2 className="h-4 w-4" /></Button>
                </div>
              )}
            </div>
            <ul className="mt-2 space-y-1">
              {termFees.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="min-w-0 truncate">{f.class_name} <span className="text-muted-foreground">· {f.boarding_status === 'boarding' ? 'Boarding' : 'Day'}</span></span>
                  <span className="shrink-0 font-medium tabular-nums">{ugx(Number(f.amount))}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      {editing && <TermEditor schoolId={schoolId} initial={editing} onCancel={() => setEditing(null)} onSaved={() => { setEditing(null); onSaved(); }} />}
      {editable && !editing && (
        <Button variant="outline" className="min-h-[44px] w-full gap-2" onClick={() => setEditing(emptyTermDraft())}><Plus className="h-4 w-4" />Add a term</Button>
      )}
    </Card>
  );
}

function TermEditor({ schoolId, initial, onCancel, onSaved }: { schoolId: string; initial: TermDraft; onCancel: () => void; onSaved: () => void }) {
  const [t, setT] = useState<TermDraft>(initial);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const errors = termDraftErrors(t);
  const due = planDueDate(t.end_date);
  const days = termLengthDays(t.start_date, t.end_date);
  const setFee = (i: number, patch: Partial<TermDraft['fees'][number]>) =>
    setT((d) => ({ ...d, fees: d.fees.map((f, j) => (j === i ? { ...f, ...patch } : f)) }));

  const save = async () => {
    if (errors.length) { setShowErrors(true); return; }
    setSaving(true);
    try {
      await saveTerm(schoolId, t);
      toast.success(`${t.name.trim()} saved`);
      onSaved();
    } catch (e) {
      toast.error('Could not save the term', { description: partnershipErrorMessage(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-xl border-2 border-primary/40 p-3">
      <Field label="Term name" htmlFor="ws-term-name">
        <Input id="ws-term-name" value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} placeholder="e.g. Term 1 2027" />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts" htmlFor="ws-term-start"><Input id="ws-term-start" type="date" value={t.start_date} onChange={(e) => setT({ ...t, start_date: e.target.value })} /></Field>
        <Field label="Ends" htmlFor="ws-term-end"><Input id="ws-term-end" type="date" value={t.end_date} onChange={(e) => setT({ ...t, end_date: e.target.value })} /></Field>
      </div>
      {due && days != null && days >= 28 && (
        <p className="text-xs text-muted-foreground">{days} days. School Fees Plans for this term must be cleared by <span className="font-semibold text-foreground">{due}</span>, 2 weeks before it ends.</p>
      )}
      <div className="space-y-2">
        <Label className="text-sm">Fee per class for this term</Label>
        {t.fees.map((f, i) => (
          <div key={i} className="space-y-2 rounded-lg bg-muted/50 p-2">
            <div className="flex items-center gap-2">
              <Input aria-label={`Class ${i + 1}`} value={f.class_name} onChange={(e) => setFee(i, { class_name: e.target.value })} placeholder="Class, e.g. S1 or P5" className="flex-1" />
              {t.fees.length > 1 && (
                <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0" aria-label={`Remove fee ${i + 1}`} onClick={() => setT({ ...t, fees: t.fees.filter((_, j) => j !== i) })}><X className="h-4 w-4" /></Button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Toggle label={`Day or boarding, fee ${i + 1}`} value={f.boarding_status} onChange={(v) => setFee(i, { boarding_status: v })}
                options={[{ value: 'day', label: 'Day' }, { value: 'boarding', label: 'Boarding' }]} />
              <Input aria-label={`Amount for fee ${i + 1}`} inputMode="numeric" value={f.amount} onChange={(e) => setFee(i, { amount: e.target.value })} placeholder="Amount (UGX)" className="min-w-[140px] flex-1" />
            </div>
            {parseAmount(f.amount) != null && <p className="text-right text-xs text-muted-foreground">{ugx(parseAmount(f.amount)!)}</p>}
          </div>
        ))}
        <Button variant="ghost" className="min-h-[44px] w-full gap-2" onClick={() => setT({ ...t, fees: [...t.fees, { class_name: '', boarding_status: 'day', amount: '' }] })}><Plus className="h-4 w-4" />Add another class</Button>
      </div>
      {showErrors && errors.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
      )}
      <div className="flex gap-2">
        <Button variant="ghost" className="min-h-[44px] flex-1" onClick={onCancel} disabled={saving}>Cancel</Button>
        <Button className="min-h-[44px] flex-1" onClick={save} disabled={saving}>{saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}Save term</Button>
      </div>
    </div>
  );
}

function AgreementCard({ school, partnership, editable, onSaved }: { school: SchoolRow; partnership: PartnershipRow | null; editable: boolean; onSaved: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const hasDetails = !!partnership;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { toast.error('The file must be under 10 MB'); return; }
    setUploading(true);
    try {
      const path = await uploadAgreement(school.id, file);
      await savePartnership(school.id, draftFrom(partnership), path);
      toast.success('Agreement uploaded');
      onSaved();
    } catch (e) {
      toast.error('Could not upload', { description: partnershipErrorMessage(e) });
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  const view = async () => {
    if (!partnership?.agreement_path) return;
    const url = await agreementUrl(partnership.agreement_path);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else toast.error('Could not open the agreement');
  };

  return (
    <Card className="space-y-3 p-4">
      <h3 className="flex items-center gap-2 font-semibold"><FileText className="h-4 w-4 text-primary" />Signed partnership agreement</h3>
      {partnership?.agreement_path ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-border p-3">
          <span className="flex min-w-0 items-center gap-2 text-sm"><CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" /><span className="truncate">Agreement uploaded</span></span>
          <Button variant="outline" size="sm" className="min-h-[40px] shrink-0" onClick={view}>View</Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Download the agreement, print it, have the head teacher sign it, then upload a photo or PDF of the signed copy.</p>
      )}
      {/* The blank template, with the Welile logo in the header. */}
      <Button asChild variant="outline" className="min-h-[44px] w-full gap-2 border-primary/40 text-primary hover:bg-primary/5 hover:text-primary">
        <a href={PARTNERSHIP_AGREEMENT_URL} download="Welile_Schools_Partnership_Agreement.docx">
          <Download className="h-4 w-4" />Download the agreement
        </a>
      </Button>
      {editable && (
        <>
          <input ref={input} type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
          <Button variant="outline" className="min-h-[44px] w-full gap-2" disabled={uploading || !hasDetails} onClick={() => input.current?.click()}>
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {partnership?.agreement_path ? 'Replace the agreement' : 'Upload the agreement'}
          </Button>
          {!hasDetails && <p className="text-xs text-muted-foreground">Save the bursar and payout details first.</p>}
        </>
      )}
      {!partnership && !editable && <Badge variant="outline">No agreement</Badge>}
    </Card>
  );
}
