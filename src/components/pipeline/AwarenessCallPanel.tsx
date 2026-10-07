import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { CheckCircle2, ClipboardList, History, Loader2, PhoneCall } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { MerchantCodePills } from '@/components/supporter/MerchantCodePills';
import {
  clearDialSession, readDialSession, useAwarenessCalls, useRecordAwarenessCall, useReturnFromCall, writeDialSession,
  type AwarenessCall, type DialSession,
} from '@/hooks/useAwarenessCalls';
import {
  AWARENESS_OPTIONS, CALL_RESULT_OPTIONS, EXPLAINED_OPTIONS, SUBJECT_LABEL, TEAM_LABEL, TEAM_ORDER,
  awarenessLabel, callResultLabel, explainedLabel, stageLabel, telHref,
  type AwarenessCallResult, type AwarenessChoice, type AwarenessSubject, type ExplainedChoice,
} from '@/lib/awarenessCallLabels';

/**
 * "Awareness call" panel, shared by the Review Rent Request sheet (RentPipelineQueue) and the Service Centre vetting
 * queue (ServiceCenterRentVettingQueue). Staff phone the tenant or landlord, then record what
 * they heard. It sits beside the approve and reject controls and never changes them: nothing here moves a Rent Plan
 * through the pipeline, and a Rent Plan can be approved or rejected whether or not a call has been saved.
 * The caller's team (service centre, Agent Ops, Tenant Ops, Landlord Ops, other) is worked out by the database from who
 * the caller is, never sent from here, so a service centre manager's calls are always recorded as 'service_centre'.
 * `defaultSubject` is who the stage usually phones first: the suggested button comes first and is highlighted, and
 * "Record feedback" starts with that person selected.
 */

export interface AwarenessCallRequest {
  id: string;
  status?: string | null;
  tenant_id?: string | null;
  tenant_name?: string | null;
  tenant_phone?: string | null;
  landlord_name?: string | null;
  landlord_phone?: string | null;
}

