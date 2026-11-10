import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCooReasonCodes } from '@/components/coo/CooReasonPicker';
import { CALM, FOCUS, LABEL, statusGlass, statusText } from './deskTheme';
import { rpc, useReasonCodes } from './reviewApi';
import { DecisionButton, ErrorLine, LoadingRows, Sheet } from './ui';
import { Skeleton } from './Skeleton';
import type { Stage } from './reviewTypes';

/**
 * "Send back…" to a chosen office (E63).
 *
 * The office list comes from `pipeline_send_back_options(p_from_stage)`: the
 * field agent (to correct) and every office before this one. One server call,
 * `pipeline_send_back_to`, records the review and moves the request; it
 * replaced `pipeline_record_review('send_back')` + `return_rent_request_for_correction`.
 * Reasons: the COO's from `coo_reason_codes()`, the other desks' from the
 * reason-code catalogue for their desk (the list their drawer already shows).
 */

/** The desks that send back with `pipeline_send_back_to`. */
export const SEND_BACK_STAGES: ReadonlySet<Stage> = new Set<Stage>(['agent_ops', 'tenant_ops', 'landlord_ops', 'coo']);

export const SEND_BACK_NOTE_MIN = 10;

export type SendBackOption = { code: string; label: string; hint: string | null };
export type SendBackReason = { code: string; meaning: string | null; requires_text: boolean };
export type SendBackResult = { ok?: boolean; to?: string; to_label?: string | null; status?: string | null };

/** The reason-code catalogue's tag for each desk. */
const DESK_TAG: Partial<Record<Stage, string>> = {
  agent_ops: 'Agent Ops',
  tenant_ops: 'Tenant Ops',
  landlord_ops: 'Landlord Ops',
  coo: 'COO',
};

/** Codes the system fills in itself; a person never chooses them. */
const SYSTEM_CODES = new Set(['RULE_FOLLOWED']);

const tagKey = (t: string) => t.trim().toLowerCase().replace(/[_\s]+/g, ' ');

/** A desk's reasons from the catalogue: its own codes and the shared ones ('all'). Tags are matched loosely ('landlord_ops' = 'Landlord Ops'). */
export function deskReasons(all: { code: string; desks?: string[] | null; meaning?: string | null; requires_text?: boolean | null }[], stage: Stage): SendBackReason[] {
  const tag = tagKey(DESK_TAG[stage] ?? '');
  const mine = all.filter((r) => !SYSTEM_CODES.has(r.code) && (r.desks ?? []).some((d) => tagKey(d) === tag || tagKey(d) === 'all'));
  return mine.map((r) => ({ code: r.code, meaning: r.meaning ?? null, requires_text: r.requires_text === true }));
}

/** True when the chosen reason needs a written note (the server's rule). */
export function noteNeeded(reason: SendBackReason | null | undefined): boolean {
  if (!reason) return false;
  return reason.requires_text || reason.code === 'OTHER' || reason.code === 'RISK_JUDGEMENT';
}

/** Why the button is off, or null when it can be pressed. */
export function sendBackBlocked(input: { to: string; reason: SendBackReason | null; note: string }): string | null {
  if (!input.to) return 'Choose where to send it back.';
  if (!input.reason) return 'Choose a reason.';
  if (noteNeeded(input.reason) && input.note.trim().length < SEND_BACK_NOTE_MIN) {
    return `Write at least ${SEND_BACK_NOTE_MIN} characters explaining the reason.`;
  }
  return null;
}

export function useSendBackOptions(stage: Stage) {
  return useQuery({
    queryKey: ['desk-feed', 'send-back-options', stage],
    queryFn: async (): Promise<SendBackOption[]> => {
      const { data, error } = await rpc('pipeline_send_back_options', { p_from_stage: stage });
      if (error) throw error;
      return Array.isArray(data) ? (data as SendBackOption[]) : [];
    },
    staleTime: 10 * 60_000,
    retry: false,
  });
}

/** The desk's reason list: the COO's from `coo_reason_codes()`, everyone else's from the catalogue. */
function useSendBackReasons(stage: Stage): { data: SendBackReason[]; loading: boolean; error: unknown } {
  const coo = stage === 'coo';
  const cooCodes = useCooReasonCodes(coo);
  const catalogue = useReasonCodes();
  const data = useMemo(
    () =>
      coo
        ? (cooCodes.data ?? []).map((r) => ({ code: r.code, meaning: r.meaning ?? null, requires_text: r.requires_text === true }))
        : deskReasons(catalogue.data ?? [], stage),
    [coo, cooCodes.data, catalogue.data, stage],
  );
  const q = coo ? cooCodes : catalogue;
  return { data, loading: q.isLoading, error: q.error };
}

