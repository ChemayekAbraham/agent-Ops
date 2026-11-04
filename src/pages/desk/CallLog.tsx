import { useState } from 'react';
import { PhoneCall } from 'lucide-react';
import { rpc, readableError } from './reviewApi';
import { CALM, FOCUS, LABEL, PANEL, statusGlass, statusText } from './deskTheme';

/**
 * The awareness call, logged before any decision.
 *
 * Tenant Ops and Landlord Ops cannot pass a request until an answered call sits
 * on it — `pipeline_record_review` refuses otherwise — so this form comes first
 * in the drawer and the Pass button stays off until it has been used.
 *
 * The answer sets below mirror `record_awareness_call` exactly: a landlord call
 * never carries the merchant-code answer, and a tenant call never carries the
 * consent or payment-code answers.
 */

export type CallSubject = 'tenant' | 'landlord';

const RESULTS: { value: string; label: string }[] = [
  { value: 'answered', label: 'Answered' },
  { value: 'no_answer', label: 'No answer' },
  { value: 'phone_off', label: 'Phone off' },
  { value: 'wrong_number', label: 'Wrong number' },
];
const AWARE: { value: string; label: string }[] = [
  { value: 'knew', label: 'Knew' },
  { value: 'heard', label: 'Had heard' },
  { value: 'did_not_know', label: 'Did not know' },
];
const EXPLAINED: { value: string; label: string }[] = [
  { value: 'yes', label: 'Yes' },
  { value: 'partly', label: 'Partly' },
  { value: 'no', label: 'No' },
];
const CONSENT: { value: string; label: string }[] = [
  { value: 'consents', label: 'Consents' },
  { value: 'unsure', label: 'Unsure' },
  { value: 'refuses', label: 'Refuses' },
];

function Choice({
  label,
  hint,
  options,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  options: { value: string; label: string }[];
  value: string | null;
  onChange: (v: string) => void;
}) {
  return (
    <fieldset className="space-y-1.5 min-w-0">
      <legend className={LABEL}>{label}</legend>
      {hint && <p className="text-xs leading-snug text-muted-foreground">{hint}</p>}
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => {
          const on = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(o.value)}
              className={`desk-pill border px-3 py-1 text-xs ${CALM} ${FOCUS} ${
                on ? statusGlass.ok : 'border-white/12 bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-foreground'
              }`}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

export function CallLog({
  requestId,
  subject,
  subjectUserId,
  defaultPhone,
  onLogged,
}: {
  requestId: string;
  subject: CallSubject;
  /** Only the tenant's profile id is a user id; a landlord is a row in `landlords`, never a user. */
  subjectUserId?: string | null;
  defaultPhone: string | null;
  onLogged: (answered: boolean) => void;
}) {
  const landlord = subject === 'landlord';
  const [phone, setPhone] = useState(defaultPhone ?? '');
  const [result, setResult] = useState<string | null>(null);
  const [aware30m, setAware30m] = useState<string | null>(null);
  const [merchant, setMerchant] = useState<string | null>(null);
  const [explained, setExplained] = useState<string | null>(null);
  const [consent, setConsent] = useState<string | null>(null);
  const [payoutOtp, setPayoutOtp] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  const answered = result === 'answered';
  const answersReady = landlord
    ? !!aware30m && !!consent && !!payoutOtp && !!explained
    : !!aware30m && !!merchant && !!explained;
  const ready = phone.trim().length >= 7 && !!result && (!answered || answersReady);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await rpc('record_awareness_call', {
        p_rent_request_id: requestId,
        p_subject_type: subject,
        p_subject_phone: phone.trim(),
        p_dial_started_at: new Date().toISOString(),
        p_call_result: result,
        p_subject_user_id: landlord ? null : subjectUserId || null,
        p_aware_30m: answered ? aware30m : null,
        p_aware_merchant_codes: answered && !landlord ? merchant : null,
        p_explained: answered ? explained : null,
        p_note: note.trim() || null,
        p_landlord_consent: answered && landlord ? consent : null,
        p_aware_payout_otp: answered && landlord ? payoutOtp : null,
      });
      if (err) throw err;
      setSaved(answered ? 'Answered call logged.' : 'Attempt logged.');
      onLogged(answered);
    } catch (e) {
      setError(readableError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${PANEL} space-y-4 p-4`}>
      <div className="flex items-center gap-2">
        <PhoneCall className="h-4 w-4 text-[hsl(var(--desk-lavender))]" aria-hidden />
        <h3 className="text-sm font-semibold text-foreground">Log the {subject} call</h3>
      </div>
      <p className="text-xs leading-snug text-muted-foreground">
        {landlord
          ? 'Confirm the number is the landlord’s own, that they know the tenant, and that they accept the deposit and the payment code. Pass stays off until an answered call is logged.'
          : 'Cover rent support up to UGX 30M, paying by merchant code, and the tenant dashboard. Pass stays off until an answered call is logged.'}
      </p>

      <label className="block space-y-1.5">
        <span className={LABEL}>Number called</span>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
          placeholder="+2567…"
          className={`desk-pill h-9 w-full max-w-xs border border-white/12 bg-white/5 px-3 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`}
        />
      </label>

      <Choice label="How did the call go?" options={RESULTS} value={result} onChange={setResult} />

      {answered && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Choice
            label={landlord ? 'Knew Welile pays rent up to UGX 30M' : 'Knew the offer (up to 12 months, up to UGX 30M)'}
            options={AWARE}
            value={aware30m}
            onChange={setAware30m}
          />
          {!landlord && (
            <Choice label="Knew they can pay by merchant code" options={AWARE} value={merchant} onChange={setMerchant} />
          )}
          {landlord && (
            <Choice label="Knew the payout code (OTP)" options={AWARE} value={payoutOtp} onChange={setPayoutOtp} />
          )}
          {landlord && (
            <Choice
              label="Consent to the deposit on this number"
              hint="No withdrawal charges added."
              options={CONSENT}
              value={consent}
              onChange={setConsent}
            />
          )}
          <Choice label="Did you explain it fully?" options={EXPLAINED} value={explained} onChange={setExplained} />
        </div>
      )}

      <label className="block space-y-1.5">
        <span className={LABEL}>Note (optional)</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          className={`w-full rounded-xl border border-white/12 bg-white/5 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`}
          placeholder="What the person said in their own words."
        />
      </label>

      {error && <p className={`text-sm ${statusText.bad}`} role="alert">{error}</p>}
      {saved && !error && <p className={`text-sm ${statusText.ok}`}>{saved}</p>}

      <button
        type="button"
        disabled={!ready || busy}
        onClick={submit}
        className={`desk-pill border px-4 py-2 text-sm font-medium ${CALM} ${FOCUS} ${
          ready && !busy ? statusGlass.ok : 'border-white/12 bg-white/5 text-muted-foreground'
        } disabled:cursor-not-allowed`}
      >
        {busy ? 'Saving the call…' : 'Save the call'}
      </button>
    </section>
  );
}