function ChoiceChips<T extends string>({
  label, value, options, onChange, name,
}: { label: string; value: T | null; options: { value: T; label: string }[]; onChange: (v: T) => void; name: string }) {
  return (
    <div className="space-y-1.5">
      <p id={`${name}-label`} className="text-xs font-medium">{label}</p>
      <div role="radiogroup" aria-labelledby={`${name}-label`} className="grid grid-cols-1 gap-1.5 min-[420px]:grid-cols-2">
        {options.map((o) => {
          const selected = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(o.value)}
              className={cn(
                'min-h-11 rounded-lg border px-3 py-2 text-left text-sm transition-colors touch-manipulation',
                selected
                  ? 'border-primary bg-primary text-primary-foreground font-semibold'
                  : 'border-border bg-background text-foreground hover:bg-muted/60',
              )}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CallLine({ call }: { call: AwarenessCall }) {
  const when = new Date(call.dial_started_at).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <li className="space-y-0.5 rounded-lg border border-border bg-muted/30 p-2.5 text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">{SUBJECT_LABEL[call.subject_type] ?? call.subject_type}</span>
        <Badge variant={call.call_result === 'answered' ? 'secondary' : 'outline'} className="text-[10px]">
          {callResultLabel(call.call_result)}
        </Badge>
        <span className="text-muted-foreground">{when} · {call.caller_name}</span>
      </div>
      <p className="text-muted-foreground">At stage: {stageLabel(call.pipeline_stage)}</p>
      {call.call_result === 'answered' && (
        <dl className="grid grid-cols-1 gap-y-0.5 pt-0.5 min-[420px]:grid-cols-[auto_1fr] min-[420px]:gap-x-2">
          <dt className="text-muted-foreground">Knew about the 30M Rent Plan</dt>
          <dd className="font-medium">{awarenessLabel(call.aware_30m)}</dd>
          <dt className="text-muted-foreground">Knew the merchant codes</dt>
          <dd className="font-medium">{awarenessLabel(call.aware_merchant_codes)}</dd>
          <dt className="text-muted-foreground">Explained by the caller</dt>
          <dd className="font-medium">{explainedLabel(call.explained)}</dd>
        </dl>
      )}
      {call.note && <p className="pt-0.5 italic text-foreground/80">“{call.note}”</p>}
    </li>
  );
}

export function AwarenessCallPanel({
  request, defaultSubject = 'tenant',
}: { request: AwarenessCallRequest; defaultSubject?: 'tenant' | 'landlord' }) {
  const requestId = request.id;
  const calls = useAwarenessCalls(requestId);
  const record = useRecordAwarenessCall();

  const [session, setSession] = useState<DialSession | null>(() => readDialSession(requestId));
  const [formOpen, setFormOpen] = useState<boolean>(() => readDialSession(requestId) !== null);
  // Used only when feedback is recorded without having tapped a call button here.
  const [manualSubject, setManualSubject] = useState<AwarenessSubject | null>(null);
  const [openedAt, setOpenedAt] = useState<string | null>(null);

  const [result, setResult] = useState<AwarenessCallResult | null>(null);
  const [aware30m, setAware30m] = useState<AwarenessChoice | null>(null);
  const [awareCodes, setAwareCodes] = useState<AwarenessChoice | null>(null);
  const [explained, setExplained] = useState<ExplainedChoice | null>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const phones: Record<'tenant' | 'landlord', { phone: string; name: string }> = {
    tenant: { phone: request.tenant_phone ?? '', name: request.tenant_name || 'tenant' },
    landlord: { phone: request.landlord_phone ?? '', name: request.landlord_name || 'landlord' },
  };

  // The person this stage usually phones comes first.
  const callOrder: ('tenant' | 'landlord')[] = defaultSubject === 'landlord' ? ['landlord', 'tenant'] : ['tenant', 'landlord'];

  const startDial = (who: 'tenant' | 'landlord') => {
    const next: DialSession = { subject: who, phone: phones[who].phone, dialStartedAt: new Date().toISOString() };
    setSession(next);
    writeDialSession(requestId, next);
    // the browser then follows the tel: link; the form opens when the person comes back
  };

  // Back from the dialler (or another app): show the short form.
  useReturnFromCall(Boolean(session) && !formOpen, () => setFormOpen(true));

  const openManually = () => {
    setOpenedAt(new Date().toISOString());
    setFormOpen(true);
  };

  const resetForm = () => {
    setResult(null); setAware30m(null); setAwareCodes(null); setExplained(null); setNote(''); setError(null);
    setManualSubject(null); setOpenedAt(null);
  };

  const discard = () => {
    clearDialSession(requestId);
    setSession(null);
    setFormOpen(false);
    resetForm();
  };

  // With no call button tapped, the stage's usual person is selected until the caller picks the other.
  const subject: AwarenessSubject | null = session?.subject ?? manualSubject ?? (formOpen ? defaultSubject : null);
  const phone = session?.phone ?? (subject === 'tenant' || subject === 'landlord' ? phones[subject].phone : '');
  const dialStartedAt = session?.dialStartedAt ?? openedAt;

  const answered = result === 'answered';
  const ready = Boolean(subject && phone && dialStartedAt && result && (!answered || (aware30m && awareCodes && explained)));

  const save = async () => {
    setError(null);
    if (!subject || !dialStartedAt || !result) { setError('Choose who you called and how the call went.'); return; }
    if (!phone) { setError('There is no phone number on this Rent Plan for that person.'); return; }
    if (answered && !(aware30m && awareCodes && explained)) { setError('Please answer all three questions for an answered call.'); return; }
    try {
      await record.mutateAsync({
        rentRequestId: requestId,
        subject,
        phone,
        dialStartedAt,
        result,
        // a tenant is a user; a landlord on a Rent Plan is a landlord record, so only the phone is kept
        subjectUserId: subject === 'tenant' ? request.tenant_id ?? null : null,
        aware30m, awareMerchantCodes: awareCodes, explained, note,
      });
      toast.success('Awareness call saved');
      discard();
    } catch (e) {
      const message = (e as { message?: string })?.message || 'Could not save the call';
      setError(message);
      toast.error(message);
    }
  };

  const grouped = useMemo(() => {
    const rows = calls.data?.rows ?? [];
    return TEAM_ORDER
      .map((team) => ({ team, rows: rows.filter((r) => r.caller_team === team) }))
      .filter((g) => g.rows.length > 0);
  }, [calls.data]);

  // A person without access to the log sees nothing here; the rest of the sheet is unaffected.
  if (calls.isError) return null;

  const total = calls.data?.total ?? 0;
  const noCallYet = !calls.isLoading && total === 0;

  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-3" aria-label="Awareness call" data-testid="awareness-call-section">
      <div className="flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold">
          <PhoneCall className="h-4 w-4 text-primary" />
          Awareness call
        </h4>
        {total > 0 && <Badge variant="secondary" className="text-[10px]">{total} saved</Badge>}
      </div>

      {noCallYet && (
        <p className="rounded-lg bg-muted/50 p-2.5 text-xs leading-relaxed text-muted-foreground" data-testid="awareness-reminder">
          No awareness call has been saved for this Rent Plan yet. A short call to the tenant and the landlord, recorded here,
          helps the next stage. You can still approve or reject as usual.
        </p>
      )}

      <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
        {callOrder.map((who) => {
          const href = telHref(phones[who].phone);
          const label = who === 'tenant' ? 'Call tenant' : 'Call landlord';
          const suggested = who === defaultSubject;
          return href ? (
            <Button
              key={who}
              asChild
              variant={suggested ? 'default' : 'outline'}
              className="h-11 w-full justify-start gap-2"
              data-suggested={suggested ? 'true' : undefined}
            >
              <a href={href} onClick={() => startDial(who)} aria-label={`${label} ${phones[who].phone}`}>
                <PhoneCall className="h-4 w-4" />
                <span className="min-w-0 truncate">{label}</span>
                <span className={cn('ml-auto text-xs font-normal', suggested ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
                  {phones[who].phone}
                </span>
              </a>
            </Button>
          ) : (
            <Button key={who} type="button" variant="outline" disabled className="h-11 w-full justify-start gap-2">
              <PhoneCall className="h-4 w-4" />
              {label}
              <span className="ml-auto text-xs font-normal text-muted-foreground">No phone</span>
            </Button>
          );
        })}
      </div>

      {session && !formOpen && (
        <p className="text-xs text-muted-foreground" data-testid="awareness-dialling">
          Call to the {SUBJECT_LABEL[session.subject].toLowerCase()} started. When you come back, record what they said.
        </p>
      )}

      {!formOpen && (
        <Button type="button" variant="secondary" className="h-11 w-full gap-2" onClick={openManually}>
          <ClipboardList className="h-4 w-4" />
          Record feedback
        </Button>
      )}

      {formOpen && (
        <form
          className="space-y-4 rounded-lg border border-border bg-background p-3"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
          aria-label="Record awareness call feedback"
        >
          <p className="text-sm font-semibold">
            {subject ? `Call to the ${SUBJECT_LABEL[subject].toLowerCase()}` : 'Who did you call?'}
            {phone && <span className="ml-1 font-normal text-muted-foreground">{phone}</span>}
          </p>

          {!session && (
            <ChoiceChips
              name="awareness-subject"
              label="Who did you call?"
              value={manualSubject === 'tenant' || manualSubject === 'landlord' ? manualSubject : defaultSubject}
              options={[{ value: 'tenant', label: 'Tenant' }, { value: 'landlord', label: 'Landlord' }]}
              onChange={(v) => setManualSubject(v)}
            />
          )}

          <ChoiceChips<AwarenessCallResult> name="awareness-result" label="How did the call go?" value={result} options={CALL_RESULT_OPTIONS} onChange={setResult} />

          {answered && (
            <>
              <ChoiceChips<AwarenessChoice>
                name="awareness-30m"
                label="Before you explained, did they know about the 30M Rent Plan?"
                value={aware30m}
                options={AWARENESS_OPTIONS}
                onChange={setAware30m}
              />
              <div className="space-y-1">
                <ChoiceChips<AwarenessChoice>
                  name="awareness-codes"
                  label="Did they know the Welile merchant codes used to pay?"
                  value={awareCodes}
                  options={AWARENESS_OPTIONS}
                  onChange={setAwareCodes}
                />
                <MerchantCodePills />
              </div>
              <ChoiceChips<ExplainedChoice>
                name="awareness-explained"
                label="Did you explain it to them?"
                value={explained}
                options={EXPLAINED_OPTIONS}
                onChange={setExplained}
              />
            </>
          )}

          <div className="space-y-1.5">
            <label htmlFor={`awareness-note-${requestId}`} className="text-xs font-medium">Note (optional)</label>
            <Textarea
              id={`awareness-note-${requestId}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              rows={3}
              placeholder="Anything worth telling the next stage"
              className="text-sm"
            />
          </div>

          {error && <p role="alert" className="text-xs font-medium text-destructive">{error}</p>}

          <div className="grid grid-cols-2 gap-2">
            <Button type="button" variant="outline" className="h-11" onClick={discard} disabled={record.isPending}>Discard</Button>
            <Button type="submit" className="h-11 gap-2" disabled={!ready || record.isPending}>
              {record.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
              Save call
            </Button>
          </div>
        </form>
      )}

      {grouped.length > 0 && (
        <div className="space-y-2 border-t border-border pt-3" data-testid="awareness-earlier">
          <h5 className="flex items-center gap-1.5 text-xs font-semibold">
            <History className="h-3.5 w-3.5 text-muted-foreground" />
            Earlier stages said…
          </h5>
          {grouped.map((g) => (
            <div key={g.team} className="space-y-1.5" data-testid={`awareness-team-${g.team}`}>
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{TEAM_LABEL[g.team]}</p>
              <ul className="space-y-1.5">
                {g.rows.map((c) => <CallLine key={c.id} call={c} />)}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
