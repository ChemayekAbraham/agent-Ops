import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { FOCUS, LABEL, PANEL, statusText } from './deskTheme';
import { DecisionButton, ErrorLine } from './ui';
import { readableError, rpc } from './reviewApi';
import { DeskCallButton } from './deskCall';
import { setWait, type WaitSuggest } from './boardApi';
import type { Stage } from './reviewTypes';

/**
 * Agent Ops "Call and fill": call the agent and write down what the request is
 * missing. Saved with `staff_save_intake_details`, which answers with what is
 * still missing; the board then refetches. Pass stays refused by the database
 * while anything is missing, so this form is the way through.
 */

export const FAMILY_MIN = 1;
export const FAMILY_MAX = 30;
export const LC1_MIN = 10;

export type IntakeValues = { familySize: string; workBusiness: string; workLocation: string; lc1: string };

/** Why Save is off, or null. Only filled fields are checked; at least one must be filled. */
export function intakeBlocked(v: IntakeValues): string | null {
  const any = v.familySize.trim() || v.workBusiness.trim() || v.workLocation.trim() || v.lc1.trim();
  if (!any) return 'Fill at least one of the missing items.';
  if (v.familySize.trim()) {
    const n = Number(v.familySize);
    if (!Number.isInteger(n) || n < FAMILY_MIN || n > FAMILY_MAX) return `Family size is a whole number from ${FAMILY_MIN} to ${FAMILY_MAX}.`;
  }
  if (v.lc1.trim() && v.lc1.trim().length < LC1_MIN) return `Write at least ${LC1_MIN} characters for the LC1 phone confirmation.`;
  return null;
}

const plain = (s: string) => s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Which field a missing item names, so the form can flag it. */
const missingHas = (missing: string[], re: RegExp) => missing.some((m) => re.test(m));

const INPUT = `desk-pill h-9 w-full border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 text-sm text-foreground ${FOCUS}`;

export function IntakeForm({
  requestId,
  stage,
  agent,
  itemsMissing,
  waitSuggest,
}: {
  requestId: string;
  stage: Stage;
  agent: { id: string | null; name: string | null; phone: string | null };
  itemsMissing: string[];
  waitSuggest: WaitSuggest | null;
}) {
  const queryClient = useQueryClient();
  const [v, setV] = useState<IntakeValues>({ familySize: '', workBusiness: '', workLocation: '', lc1: '' });
  const [stillMissing, setStillMissing] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const missing = stillMissing ?? itemsMissing;
  const blocked = intakeBlocked(v);
  const set = (k: keyof IntakeValues) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  const flag = (re: RegExp) => (missingHas(missing, re) ? <span className={statusText.warn}> · missing</span> : null);

  const save = async () => {
    if (blocked) return;
    setBusy(true);
    setMessage(null);
    const { data, error } = await rpc('staff_save_intake_details', {
      p_request_id: requestId,
      p_family_size: v.familySize.trim() ? Number(v.familySize) : null,
      p_work_business: v.workBusiness.trim() || null,
      p_work_location: v.workLocation.trim() || null,
      p_lc1_phone_confirmation: v.lc1.trim() || null,
    });
    setBusy(false);
    if (error) {
      setMessage({ ok: false, text: readableError(error) });
      return;
    }
    const r = (data ?? {}) as { ok?: boolean; still_missing?: string[] };
    const left = r.still_missing ?? [];
    setStillMissing(left);
    setMessage({ ok: true, text: left.length ? `Saved. Still missing: ${left.map(plain).join(', ')}.` : 'Saved. Nothing is missing now.' });
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
  };

  const wait = async () => {
    setBusy(true);
    const r = await setWait(requestId, stage, waitSuggest);
    setBusy(false);
    setMessage({ ok: r.ok, text: r.ok ? r.message : readableError({ message: r.message }) });
    if (r.ok) queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
  };

  return (
    <section className={`${PANEL} space-y-4 p-4`} aria-label="Call and fill">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Call and fill what&rsquo;s missing</h3>
        <span className="inline-flex items-center gap-1.5 text-sm text-foreground">
          Call agent {agent.name ?? ''}
          <DeskCallButton target={{ requestId, desk: stage, subject: 'agent', calleeId: agent.id, name: agent.name, phone: agent.phone }} />
        </span>
      </div>
      {missing.length > 0 ? (
        <p className={`text-sm ${statusText.warn}`}>Missing: {missing.map(plain).join(', ')}</p>
      ) : (
        <p className={`text-sm ${statusText.ok}`}>Nothing is missing.</p>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className={LABEL}>Family size ({FAMILY_MIN}–{FAMILY_MAX}){flag(/family/i)}</span>
          <input type="number" inputMode="numeric" min={FAMILY_MIN} max={FAMILY_MAX} value={v.familySize} onChange={set('familySize')} className={`${INPUT} max-w-[8rem]`} />
        </label>
        <label className="block space-y-1">
          <span className={LABEL}>Work or business{flag(/work|business|occupation/i)}</span>
          <input value={v.workBusiness} onChange={set('workBusiness')} className={INPUT} placeholder="e.g. tailoring shop" />
        </label>
        <label className="block space-y-1">
          <span className={LABEL}>Where they work{flag(/location/i)}</span>
          <input value={v.workLocation} onChange={set('workLocation')} className={INPUT} placeholder="e.g. Nakawa market" />
        </label>
        <label className="block space-y-1 sm:col-span-2">
          <span className={LABEL}>LC1 phone confirmation ({LC1_MIN}+ characters){flag(/lc1/i)}</span>
          <textarea
            value={v.lc1}
            onChange={set('lc1')}
            rows={2}
            placeholder="Who confirmed by phone: the LC1 chairperson's name and number, and what they said."
            className={`w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground ${FOCUS}`}
          />
        </label>
      </div>

      {blocked && <p className={`text-sm ${statusText.warn}`}>{blocked}</p>}
      {message &&
        (message.ok ? (
          <p className={`text-sm ${statusText.ok}`} role="status">
            {message.text}
          </p>
        ) : (
          <ErrorLine>{message.text}</ErrorLine>
        ))}
      <div className="flex flex-wrap gap-2" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <DecisionButton size="md" variant={!blocked && !busy ? 'ok' : 'quiet'} disabled={!!blocked || busy} onClick={save}>
          {busy ? 'Saving…' : 'Save what you filled'}
        </DecisionButton>
        {waitSuggest && (
          <DecisionButton size="md" disabled={busy} onClick={wait}>
            Wait {waitSuggest.hours} h on agent
          </DecisionButton>
        )}
      </div>
    </section>
  );
}
