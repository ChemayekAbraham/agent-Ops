import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCooReasonCodes } from '@/components/coo/CooReasonPicker';
import { FOCUS, LABEL, statusText } from './deskTheme';
import { rpc, useReasonCodes } from './reviewApi';
import { DecisionButton, ErrorLine, LoadingRows, Sheet } from './ui';
import { Skeleton } from './Skeleton';
import type { Stage } from './reviewTypes';
import { toast } from 'sonner';
import { sendBackTo, serverMessage, type SendBackStart } from './sendBackApi';
import { ChoiceRow, FixItemsPicker, itemsBlocked, itemsNote, type FixItem } from './sendBackItems';
import { allowedReasons } from './deskReasons';

export { SEND_BACK_STAGES, SUGGESTED_OFFICE, isSendBackRow, sendBackTo, type SendBackResult, type SendBackStart } from './sendBackApi';

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

export const SEND_BACK_NOTE_MIN = 10;

export type SendBackOption = { code: string; label: string; hint: string | null };

/** What an office is called on the desks: the server's own label ("Field agent (to correct)", "Agent Ops", …). */
export function officeLabel(o: Pick<SendBackOption, 'code' | 'label'>): string {
  return o.label;
}

/**
 * A send-back in the request's history, from the review the server records:
 * its note reads "To <office>: <why>". Returns the office and the why, or null
 * for an older review written another way.
 */
export function parseSendBackNote(note: string | null | undefined): { office: string; why: string } | null {
  const m = /^To (.+?): ([\s\S]*)$/.exec((note ?? '').trim());
  if (!m) return null;
  const office = m[1] === 'the field agent (to correct)' ? 'Field agent (to correct)' : m[1];
  return { office, why: m[2].trim() };
}
export type SendBackReason = { code: string; meaning: string | null; requires_text: boolean };

/** The reason-code catalogue's tag for each desk. */
const DESK_TAG: Partial<Record<Stage, string>> = {
  service_centre: 'Service Centre',
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
  // Only the desk's own reasons, with their short labels (deskReasons.ts), from what the server holds active.
  const data = useMemo(
    () =>
      allowedReasons(
        coo
          ? (cooCodes.data ?? []).map((r) => ({ code: r.code, meaning: r.meaning ?? null, requires_text: r.requires_text === true }))
          : (catalogue.data ?? []).map((r) => ({ code: r.code, meaning: r.meaning ?? null, requires_text: r.requires_text === true })),
        stage,
      ),
    [coo, cooCodes.data, catalogue.data, stage],
  );
  const q = coo ? cooCodes : catalogue;
  return { data, loading: q.isLoading, error: q.error };
}


export function SendBackForm({
  requestId,
  stage,
  onDone,
  initial,
}: {
  requestId: string;
  stage: Stage;
  /** Called with the confirmation once the request has moved. */
  onDone: (message: string) => void;
  /** Prefill: the board's suggestion. The reviewer can change any of it. */
  initial?: SendBackStart;
}) {
  const queryClient = useQueryClient();
  const options = useSendBackOptions(stage);
  const reasons = useSendBackReasons(stage);
  const [to, setTo] = useState(initial?.to ?? '');
  const [reasonCode, setReasonCode] = useState(initial?.reasonCode ?? '');
  const [note, setNote] = useState(initial?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // What the agent must fix: required, and named at the start of the note.
  const [items, setItems] = useState<FixItem[]>([]);

  // The destination on screen is the one that counts: the one picked, or the only one there is.
  const codes = (options.data ?? []).map((o) => o.code);
  const chosen = codes.includes(to) ? to : codes.length === 1 ? codes[0] : '';
  const office = (options.data ?? []).find((o) => o.code === chosen) ?? null;
  const reason = reasons.data.find((r) => r.code === reasonCode) ?? null;
  const blocked = sendBackBlocked({ to: chosen, reason, note }) ?? itemsBlocked(items, note);
  const needsNote = noteNeeded(reason);

  const send = async () => {
    if (blocked || busy) return;
    setBusy(true);
    setError(null);
    const out = await sendBackTo({ requestId, stage, to: chosen, reasonCode, note: itemsNote(items, note) });
    setBusy(false);
    if (!out.ok) {
      setError(out.message);
      return;
    }
    const message = out.message;
    setDone(message);
    toast.success(message);
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
          (options.data ?? []).map((o) => (
            // A chosen office shows it: the border and a tick (the only office is chosen already).
            <ChoiceRow key={o.code} role="radio" on={chosen === o.code} onClick={() => setTo(o.code)} data-office={o.code}>
              <span className="block font-medium text-foreground">{officeLabel(o)}</span>
              {o.hint && <span className={`${LABEL} block`}>{o.hint}</span>}
            </ChoiceRow>
          ))
        )}
      </fieldset>

      <FixItemsPicker value={items} onChange={setItems} />

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
          <div role="radiogroup" aria-label="Reason" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {reasons.data.map((r) => (
              <ChoiceRow key={r.code} role="radio" on={reasonCode === r.code} onClick={() => setReasonCode(r.code)} data-reason={r.code}>
                {r.meaning ?? r.code}
              </ChoiceRow>
            ))}
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

      {blocked && (chosen || reasonCode || items.length > 0) && !done && <p className={`text-sm ${statusText.warn}`} style={{ margin: 0 }} data-send-back-blocked>{blocked}</p>}
      {error && <ErrorLine>{error}</ErrorLine>}
      {done && (
        <p className={`text-sm ${statusText.ok}`} role="status" style={{ margin: 0 }}>
          {done}
        </p>
      )}

      {!done && (
        <div>
          <DecisionButton size="md" variant="primary" disabled={!!blocked || busy} onClick={send} style={{ minHeight: 44, whiteSpace: 'normal' }}>
            {busy ? 'Sending back…' : `Send back to ${office ? officeLabel(office) : '…'}`}
          </DecisionButton>
        </div>
      )}
    </div>
  );
}

/** The same form in a sheet: the COO board's "Send back…". */
/** The same form in a sheet: the COO board's "Send back…" and the stage boards' suggested send-back. */
export function SendBackSheet({
  requestId,
  stage,
  tenant,
  initial,
  onDone,
  onClose,
}: {
  requestId: string;
  stage: Stage;
  tenant?: string | null;
  initial?: SendBackStart;
  /** Called with the confirmation once the request has moved, before the sheet closes. */
  onDone?: (message: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet title={tenant ? `Send back — ${tenant}` : 'Send back'} onClose={onClose}>
      <SendBackForm
        requestId={requestId}
        stage={stage}
        initial={initial}
        onDone={(message) => {
          onDone?.(message);
          window.setTimeout(onClose, 1200);
        }}
      />
    </Sheet>
  );
}
