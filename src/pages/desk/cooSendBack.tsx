import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useCooReasonCodes } from '@/components/coo/CooReasonPicker';
import { LABEL, statusText } from './deskTheme';
import { fmt } from './format';
import { DecisionButton, ErrorLine, LoadingRows, Sheet, stackLayout } from './ui';
import { SEND_BACK_NOTE_MIN, noteNeeded, useSendBackOptions, type SendBackReason } from './sendBack';
import { sendBackTo } from './sendBackApi';

/**
 * The COO sends back any request in the COO queue, frozen and held ones
 * included: to the agent (to correct) or to an earlier office, with a COO
 * reason code and a note where the reason needs one. One
 * `pipeline_send_back_to(p_from_stage 'coo')` call per request; for a
 * selection, "Done X · Skipped Y" lists each skipped request with the
 * server's words.
 */

export type CooDestination = 'agent' | 'service_centre' | 'agent_ops' | 'tenant_ops' | 'landlord_ops';
/** The offices a COO send-back can go to; the server's own labels (pipeline_send_back_options) are used when they load. */
export const COO_DESTINATIONS: { code: CooDestination; label: string }[] = [
  { code: 'agent', label: 'To the agent (to correct)' },
  { code: 'service_centre', label: 'Service Centre' },
  { code: 'agent_ops', label: 'Agent Ops' },
  { code: 'tenant_ops', label: 'Tenant Ops' },
  { code: 'landlord_ops', label: 'Landlord Ops' },
];

export type CooTarget = { id: string; tenant: string | null };
export type CooSendBackResult = { done: string[]; skipped: { id: string; tenant: string | null; error: string }[] };

/** One request after another, so each gets its own review; a refusal skips that one and the rest go on. */
export async function sendBackMany(
  targets: CooTarget[],
  input: { to: CooDestination; reasonCode: string; note: string },
): Promise<CooSendBackResult> {
  const out: CooSendBackResult = { done: [], skipped: [] };
  for (const t of targets) {
    const r = await sendBackTo({ requestId: t.id, stage: 'coo', to: input.to, reasonCode: input.reasonCode, note: input.note });
    if (r.ok) out.done.push(t.id);
    else out.skipped.push({ id: t.id, tenant: t.tenant, error: (r as { message: string }).message });
  }
  return out;
}

export function CooSendBackSheet({ targets, onDone, onClose }: { targets: CooTarget[]; onDone?: (doneIds: string[]) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const codes = useCooReasonCodes(true);
  const options = useSendBackOptions('coo');
  // The same offices and words as the one-row sheet; the fixed list if the server's has not come.
  const destinations: { code: CooDestination; label: string; hint?: string | null }[] =
    options.data && options.data.length > 0 ? options.data.map((o) => ({ code: o.code as CooDestination, label: o.label, hint: o.hint })) : COO_DESTINATIONS;
  const reasons: SendBackReason[] = (codes.data ?? []).map((r) => ({ code: r.code, meaning: r.meaning ?? null, requires_text: r.requires_text === true }));
  const [to, setTo] = useState<CooDestination | ''>('');
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<CooSendBackResult | null>(null);
  const many = targets.length > 1;
  const reason = reasons.find((r) => r.code === reasonCode) ?? null;
  const needsNote = noteNeeded(reason);
  const blocked = !to ? 'Choose where to send it back.' : !reason ? 'Choose a reason.' : needsNote && note.trim().length < SEND_BACK_NOTE_MIN ? `Write at least ${SEND_BACK_NOTE_MIN} characters explaining the reason.` : null;

  const go = async () => {
    if (blocked) return setProblem(blocked);
    setSaving(true);
    setProblem(null);
    const r = await sendBackMany(targets, { to: to as CooDestination, reasonCode, note });
    setSaving(false);
    void qc.invalidateQueries({ queryKey: ['desk-feed'] });
    if (r.done.length) onDone?.(r.done);
    const label = destinations.find((d) => d.code === to)?.label ?? to;
    if (!many) {
      // One request: the server's refusal stays on the form; a success closes it.
      if (r.skipped.length) return setProblem(r.skipped[0].error);
      toast.success(to === 'agent' ? 'Sent back to the agent' : `Sent back to ${label}`);
      onClose();
      return;
    }
    setResult(r);
    toast.success(`Done ${fmt('int', r.done.length)} · Skipped ${fmt('int', r.skipped.length)}`);
  };

  const title = many ? `Send back ${fmt('int', targets.length)} requests` : `Send back — ${targets[0]?.tenant ?? 'request'}`;

  if (result) {
    return (
      <Sheet title={title} onClose={onClose}>
        <div style={stackLayout(10)} data-coo-bulk-result>
          <p className="text-base font-semibold text-foreground" style={{ margin: 0 }} data-coo-bulk-summary>
            Done {fmt('int', result.done.length)} · Skipped {fmt('int', result.skipped.length)}
          </p>
          {result.skipped.length > 0 && (
            <ul style={{ ...stackLayout(6), margin: 0, padding: 0, listStyle: 'none' }} aria-label="Skipped">
              {result.skipped.map((s) => (
                <li key={s.id} className="text-sm" data-coo-skipped={s.id}>
                  <span className="font-medium text-foreground">{s.tenant ?? s.id.slice(0, 8).toUpperCase()}</span>
                  <span className={`${statusText.bad} ml-2`}>{s.error}</span>
                </li>
              ))}
            </ul>
          )}
          <div>
            <DecisionButton onClick={onClose}>Close</DecisionButton>
          </div>
        </div>
      </Sheet>
    );
  }

  return (
    <Sheet
      title={title}
      onClose={onClose}
      footer={
        <div style={stackLayout(8)}>
          {problem && <ErrorLine>{problem}</ErrorLine>}
          <DecisionButton variant="warn" disabled={saving || !!blocked} title={blocked ?? undefined} onClick={() => void go()} data-coo-send-back-confirm>
            {saving ? 'Sending back…' : many ? `Send back ${fmt('int', targets.length)}` : 'Send back'}
          </DecisionButton>
        </div>
      }
    >
      <div style={stackLayout(14)}>
        <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
          <legend className={LABEL}>Send back to</legend>
          <div style={{ ...stackLayout(6), marginTop: 6 }}>
            {destinations.map((d) => (
              <label key={d.code} className="flex items-center gap-2 text-sm text-foreground">
                <input type="radio" name="coo-send-back-to" value={d.code} checked={to === d.code} onChange={() => setTo(d.code)} data-destination={d.code} />
                <span>
                  {d.label}
                  {d.hint && <span className={`${LABEL} ml-2`}>{d.hint}</span>}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <label style={stackLayout(4)}>
          <span className={LABEL}>Reason</span>
          {codes.isLoading ? (
            <LoadingRows rows={1} label="Loading the reasons" />
          ) : codes.error ? (
            <ErrorLine>{String((codes.error as { message?: string }).message ?? codes.error)}</ErrorLine>
          ) : (
            <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value)} className="rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2 py-1.5 text-sm text-foreground" data-coo-reason>
              <option value="">Choose…</option>
              {reasons.map((r) => (
                <option key={r.code} value={r.code}>
                  {r.meaning ? `${r.code} — ${r.meaning}` : r.code}
                </option>
              ))}
            </select>
          )}
        </label>
        <label style={stackLayout(4)}>
          <span className={LABEL}>{needsNote ? `Note (at least ${SEND_BACK_NOTE_MIN} characters)` : 'Note (optional)'}</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className="rounded-md border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2 py-1.5 text-sm text-foreground" data-coo-note />
        </label>
      </div>
    </Sheet>
  );
}