const pick = (on: boolean) =>
  on
    ? statusGlass.ok
    : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:bg-[var(--desk-surface-hover)] hover:text-foreground';

/** The server's own words for a failed send-back, unchanged. */
const serverMessage = (e: unknown) => String((e as { message?: string } | null)?.message ?? e ?? 'The send-back did not go through.');

export function SendBackForm({
  requestId,
  stage,
  onDone,
}: {
  requestId: string;
  stage: Stage;
  /** Called with the confirmation once the request has moved. */
  onDone: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const options = useSendBackOptions(stage);
  const reasons = useSendBackReasons(stage);
  const [to, setTo] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const office = (options.data ?? []).find((o) => o.code === to) ?? null;
  const reason = reasons.data.find((r) => r.code === reasonCode) ?? null;
  const blocked = sendBackBlocked({ to, reason, note });
  const needsNote = noteNeeded(reason);

  const send = async () => {
    if (blocked || busy) return;
    setBusy(true);
    setError(null);
    const { data, error: e } = await rpc('pipeline_send_back_to', {
      p_request_id: requestId,
      p_from_stage: stage,
      p_to: to,
      p_reason_code: reasonCode,
      p_note: note.trim() || null,
    });
    setBusy(false);
    if (e) {
      setError(serverMessage(e));
      return;
    }
    const r = (data ?? {}) as SendBackResult;
    const message = `Sent back to ${r.to_label ?? office?.label ?? 'the chosen office'}.`;
    setDone(message);
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
    onDone(message);
  };

  return (
    <div data-send-back style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <legend className={LABEL} style={{ marginBottom: 6 }}>
          Send it back to
        </legend>
        {options.isLoading ? (
          <LoadingRows rows={2} height={44} label="Loading the offices" />
        ) : options.error ? (
          <ErrorLine>The offices could not load: {serverMessage(options.error)}</ErrorLine>
        ) : (
          (options.data ?? []).map((o) => {
            const on = to === o.code;
            return (
              <button
                key={o.code}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setTo(o.code)}
                data-office={o.code}
                className={`rounded-xl border px-3 py-2 text-left ${CALM} ${FOCUS} ${pick(on)}`}
                style={{ display: 'flex', flexDirection: 'column', gap: 2, borderWidth: 1, borderStyle: 'solid' }}
              >
                <span className="text-sm font-medium text-foreground">{o.label}</span>
                {o.hint && <span className={LABEL}>{o.hint}</span>}
              </button>
            );
          })
        )}
      </fieldset>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className={LABEL}>Reason</span>
        {reasons.loading ? (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} role="status" aria-label="Loading the reasons">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-7 w-28" />
            ))}
          </div>
        ) : reasons.error ? (
          <ErrorLine>The reasons could not load: {serverMessage(reasons.error)}</ErrorLine>
        ) : (
          <div role="radiogroup" aria-label="Reason" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {reasons.data.map((r) => {
              const on = reasonCode === r.code;
              return (
                <button
                  key={r.code}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  title={r.code}
                  onClick={() => setReasonCode(r.code)}
                  data-reason={r.code}
                  className={`desk-pill border text-xs ${CALM} ${FOCUS} ${pick(on)}`}
                  style={{ display: 'inline-flex', alignItems: 'center', padding: '4px 10px', borderWidth: 1, borderStyle: 'solid', borderRadius: 999, textAlign: 'left' }}
                >
                  {r.meaning ?? r.code}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <span className={LABEL}>Note{needsNote ? ` (required, at least ${SEND_BACK_NOTE_MIN} characters)` : ' (optional)'}</span>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="What needs fixing, in plain words. The office or agent reads this."
          className={`w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground ${FOCUS}`}
        />
      </label>

      {blocked && (to || reasonCode) && !done && <p className={`text-sm ${statusText.warn}`} style={{ margin: 0 }}>{blocked}</p>}
      {error && <ErrorLine>{error}</ErrorLine>}
      {done && (
        <p className={`text-sm ${statusText.ok}`} role="status" style={{ margin: 0 }}>
          {done}
        </p>
      )}

      {!done && (
        <div>
          <DecisionButton size="md" variant="primary" disabled={!!blocked || busy} onClick={send}>
            {busy ? 'Sending back…' : `Send back to ${office?.label ?? '…'}`}
          </DecisionButton>
        </div>
      )}
    </div>
  );
}

/** The same form in a sheet: the COO board's "Send back…". */
export function SendBackSheet({ requestId, stage, tenant, onClose }: { requestId: string; stage: Stage; tenant?: string | null; onClose: () => void }) {
  return (
    <Sheet title={tenant ? `Send back — ${tenant}` : 'Send back'} onClose={onClose}>
      <SendBackForm requestId={requestId} stage={stage} onDone={() => window.setTimeout(onClose, 1200)} />
    </Sheet>
  );
}
