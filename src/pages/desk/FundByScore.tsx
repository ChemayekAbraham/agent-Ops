import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fmt } from './format';
import { CALM, FIGURE, FOCUS, LABEL, PANEL, statusGlass, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';
import { readableError, rpc, useFundingPlan, useReasonCodes } from './reviewApi';
import { useReviewStatus } from './reviewStatus';

/**
 * Fund by score — the COO's batch.
 *
 * `pipeline_coo_funding_plan()` ranks every request waiting at the COO desk by
 * its score and walks the running total against the room left in the CFO float
 * budget, so the rows it marks `fund` are exactly the ones that fit today. They
 * start ticked; the COO can untick or add, and anything that was not the
 * system's choice needs a reason code before it goes through.
 *
 * Funding still happens through `coo_approve_rent_requests`, which is what
 * enforces the budget — this screen only chooses the batch and records a review
 * per request first.
 */

type PlanRow = {
  rent_request_id: string;
  tenant_name: string | null;
  agent_name: string | null;
  landlord_name: string | null;
  landlord_verified: boolean | null;
  rent_amount: number | null;
  waiting_days: number | null;
  score: number | null;
  confirmed_by_people_pct: number | null;
  failed: unknown;
  cumulative_ugx: number | null;
  room_ugx: number | null;
  recommendation: string | null;
  reason: string | null;
};

export function FundByScore({ board }: { board: boolean }) {
  const queryClient = useQueryClient();
  const { mark } = useReviewStatus();
  const plan = useFundingPlan(true);
  const reasons = useReasonCodes();

  const rows = useMemo(() => (plan.data ?? []) as unknown as PlanRow[], [plan.data]);
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [reasonCode, setReasonCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  // The system's choice is the starting point; a later refresh must not undo a
  // tick the COO has already made, so this only seeds rows it has not seen.
  useEffect(() => {
    setPicked((prev) => {
      const next = { ...prev };
      let changed = false;
      rows.forEach((r) => {
        if (!(r.rent_request_id in next)) {
          next[r.rent_request_id] = r.recommendation === 'fund';
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [rows]);

  const selected = useMemo(() => rows.filter((r) => picked[r.rent_request_id]), [rows, picked]);
  const selectedUgx = selected.reduce((t, r) => t + (Number(r.rent_amount) || 0), 0);
  const room = Number(rows[0]?.room_ugx ?? 0);
  const against = selected.filter((r) => r.recommendation !== 'fund');
  const needsReason = against.length > 0;
  const needsNote = needsReason && (reasonCode === 'OTHER' || reasonCode === 'RISK_JUDGEMENT');

  const blocked =
    selected.length === 0
      ? 'Tick at least one request.'
      : needsReason && !reasonCode
        ? `${against.length} of these are not the system's choice: choose a reason code.`
        : needsNote && note.trim().length < 10
          ? 'Write at least 10 characters explaining the decision.'
          : null;

  const fundSelected = async () => {
    setBusy(true);
    setError(null);
    setOutcome(null);
    const ids = selected.map((r) => r.rent_request_id);
    const recorded: string[] = [];

    try {
      // One review per request, then one funding call for the whole batch.
      for (const r of selected) {
        const followed = r.recommendation === 'fund';
        const { error: recErr } = await rpc('pipeline_record_review', {
          p_request_id: r.rent_request_id,
          p_stage: 'coo',
          p_results: [],
          p_decision: 'fund',
          p_reason_code: followed ? null : reasonCode,
          p_note: note.trim() || null,
          p_target_agent_id: null,
        });
        if (recErr) throw new Error(`${r.tenant_name ?? r.rent_request_id.slice(0, 8)}: ${recErr.message}`);
        recorded.push(r.rent_request_id);
      }

      const { data, error: fundErr } = await rpc('coo_approve_rent_requests', {
        p_request_ids: ids,
        p_comment: note.trim() || null,
      });
      if (fundErr) throw fundErr;

      const res = data as { approved?: string[]; skipped?: { rent_request_id?: string; message?: string }[] } | null;
      const approved = res?.approved ?? [];
      const skipped = res?.skipped ?? [];

      approved.forEach((id) => mark(String(id), { kind: 'moved', message: 'Approved and sent to the CFO.' }));
      skipped.forEach((s) => {
        if (s.rent_request_id) {
          mark(String(s.rent_request_id), {
            kind: 'move_failed',
            message: s.message ?? 'Not approved.',
            decision: 'fund',
          });
        }
      });

      if (approved.length === 0) {
        setError(
          `Review recorded — move failed, retry. ${skipped[0]?.message ?? 'Nothing was approved; check the float budget room.'}`,
        );
      } else {
        setOutcome(
          `${approved.length} request${approved.length === 1 ? '' : 's'} approved${skipped.length ? `, ${skipped.length} left behind` : ''}.`,
        );
        setPicked({});
      }
      queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
    } catch (e) {
      const where = recorded.length ? ` ${recorded.length} review${recorded.length === 1 ? '' : 's'} were already recorded.` : '';
      setError(`${readableError(e)}${where}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className={`${PANEL} space-y-4 p-4 sm:p-5`}>
      <div className="space-y-1">
        <h2 className={`${board ? 'text-lg' : 'text-base'} font-semibold text-foreground`}>Fund by score</h2>
        <p className="max-w-3xl text-xs leading-snug text-muted-foreground">
          Highest score first, as far as today&rsquo;s float budget reaches. The ticked rows are the system&rsquo;s choice. A
          request the landlord has not been verified for can never be funded.
        </p>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="desk-tile min-w-[9rem] space-y-1 p-3">
          <div className={LABEL}>Room left today</div>
          <div className={`${FIGURE} text-2xl`}>UGX {fmt('ugxfull', room)}</div>
        </div>
        <div className="desk-tile min-w-[9rem] space-y-1 p-3">
          <div className={LABEL}>Ticked</div>
          <div className={`${FIGURE} text-2xl`}>UGX {fmt('ugxfull', selectedUgx)}</div>
          <div className={LABEL}>{fmt('int', selected.length)} requests</div>
        </div>
      </div>

      {plan.isLoading && <Skeleton className="h-40 w-full" />}
      {plan.error && (
        <p className={`text-sm ${statusText.bad}`} role="alert">
          {readableError(plan.error)}
        </p>
      )}

      {!plan.isLoading && !plan.error && rows.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing is waiting for the COO decision.</p>
      )}

      {rows.length > 0 && (
        <div className="max-h-[32rem] overflow-auto rounded-xl border border-[var(--desk-line-color)]">
          <table className="w-full border-collapse text-sm tabular-nums">
            <thead className="desk-thead">
              <tr>
                {['', 'Tenant', 'Agent', 'Landlord', 'Score', 'Confirmed by people', 'Days waiting', 'Rent (UGX)', 'Running total', 'The system says'].map(
                  (h, i) => (
                    <th
                      key={h || `pick-${i}`}
                      scope="col"
                      className={`sticky top-0 z-10 border-b border-[var(--desk-line-color)] px-3 py-2 font-medium text-muted-foreground whitespace-nowrap ${
                        i >= 4 && i <= 8 ? 'text-right' : 'text-left'
                      }`}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const on = !!picked[r.rent_request_id];
                const rec = r.recommendation ?? '—';
                return (
                  <tr key={r.rent_request_id} className={`desk-row border-b border-[var(--desk-line-soft)] last:border-0 ${CALM}`}>
                    <td className="px-3 py-2 align-top">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={!r.landlord_verified}
                        onChange={(e) => setPicked((p) => ({ ...p, [r.rent_request_id]: e.target.checked }))}
                        aria-label={`Fund ${r.tenant_name ?? r.rent_request_id.slice(0, 8)}`}
                        className={`h-4 w-4 accent-[hsl(var(--primary))] ${FOCUS} disabled:opacity-40`}
                      />
                    </td>
                    <td className="px-3 py-2 align-top text-foreground">
                      {r.tenant_name ?? '—'}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">{r.rent_request_id.slice(0, 8)}</span>
                    </td>
                    <td className="px-3 py-2 align-top text-foreground">{r.agent_name ?? '—'}</td>
                    <td className="px-3 py-2 align-top text-foreground">
                      {r.landlord_name ?? '—'}
                      {!r.landlord_verified && <span className={`block text-xs ${statusText.bad}`}>not verified</span>}
                    </td>
                    <td className="px-3 py-2 text-right align-top text-foreground">{r.score ?? '—'}</td>
                    <td className="px-3 py-2 text-right align-top text-foreground">
                      {r.confirmed_by_people_pct === null ? '—' : `${Math.round(Number(r.confirmed_by_people_pct))}%`}
                    </td>
                    <td className="px-3 py-2 text-right align-top text-foreground">{fmt('days', r.waiting_days)}</td>
                    <td className="px-3 py-2 text-right align-top text-foreground">{fmt('ugxfull', r.rent_amount)}</td>
                    <td className="px-3 py-2 text-right align-top text-muted-foreground">{fmt('ugxfull', r.cumulative_ugx)}</td>
                    <td className="px-3 py-2 align-top">
                      <span
                        className={`desk-pill inline-block whitespace-nowrap border px-2.5 py-0.5 text-xs ${
                          rec === 'fund' ? statusGlass.ok : rec === 'return' ? statusGlass.bad : statusGlass.warn
                        }`}
                      >
                        {rec === 'fund' ? 'Fund' : rec === 'return' ? 'Return' : 'Hold'}
                      </span>
                      {r.reason && <span className={`${LABEL} mt-1 block max-w-[18rem]`}>{r.reason}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {needsReason && (
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <span className={LABEL}>
              {against.length} ticked {against.length === 1 ? 'request is' : 'requests are'} not the system&rsquo;s choice — why?
            </span>
            <select
              value={reasonCode}
              onChange={(e) => setReasonCode(e.target.value)}
              className={`desk-pill h-9 w-full border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 text-sm text-foreground ${FOCUS}`}
            >
              <option value="">Choose a reason code…</option>
              {(reasons.data ?? []).map((r) => (
                <option key={r.code} value={r.code}>
                  {r.code} — {r.meaning ?? ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className={LABEL}>Note{needsNote ? ' (at least 10 characters)' : ' (optional)'}</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className={`desk-pill h-9 w-full border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 text-sm text-foreground ${FOCUS}`}
            />
          </label>
        </div>
      )}

      {blocked && <p className={`text-sm ${statusText.warn}`}>{blocked}</p>}
      {error && (
        <p className={`text-sm ${statusText.bad}`} role="alert">
          {error}
        </p>
      )}
      {outcome && !error && <p className={`text-sm ${statusText.ok}`}>{outcome}</p>}

      <button
        type="button"
        disabled={!!blocked || busy}
        onClick={fundSelected}
        className={`desk-pill border px-4 py-2 text-sm font-medium ${CALM} ${FOCUS} ${
          !blocked && !busy ? statusGlass.ok : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground'
        } disabled:cursor-not-allowed`}
      >
        {busy ? 'Funding…' : `Fund selected (${fmt('int', selected.length)})`}
      </button>
    </section>
  );
}
