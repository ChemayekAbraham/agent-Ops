import { useMemo, useState } from 'react';
import { MoreHorizontal, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { fmt } from './format';
import { CALM, FOCUS, LABEL, PANEL, statusGlass, statusText } from './deskTheme';
import { Skeleton } from './Skeleton';
import { Pop } from './Pop';
import { GradeBadge } from './agentGrade';
import { DeskCallButton } from './deskCall';
import { readableError } from './reviewApi';
import { RETRY_LABEL, useReviewStatus } from './reviewStatus';
import { DECISION_LABEL, visibleDecisions, type Decision, type Stage } from './reviewTypes';
import { timeLeftText } from './waitOn';
import {
  GROUP_LABEL,
  PUSHABLE,
  boardKey,
  flagsChip,
  groupsFor,
  loadBoard,
  hoursUntil,
  moveFor,
  opensDrawer,
  ownerLabel,
  primaryLabel,
  pushRow,
  setSuggestedWait,
  triesToday,
  useDeskBoard,
  type BoardDecision,
  type BoardRow,
} from './boardApi';

/**
 * "Ready for your push" — one line per request, with the decision the desk's
 * rules already reached and one button that carries it out.
 *
 * Generic over the stage: Agent Ops today; Service Centre, Tenant and Landlord
 * Ops reuse it. A push is exactly the drawer's two calls
 * (`pipeline_record_review`, then `runMove`) with the server's `push` values;
 * anything other than the row's own decision goes through the drawer so a
 * reason code is asked.
 */

/** `call` opens the drawer with the call button ready. */
export type OpenDrawer = (requestId: string, initial?: Decision | 'wait' | 'call') => void;

const NEEDS_ROLE = 'Needs the employee role and a staff ID';

const BTN = `desk-pill whitespace-nowrap border px-3 py-1 text-xs font-medium ${CALM} ${FOCUS} disabled:cursor-not-allowed disabled:opacity-50`;
const BTN_PRIMARY = `${BTN} border-[hsl(var(--primary)/0.5)] bg-[hsl(var(--primary)/0.15)] text-foreground hover:bg-[hsl(var(--primary)/0.25)]`;
const BTN_QUIET = `${BTN} border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:bg-[var(--desk-surface-hover)] hover:text-foreground`;

/** Chip colour per decision group. */
function rowTone(d: BoardDecision): 'ok' | 'warn' | 'bad' | 'idle' {
  if (d === 'pass') return 'ok';
  if (d === 'reject') return 'bad';
  if (d === 'waiting') return 'idle';
  if (d === 'call' || d === 'complete') return 'idle';
  return 'warn';
}

type RowNote = { kind: 'ok' | 'bad' | 'retry'; text: string; snapshot?: BoardRow };

/** "7/12 done, 1 failed (reason)". */
export function progressText(p: { total: number; done: number; failed: { req: string; reason: string }[]; skipped: number }): string {
  const parts = [`${p.done}/${p.total} done`];
  if (p.failed.length) parts.push(`${p.failed.length} failed (${p.failed[0].reason})`);
  if (p.skipped) parts.push(`${p.skipped} skipped — decision changed`);
  return parts.join(', ');
}

function BoardRowLine({
  row,
  stage,
  canAct,
  board,
  note,
  busy,
  onPrimary,
  onRetry,
  onOpen,
}: {
  row: BoardRow;
  stage: Stage;
  canAct: boolean;
  board: boolean;
  note: RowNote | undefined;
  busy: boolean;
  onPrimary: () => void;
  onRetry: () => void;
  onOpen: OpenDrawer;
}) {
  const chip = flagsChip(row.flags);
  const label = primaryLabel(row, stage);
  const others = visibleDecisions(stage).filter((d) => d !== row.decision);
  const tries = triesToday(row.call);
  const text = board ? 'text-base' : 'text-sm';
  const w = row.waiting;

  return (
    <li className="space-y-1 border-t border-[var(--desk-line-color)] py-2.5 first:border-t-0">
      <div className={`flex flex-wrap items-center gap-x-2.5 gap-y-1.5 ${text}`}>
        <span className="min-w-0 font-medium text-foreground">{row.tenant ?? '—'}</span>
        <span className="text-muted-foreground" aria-hidden>·</span>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground">
          {row.agent ?? 'No agent'}
          <GradeBadge agentId={row.agent_id} grade={row.agent_grade} weekAgo={row.agent_grade_week_ago} />
          <DeskCallButton
            disabled={!canAct}
            target={{ requestId: row.id, desk: stage, subject: 'agent', calleeId: row.agent_id, name: row.agent, phone: row.agent_phone }}
          />
        </span>
        <span
          className={`desk-pill border px-2 py-0.5 text-[11px] ${chip.ok ? statusGlass.ok : statusGlass.warn}`}
          title={row.flags.flags.map((f) => `${f.ok ? '✓' : '✗'} ${f.label}${f.detail ? ` — ${f.detail}` : ''}`).join('\n')}
        >
          {chip.text}
        </span>
        <span className="tabular-nums text-foreground">UGX {fmt('ugxfull', row.rent)}</span>
        <span className="tabular-nums text-muted-foreground">{fmt('days', row.days_here)} d</span>
        {tries && <span className={`text-xs ${statusText.warn}`}>{tries}</span>}

        <span className="ml-auto inline-flex items-center gap-1.5">
          {row.decision === 'waiting' ? (
            <span className={`${LABEL} inline-flex items-center gap-1.5`}>
              Waiting on {ownerLabel(w?.owner_kind, stage)}
              {w && (w.expired || (hoursUntil(w.until_at) ?? 1) <= 0) ? (
                <span className={`desk-pill border px-2 py-0.5 text-[11px] font-semibold ${statusGlass.bad}`}>Time up</span>
              ) : (
                <span className="tabular-nums text-foreground">{timeLeftText(hoursUntil(w?.until_at))}</span>
              )}
            </span>
          ) : note?.kind === 'retry' ? (
            <button type="button" disabled={busy || !canAct} onClick={onRetry} className={`${BTN} ${statusGlass.warn}`} title={note.text}>
              {busy ? 'Retrying…' : 'Retry the move only'}
            </button>
          ) : (
            label && (
              <button
                type="button"
                disabled={busy || !canAct || note?.kind === 'ok'}
                onClick={onPrimary}
                title={canAct ? undefined : NEEDS_ROLE}
                className={row.decision === 'reject' ? `${BTN} ${statusGlass.bad}` : BTN_PRIMARY}
              >
                {busy ? 'Working…' : label}
              </button>
            )
          )}

          <Pop
            label={`More for ${row.tenant ?? 'this request'}`}
            align="right"
            trigger={<MoreHorizontal className="h-4 w-4" aria-hidden />}
            triggerClass={`desk-pill border border-[var(--desk-line-color)] bg-[var(--desk-surface)] p-1 text-muted-foreground ${CALM} ${FOCUS} hover:bg-[var(--desk-surface-hover)] hover:text-foreground`}
          >
            {(close) => (
              <span className="flex flex-col gap-1">
                <button type="button" className={`${BTN_QUIET} text-left`} onClick={() => { close(); onOpen(row.id); }}>
                  Open the review
                </button>
                <button
                  type="button"
                  disabled={!canAct}
                  title={canAct ? undefined : NEEDS_ROLE}
                  className={`${BTN_QUIET} text-left`}
                  onClick={() => { close(); onOpen(row.id, 'wait'); }}
                >
                  Wait on…
                </button>
                {others.map((d) => (
                  <button
                    key={d}
                    type="button"
                    disabled={!canAct}
                    title={canAct ? 'Opens the review so you can give a reason' : NEEDS_ROLE}
                    className={`${BTN_QUIET} text-left`}
                    onClick={() => { close(); onOpen(row.id, d); }}
                  >
                    {DECISION_LABEL[d]}…
                  </button>
                ))}
              </span>
            )}
          </Pop>
        </span>
      </div>

      {row.decision === 'waiting' && w?.note && (
        <p className={`${LABEL} max-w-4xl truncate`} title={w.note}>
          {w.rule_id && <span className="font-mono">{w.rule_id} </span>}
          {w.reason_code} · {w.note}
        </p>
      )}
      {(row.why || row.flags.notes.length > 0) && (
        <p className={`${LABEL} max-w-4xl`}>
          {row.rule_id && <span className="font-mono">{row.rule_id} </span>}
          {row.why}
          {row.flags.notes.length > 0 && <span className={statusText.warn}> · {row.flags.notes.join(' · ')}</span>}
        </p>
      )}
      {note && (
        <p className={`text-xs ${note.kind === 'ok' ? statusText.ok : note.kind === 'retry' ? statusText.warn : statusText.bad}`} role="status">
          {note.kind === 'retry' ? `${RETRY_LABEL}. ${note.text}` : note.text}
        </p>
      )}
    </li>
  );
}

/** The confirm sheet and the one-at-a-time run behind "Push all N". */
function PushAllSheet({
  stage,
  group,
  rows,
  onClose,
  onFailed,
}: {
  stage: Stage;
  group: BoardDecision;
  rows: BoardRow[];
  onClose: () => void;
  onFailed: (row: BoardRow, kind: 'move_failed' | 'review_failed', message: string) => void;
}) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [progress, setProgress] = useState({ total: rows.length, done: 0, failed: [] as { req: string; reason: string }[], skipped: 0 });

  const run = async () => {
    if (!user) return;
    setRunning(true);
    const p = { total: rows.length, done: 0, failed: [] as { req: string; reason: string }[], skipped: 0 };
    for (const planned of rows) {
      // Re-read the board before every row: someone else may have moved it, or its decision changed.
      let fresh: BoardRow | undefined;
      try {
        const b = await queryClient.fetchQuery({ queryKey: boardKey(stage), queryFn: () => loadBoard(stage), staleTime: 0 });
        fresh = b.rows.find((r) => r.id === planned.id);
      } catch (e) {
        p.failed.push({ req: planned.req, reason: readableError(e) });
        setProgress({ ...p, failed: [...p.failed] });
        continue;
      }
      if (!fresh || fresh.decision !== group || !fresh.push) {
        p.skipped += 1;
        setProgress({ ...p, failed: [...p.failed] });
        continue;
      }
      const out = await pushRow(fresh, stage, user.id);
      if (out.kind === 'moved') p.done += 1;
      else {
        p.failed.push({ req: fresh.req, reason: out.message });
        onFailed(fresh, out.kind, out.message);
      }
      setProgress({ ...p, failed: [...p.failed] });
    }
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
    setRunning(false);
    setFinished(true);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={`Push all ${GROUP_LABEL[group]}`}>
      <button type="button" aria-label="Close" onClick={running ? undefined : onClose} className="absolute inset-0 bg-black/60" />
      <div className="desk-root relative flex max-h-[85dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-[var(--desk-line-color)] shadow-2xl sm:rounded-3xl">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--desk-line-color)] px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-foreground">
              {GROUP_LABEL[group]} all {fmt('int', rows.length)}
            </h2>
            <p className={LABEL}>One at a time. Each row is re-checked first; a row whose decision changed is skipped. A failure never stops the rest.</p>
          </div>
          <button type="button" onClick={onClose} disabled={running} aria-label="Close" className={`desk-pill border border-[var(--desk-line-color)] p-2 ${CALM} ${FOCUS} disabled:opacity-40`}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <ol className="min-h-0 flex-1 space-y-1 overflow-auto px-5 py-3 text-sm">
          {rows.map((r) => {
            const failed = progress.failed.find((f) => f.req === r.req);
            return (
              <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-foreground">
                  {r.tenant ?? '—'} <span className="text-muted-foreground">· {r.agent ?? '—'} · UGX {fmt('ugxfull', r.rent)}</span>
                </span>
                <span className={failed ? statusText.bad : 'text-muted-foreground'}>{failed ? failed.reason : primaryLabel(r, stage)}</span>
              </li>
            );
          })}
        </ol>
        <footer className="space-y-2 border-t border-[var(--desk-line-color)] px-5 py-4">
          {(running || finished) && (
            <p className={`text-sm ${progress.failed.length ? statusText.warn : statusText.ok}`} role="status" aria-live="polite">
              {progressText(progress)}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {!finished ? (
              <button type="button" disabled={running} onClick={run} className={`${BTN} px-4 py-2 text-sm ${statusGlass.ok}`}>
                {running ? 'Pushing…' : `${GROUP_LABEL[group]} all ${fmt('int', rows.length)}`}
              </button>
            ) : (
              <button type="button" onClick={onClose} className={`${BTN_QUIET} px-4 py-2 text-sm`}>
                Done
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

export function ReadyBoard({ stage, board, onOpen }: { stage: Stage; board: boolean; onOpen: OpenDrawer }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { mark, clear } = useReviewStatus();
  const q = useDeskBoard(stage);
  const [only, setOnly] = useState<BoardDecision | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, RowNote>>({});
  const [pushAll, setPushAll] = useState<BoardDecision | null>(null);

  const data = q.data;
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => !only || r.decision === only), [data, only]);
  const canAct = data?.can_act === true;

  const setNote = (id: string, n: RowNote | null) =>
    setNotes((m) => {
      const next = { ...m };
      if (n) next[id] = n;
      else delete next[id];
      return next;
    });

  const failed = (row: BoardRow, kind: 'move_failed' | 'review_failed', message: string) => {
    if (kind === 'move_failed') {
      mark(row.id, { kind: 'move_failed', message, decision: row.push?.decision ?? row.decision });
      setNote(row.id, { kind: 'retry', text: message, snapshot: row });
    } else {
      setNote(row.id, { kind: 'bad', text: readableError({ message }) });
    }
  };

  const primary = async (row: BoardRow) => {
    if (!user) return;
    // Call first / finish the checks: the reviewer works in the drawer.
    if (opensDrawer(row.decision)) {
      onOpen(row.id, row.decision === 'call' ? 'call' : undefined);
      return;
    }
    // No push values: the drawer asks for what is missing.
    if (row.decision !== 'wait' && !row.push) {
      onOpen(row.id, row.decision === 'waiting' ? undefined : (row.decision as Decision));
      return;
    }
    setBusy(row.id);
    setNote(row.id, null);
    if (row.decision === 'wait') {
      const r = await setSuggestedWait(row, stage);
      setNote(row.id, { kind: r.ok ? 'ok' : 'bad', text: r.ok ? r.message : readableError({ message: r.message }) });
    } else {
      const out = await pushRow(row, stage, user.id);
      if (out.kind === 'moved') {
        clear(row.id);
        mark(row.id, { kind: 'moved', message: out.message });
        setNote(row.id, { kind: 'ok', text: out.message });
      } else failed(row, out.kind, out.message);
    }
    setBusy(null);
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
  };

  const retry = async (row: BoardRow) => {
    if (!user) return;
    const snap = notes[row.id]?.snapshot ?? row;
    setBusy(row.id);
    const moved = await moveFor(snap, stage, user.id);
    setBusy(null);
    if (!moved.ok) {
      setNote(row.id, { kind: 'retry', text: moved.message, snapshot: snap });
      return;
    }
    clear(row.id);
    mark(row.id, { kind: 'moved', message: moved.message });
    setNote(row.id, { kind: 'ok', text: moved.message });
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
  };

  if (q.isLoading) return <Skeleton className="h-48 w-full" />;
  if (q.error)
    return (
      <p className={`text-sm ${statusText.bad}`} role="alert">
        The board could not load: {readableError(q.error)}
      </p>
    );

  const counts = data?.counts ?? {};
  const countOf = (d: BoardDecision) =>
    counts[d] ?? (data?.rows ?? []).filter((r) => r.decision === d).length;
  const pushable = (d: BoardDecision) => (data?.rows ?? []).filter((r) => r.decision === d && !!r.push);

  return (
    <section className={`${PANEL} space-y-3 p-4 sm:p-5`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {groupsFor(stage).map((d) => {
          const n = countOf(d);
          const on = only === d;
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              onClick={() => setOnly(on ? null : d)}
              className={`desk-pill border px-3 py-1 text-xs ${CALM} ${FOCUS} ${on ? statusGlass[rowTone(d)] : 'border-[var(--desk-line-color)] bg-[var(--desk-surface)] text-muted-foreground hover:text-foreground'}`}
            >
              {GROUP_LABEL[d]} <span className="tabular-nums text-foreground">{fmt('int', n)}</span>
            </button>
          );
        })}
        {!canAct && <span className={`${LABEL} ${statusText.warn}`}>{NEEDS_ROLE} to act on this board.</span>}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {PUSHABLE.map((d) => {
          const list = pushable(d);
          if (list.length === 0) return null;
          return (
            <button
              key={d}
              type="button"
              disabled={!canAct}
              title={canAct ? undefined : NEEDS_ROLE}
              onClick={() => setPushAll(d)}
              className={BTN_QUIET}
            >
              Push all {fmt('int', list.length)} · {GROUP_LABEL[d]}
            </button>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{only ? `Nothing in ${GROUP_LABEL[only]}.` : 'Nothing is waiting at this desk.'}</p>
      ) : (
        <ul>
          {rows.map((r) => (
            <BoardRowLine
              key={r.id}
              row={r}
              stage={stage}
              canAct={canAct}
              board={board}
              note={notes[r.id]}
              busy={busy === r.id}
              onPrimary={() => void primary(r)}
              onRetry={() => void retry(r)}
              onOpen={onOpen}
            />
          ))}
        </ul>
      )}
      {(data?.rows.length ?? 0) >= 150 && <p className={LABEL}>Showing the first 150 requests.</p>}

      {pushAll && (
        <PushAllSheet
          stage={stage}
          group={pushAll}
          rows={pushable(pushAll)}
          onClose={() => setPushAll(null)}
          onFailed={failed}
        />
      )}
    </section>
  );
}

