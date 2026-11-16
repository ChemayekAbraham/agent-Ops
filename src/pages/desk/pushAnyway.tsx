import { useState } from 'react';
import { X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { fmt } from './format';
import { CALM, FOCUS, LABEL, statusText } from './deskTheme';
import { DecisionButton, ErrorLine, GradeBadge } from './ui';
import { rpc } from './reviewApi';
import { plainError } from './arrears/arrearsApi';
import { missingText } from './incomplete';
import { cooOverrideKey } from '@/components/coo/CooOverrideLine';
import type { CooRow } from './CooBoard';

/**
 * E131: the COO's "Push anyway" for requests held only because items are
 * missing, when the agent is eligible. The COO gives one reason (at least 10
 * characters) and rpc('coo_push_override', { p_ids, p_reason }) pushes them to
 * the funders' board, recording the missing items and the reason:
 *   → { approved: [{ id, rent_amount }], approved_total, skipped: [{ id, reason, message }] }
 * A frozen agent stays frozen: the server skips that row and says why
 * ("Agent is frozen: … The freeze stays."), and the sheet shows those words.
 */

export const PUSH_ANYWAY_MIN = 10;

export type PushAnywayResult = {
  approved?: { id: string; rent_amount: number | null }[] | null;
  approved_total?: number | null;
  skipped?: { id: string; reason?: string | null; message?: string | null }[] | null;
};

export const PUSH_ANYWAY_WORDS: Record<string, string> = {
  COO_ONLY: 'Only the COO can push anyway.',
  REASON_REQUIRED: `Say why you are pushing with items missing (at least ${PUSH_ANYWAY_MIN} characters).`,
};

/** The server's reason codes, for a skipped row that comes without a message. */
const SKIP_WORDS: Record<string, string> = {
  not_in_coo_queue: 'No longer in the COO queue.',
  frozen: 'Agent is frozen. The freeze stays.',
};

export const skippedText = (s: { reason?: string | null; message?: string | null }): string =>
  s.message?.trim() || (s.reason ? SKIP_WORDS[s.reason] ?? s.reason : 'The server skipped this request.');

/**
 * Held only because items are missing: something is missing, and nothing else
 * keeps the row from the push (not frozen, no live hold, no serious concern,
 * no phone mismatch, not waiting for a level). The server checks the agent's
 * eligibility again at the push.
 */
export function isHeldForMissing(r: CooRow): boolean {
  const missing = (r.incomplete ?? []).filter(Boolean).length > 0;
  const liveHold = !!r.waiting && r.waiting.expired !== true;
  return missing && !r.frozen && !liveHold && r.concern_block !== true && r.phone_block !== true && r.demoted_awaiting !== true;
}

export function reasonProblem(reason: string): string | null {
  const n = reason.trim().length;
  if (n === 0) return 'A reason is required.';
  if (n < PUSH_ANYWAY_MIN) return `${PUSH_ANYWAY_MIN - n} more ${PUSH_ANYWAY_MIN - n === 1 ? 'character' : 'characters'} needed.`;
  return null;
}

export function PushAnywaySheet({ rows, onClose, onDone }: { rows: CooRow[]; onClose: () => void; onDone?: (pushedIds: string[]) => void }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PushAnywayResult | null>(null);
  const problem = reasonProblem(reason);
  const one = rows.length === 1;
  const title = one ? 'Push anyway' : `Push ${fmt('int', rows.length)} anyway`;
  const tenantOf = (id: string) => rows.find((r) => r.id === id)?.tenant ?? id;

  const push = async () => {
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const { data, error: e } = await rpc('coo_push_override', { p_ids: rows.map((r) => r.id), p_reason: reason.trim() });
    setBusy(false);
    if (e) return setError(plainError(e, PUSH_ANYWAY_WORDS));
    const r = (data ?? {}) as PushAnywayResult;
    setResult(r);
    const pushed = (r.approved ?? []).map((a) => a.id);
    onDone?.(pushed);
    void queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
    for (const id of pushed) void queryClient.invalidateQueries({ queryKey: cooOverrideKey(id) });
  };

  const pushed = result?.approved ?? [];
  const skipped = result?.skipped ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={title}>
      <button type="button" aria-label="Close" onClick={busy ? undefined : onClose} className="absolute inset-0 bg-black/60" />
      <div className="desk-root relative flex max-h-[85dvh] w-full max-w-lg flex-col overflow-hidden rounded-t-3xl border border-[var(--desk-line-color)] shadow-2xl sm:rounded-3xl">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--desk-line-color)] px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-foreground">{title}</h2>
            <p className={LABEL}>Pushes to the funders' board with these items still missing. The items and your reason are recorded. A frozen agent stays frozen.</p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className={`desk-pill border border-[var(--desk-line-color)] p-2 ${CALM} ${FOCUS} disabled:opacity-40`}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <ul className="min-h-0 flex-1 space-y-2 overflow-auto px-5 py-3 text-sm" style={{ margin: 0 }} data-push-anyway-list>
          {rows.map((r) => (
            <li key={r.id} data-push-anyway-row={r.id} style={{ listStyle: 'none' }}>
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span className="inline-flex min-w-0 items-center gap-2 text-foreground">
                  <GradeBadge grade={r.grade} />
                  <span className="font-medium" style={{ overflowWrap: 'anywhere' }}>{r.tenant ?? '—'}</span>
                  <span className={`${LABEL} font-mono`}>{r.req}</span>
                </span>
                <span className="tabular-nums text-foreground">UGX {fmt('ugxfull', r.rent)}</span>
              </span>
              <span className="block text-xs font-medium text-[hsl(var(--desk-bad))]" data-push-anyway-missing>
                {missingText(r.incomplete)}
              </span>
            </li>
          ))}
        </ul>
        <footer className="space-y-2 border-t border-[var(--desk-line-color)] px-5 py-4">
          {!result && (
            <label className="block space-y-1">
              <span className={LABEL}>Why push with items missing? (required{one ? '' : ', one reason for all'})</span>
              <textarea
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setError(null);
                }}
                rows={3}
                aria-label="Reason for pushing with items missing"
                aria-invalid={!!problem && reason.length > 0}
                className={`w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground ${FOCUS}`}
                data-push-anyway-reason
              />
              {problem && <span className={`block text-xs ${statusText.warn}`} data-push-anyway-hint>{problem}</span>}
            </label>
          )}
          {error && <ErrorLine>{error}</ErrorLine>}
          {result && (
            <div className="space-y-1" role="status" data-push-anyway-result>
              {pushed.length > 0 && (
                <p className={`text-sm ${statusText.ok}`} style={{ margin: 0 }}>
                  Pushed {fmt('int', pushed.length)} (UGX {fmt('ugxfull', result.approved_total ?? pushed.reduce((s, a) => s + (Number(a.rent_amount) || 0), 0))}) to the funders' board.
                </p>
              )}
              {skipped.map((s) => (
                <p key={s.id} className={`text-sm ${statusText.warn}`} style={{ margin: 0, overflowWrap: 'anywhere' }} data-push-anyway-skipped={s.id}>
                  {tenantOf(s.id)}: {skippedText(s)}
                </p>
              ))}
              {pushed.length === 0 && skipped.length === 0 && <p className="text-sm text-muted-foreground" style={{ margin: 0 }}>Nothing was pushed.</p>}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {result ? (
              <DecisionButton size="md" onClick={onClose}>
                Done
              </DecisionButton>
            ) : (
              <>
                <DecisionButton size="md" variant="primary" disabled={busy || !!problem} onClick={push} data-push-anyway-go>
                  {busy ? 'Pushing…' : title}
                </DecisionButton>
                <DecisionButton size="md" disabled={busy} onClick={onClose}>
                  Back
                </DecisionButton>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
