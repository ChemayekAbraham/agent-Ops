import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { fmt } from './format';
import { CALM, FOCUS, LABEL, statusGlass, statusText } from './deskTheme';
import { DecisionButton, EmptyState, ErrorLine, LoadingRows, atLeast, useBreakpoint } from './ui';
import { GradeBadge } from './agentGrade';
import { DeskCallButton } from './deskCall';
import { readableError, rpc } from './reviewApi';

/**
 * "Pick another…" for an Agent Ops transfer: the agents the server ranks as
 * able to take this tenant (`agent_ops_transfer_options`), those within 25 km
 * first. Choosing one only changes the transfer's target — the review and the
 * move are the same as the suggested transfer's.
 */

export type TransferOption = {
  agent_id: string;
  agent: string | null;
  phone: string | null;
  /** Whole percentage, 0-100, collected of what was due. */
  pct: number | null;
  new_agent: boolean | null;
  open_requests: number | null;
  plans: number | null;
  km: number | null;
  within_25km: boolean | null;
  transfers_7d: number | null;
  grade: string | null;
};

export const TRANSFER_NOTE_MIN = 10;

/** Within 25 km first; otherwise the server's own ranking is kept. */
export function orderOptions(rows: TransferOption[]): TransferOption[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => Number(!!b.r.within_25km) - Number(!!a.r.within_25km) || a.i - b.i)
    .map((x) => x.r);
}

function useTransferOptions(requestId: string) {
  return useQuery({
    queryKey: ['desk-feed', 'transfer-options', requestId],
    queryFn: async (): Promise<TransferOption[]> => {
      const { data, error } = await rpc('agent_ops_transfer_options', { p_request_id: requestId, p_limit: 20 });
      if (error) throw error;
      const d = (data ?? {}) as { rows?: TransferOption[] };
      return Array.isArray(d.rows) ? d.rows : [];
    },
    staleTime: 30_000,
    retry: false,
  });
}

export function TransferPicker({
  requestId,
  tenant,
  defaultNote,
  onClose,
  onConfirm,
}: {
  requestId: string;
  tenant: string | null;
  /** Pre-filled from the row's reason. */
  defaultNote: string;
  onClose: () => void;
  /** Runs the same review + transfer as the suggested push, with this target and note. */
  onConfirm: (agentId: string, note: string) => Promise<string | null>;
}) {
  // A bottom sheet on phones, a centred card from md.
  const sheetCentred = atLeast(useBreakpoint(), 'md');
  const q = useTransferOptions(requestId);
  const rows = useMemo(() => orderOptions(q.data ?? []), [q.data]);
  const [picked, setPicked] = useState<string | null>(null);
  const [note, setNote] = useState(defaultNote);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noteOk = note.trim().length >= TRANSFER_NOTE_MIN;

  const confirm = async () => {
    if (!picked || !noteOk) return;
    setBusy(true);
    setError(null);
    const err = await onConfirm(picked, note.trim());
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex justify-center"
      style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'flex', justifyContent: 'center', alignItems: sheetCentred ? 'center' : 'flex-end' }}
      role="dialog"
      aria-modal="true"
      aria-label="Pick an agent to transfer to"
    >
      <button type="button" aria-label="Close" onClick={busy ? undefined : onClose} className="absolute inset-0 bg-black/60" />
      <div
        className="desk-root relative flex max-h-[90dvh] w-full max-w-2xl flex-col overflow-hidden border border-[var(--desk-line-color)] shadow-2xl"
        style={{ borderRadius: sheetCentred ? 24 : '24px 24px 0 0' }}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--desk-line-color)] px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-foreground">Transfer {tenant ?? 'the tenant'} to…</h2>
            <p className={LABEL}>Agents within 25 km first. Call one before you choose.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className={`desk-pill border border-[var(--desk-line-color)] p-2 ${CALM} ${FOCUS} disabled:opacity-40`}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-3">
          {q.isLoading && <LoadingRows rows={4} height={36} label="Loading agents who can take this tenant" />}
          {q.error && <ErrorLine>{readableError(q.error)}</ErrorLine>}
          {!q.isLoading && !q.error && rows.length === 0 && <EmptyState>No agent can take this tenant right now.</EmptyState>}
          <ol className="space-y-1.5">
            {rows.map((a, i) => {
              const on = picked === a.agent_id;
              return (
                <li key={a.agent_id}>
                  <div
                    className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-xl border px-3 py-2 text-sm ${
                      on ? statusGlass.ok : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)]'
                    }`}
                  >
                    <span className={`${LABEL} w-5 text-right tabular-nums`}>{i + 1}</span>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setPicked(a.agent_id)}
                      className={`min-w-0 text-left font-medium text-foreground underline-offset-2 hover:underline ${FOCUS}`}
                    >
                      {a.agent ?? 'Agent'}
                    </button>
                    <GradeBadge agentId={a.agent_id} grade={a.grade} weekAgo={null} />
                    <DeskCallButton target={{ requestId, desk: 'agent_ops', subject: 'agent', calleeId: a.agent_id, name: a.agent, phone: a.phone }} />
                    <span className="tabular-nums text-foreground">
                      {a.new_agent ? 'New agent' : a.pct === null ? '—' : `${Math.round(Number(a.pct))}%`}
                    </span>
                    <span className={`tabular-nums ${a.within_25km ? 'text-foreground' : statusText.warn}`}>
                      {a.km === null ? 'distance unknown' : `${Number(a.km).toFixed(1)} km`}
                    </span>
                    <span className={LABEL}>
                      {fmt('int', a.open_requests)} open · {fmt('int', a.plans)} plans
                      {Number(a.transfers_7d ?? 0) > 0 ? ` · ${fmt('int', a.transfers_7d)} transfers in 7 days` : ''}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        <footer className="space-y-2 border-t border-[var(--desk-line-color)] px-5 py-4">
          <label className="block space-y-1">
            <span className={LABEL}>Note (at least {TRANSFER_NOTE_MIN} characters)</span>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              className={`w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground ${FOCUS}`}
            />
          </label>
          {error && <ErrorLine>{error}</ErrorLine>}
          <DecisionButton size="md" variant={picked && noteOk && !busy ? 'ok' : 'quiet'} disabled={!picked || !noteOk || busy} onClick={confirm}>
            {busy ? 'Transferring…' : picked ? `Transfer to ${rows.find((r) => r.agent_id === picked)?.agent ?? 'this agent'}` : 'Choose an agent'}
          </DecisionButton>
        </footer>
      </div>
    </div>
  );
}
