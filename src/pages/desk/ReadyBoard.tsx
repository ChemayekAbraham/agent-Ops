import { useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { fmt } from './format';
import { CALM, FOCUS, LABEL, PANEL, statusText } from './deskTheme';
import { Chip, DecisionButton, EmptyState, ErrorLine, LoadingRows, MenuItem, MoreMenu, Segmented, decisionVariant } from './ui';
import { GradeBadge } from './agentGrade';
import { DeskCallButton } from './deskCall';
import { readableError } from './reviewApi';
import { RETRY_LABEL, useReviewStatus } from './reviewStatus';
import { DECISION_LABEL, visibleDecisions, type Decision, type Stage } from './reviewTypes';
import { timeLeftText } from './waitOn';
import { TransferPicker } from './TransferPicker';
import { healthChip, useTenantHealthMany, type TenantHealth } from './paymentHealth';
import { ConcernsChip, useConcernsSummary, type ConcernSummary } from './concerns';
import {
  GROUP_LABEL,
  PUSHABLE,
  boardKey,
  boardLimit,
  flagsChip,
  groupsFor,
  loadBoard,
  hoursUntil,
  moveFor,
  opensDrawer,
  ownerLabel,
  primaryLabel,
  scopeLabels,
  scopeTotal,
  pushRow,
  setSuggestedWait,
  drawerStartFor,
  eligibilityChip,
  type WaitSuggest,
  triesToday,
  useDeskBoard,
  type BoardDecision,
  type BoardRow,
  type BoardScope,
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

/**
 * What the drawer opens on: a decision, "Wait on…", the call button ready
 * (`call`), the intake form (`complete`), or the photo review tab (`photos`).
 */
export type DrawerStart = Decision | 'wait' | 'call' | 'complete' | 'photos';

/** What the board already knows about the row, so the drawer need not ask again. */
export type DrawerContext = { itemsMissing?: string[] | null; waitSuggest?: WaitSuggest | null };

export type OpenDrawer = (requestId: string, initial?: DrawerStart, ctx?: DrawerContext) => void;

const NEEDS_ROLE = 'Needs the employee role and a staff ID';

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
  onPick,
  health,
  concerns,
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
  /** Agent Ops transfer rows: choose a different receiving agent. */
  onPick?: () => void;
  /** Tenant Ops: how the tenant has paid before. */
  health?: TenantHealth;
  /** Tenant/Landlord Ops: concerns any desk logged on this request. */
  concerns?: ConcernSummary;
}) {
  // Eligibility belongs to Agent Ops only; other desks never show it.
  const elig = stage === 'agent_ops' ? eligibilityChip(row.eligibility) : null;
  const hc = healthChip(health);
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
        {row.batch && (
          <span className="desk-pill border border-slate-500/40 bg-slate-500/20 px-2 py-0.5 text-[11px] text-muted-foreground">Aug batch</span>
        )}
        {hc && (
          <Chip tone={hc.tone} title={hc.title}>
            {hc.text}
          </Chip>
        )}
        <ConcernsChip summary={concerns} />
        <span className="text-muted-foreground" aria-hidden>·</span>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground">
          {row.agent ?? 'No agent'}
          <GradeBadge agentId={row.agent_id} grade={row.agent_grade} weekAgo={row.agent_grade_week_ago} />
          {elig && (
            <Chip tone={elig.tone}>{elig.text}</Chip>
          )}
          <DeskCallButton
            disabled={!canAct}
            target={{ requestId: row.id, desk: stage, subject: 'agent', calleeId: row.agent_id, name: row.agent, phone: row.agent_phone }}
          />
        </span>
        <Chip
          tone={chip.ok ? 'ok' : 'warn'}
          title={row.flags.flags.map((f) => `${f.ok ? '✓' : '✗'} ${f.label}${f.detail ? ` — ${f.detail}` : ''}`).join('\n')}
        >
          {chip.text}
        </Chip>
        <span className="tabular-nums text-foreground">UGX {fmt('ugxfull', row.rent)}</span>
        <span className="tabular-nums text-muted-foreground">{fmt('days', row.days_here)} d</span>
        {tries && <span className={`text-xs ${statusText.warn}`}>{tries}</span>}

        <span className="ml-auto inline-flex items-center gap-1.5">
          {row.decision === 'waiting' ? (
            <span className={`${LABEL} inline-flex items-center gap-1.5`}>
              Waiting on {ownerLabel(w?.owner_kind, stage)}
              {w && (w.expired || (hoursUntil(w.until_at) ?? 1) <= 0) ? (
                <Chip tone="bad" strong>
                  Time up
                </Chip>
              ) : (
                <span className="tabular-nums text-foreground">{timeLeftText(hoursUntil(w?.until_at))}</span>
              )}
            </span>
          ) : note?.kind === 'retry' ? (
            <DecisionButton variant="warn" disabled={busy || !canAct} onClick={onRetry} title={note.text}>
              {busy ? 'Retrying…' : 'Retry the move only'}
            </DecisionButton>
          ) : (
            label && (
              <DecisionButton
                variant={decisionVariant(row.decision)}
                disabled={busy || !canAct || note?.kind === 'ok'}
                onClick={onPrimary}
                title={canAct ? undefined : NEEDS_ROLE}
              >
                {busy ? 'Working…' : label}
              </DecisionButton>
            )
          )}
          <MoreMenu label={`More for ${row.tenant ?? 'this request'}`}>
            {(close) => (
              <>
                {/* Agent Ops transfer rows: a different receiving agent, same review and move. */}
                {row.decision === 'transfer' && row.push && onPick && note?.kind !== 'retry' && note?.kind !== 'ok' && (
                  <MenuItem disabled={busy || !canAct} title={canAct ? undefined : NEEDS_ROLE} onClick={() => { close(); onPick(); }}>
                    Pick another agent…
                  </MenuItem>
                )}
                <MenuItem onClick={() => { close(); onOpen(row.id); }}>Open the review</MenuItem>
                <MenuItem disabled={!canAct} title={canAct ? undefined : NEEDS_ROLE} onClick={() => { close(); onOpen(row.id, 'wait'); }}>
                  Wait on…
                </MenuItem>
                {others.map((d) => (
                  <MenuItem
                    key={d}
                    disabled={!canAct}
                    title={canAct ? 'Opens the review so you can give a reason' : NEEDS_ROLE}
                    onClick={() => { close(); onOpen(row.id, d); }}
                  >
                    {DECISION_LABEL[d]}…
                  </MenuItem>
                ))}
              </>
            )}
          </MoreMenu>
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
  scope,
  group,
  rows,
  onClose,
  onFailed,
}: {
  stage: Stage;
  scope: BoardScope;
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
        const b = await queryClient.fetchQuery({ queryKey: boardKey(stage, scope), queryFn: () => loadBoard(stage, scope), staleTime: 0 });
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
              <DecisionButton size="md" variant="ok" disabled={running} onClick={run}>
                {running ? 'Pushing…' : `${GROUP_LABEL[group]} all ${fmt('int', rows.length)}`}
              </DecisionButton>
            ) : (
              <DecisionButton size="md" onClick={onClose}>
                Done
              </DecisionButton>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

const SCOPES: BoardScope[] = ['new', 'batch', 'all'];
const scopeKey = (userId: string | null) => `desk:sc-scope:${userId ?? 'anon'}`;

function readScope(userId: string | null): BoardScope {
  try {
    const v = window.localStorage.getItem(scopeKey(userId));
    return v === 'batch' || v === 'all' || v === 'new' ? v : 'new';
  } catch {
    return 'new';
  }
}

/** The Service Centre's last scope, remembered per user on this device. Default New. */
function useScopeChoice(enabled: boolean, userId: string | null): [BoardScope, (s: BoardScope) => void] {
  const [scope, set] = useState<BoardScope>(() => (enabled ? readScope(userId) : 'new'));
  // The user id can arrive after the first render; read their choice once it does.
  useEffect(() => {
    if (enabled) set(readScope(userId));
  }, [enabled, userId]);
  const choose = (next: BoardScope) => {
    set(next);
    try {
      window.localStorage.setItem(scopeKey(userId), next);
    } catch {
      /* private window or blocked storage: the choice simply isn't remembered */
    }
  };
  return [scope, choose];
}

/** "Showing 300 of 3,580 — oldest first; push or wait some to see more", or null when everything is shown. */
export function limitNote(stage: Stage, scope: BoardScope, shown: number, counts: { new: number | null; batch: number | null } | null): string | null {
  const limit = boardLimit(stage);
  if (shown < limit) return null;
  const total = stage === 'service_centre' ? scopeTotal(scope, counts) : null;
  if (total !== null && total <= shown) return null;
  return `Showing ${shown.toLocaleString('en')} of ${total === null ? 'more' : total.toLocaleString('en')} — oldest first; push or wait some to see more`;
}

function ScopeSwitch({
  scope,
  counts,
  onChange,
}: {
  scope: BoardScope;
  counts: { new: number | null; batch: number | null } | null;
  onChange: (s: BoardScope) => void;
}) {
  const labels = scopeLabels(counts);
  return (
    <div role="radiogroup" aria-label="Which requests" className="inline-flex flex-wrap items-center gap-1 rounded-full border border-[var(--desk-line-color)] p-0.5">
      {SCOPES.map((s) => {
        const on = scope === s;
        return (
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(s)}
            className={`desk-pill px-3 py-1 text-xs ${CALM} ${FOCUS} ${
              on ? 'bg-[hsl(var(--primary)/0.2)] font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {labels[s]}
          </button>
        );
      })}
    </div>
  );
}

export function ReadyBoard({ stage, board, onOpen }: { stage: Stage; board: boolean; onOpen: OpenDrawer }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const { mark, clear } = useReviewStatus();
  const scoped = stage === 'service_centre';
  const [scope, setScope] = useScopeChoice(scoped, user?.id ?? null);
  const q = useDeskBoard(stage, true, scoped ? scope : undefined);
  const [only, setOnly] = useState<BoardDecision | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, RowNote>>({});
  const [pushAll, setPushAll] = useState<BoardDecision | null>(null);
  const [picker, setPicker] = useState<BoardRow | null>(null);

  const data = q.data;
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => !only || r.decision === only), [data, only]);
  const canAct = data?.can_act === true;
  // One batch call each per board load, for the desks that show them.
  const health = useTenantHealthMany((data?.rows ?? []).map((r) => r.tenant_id), stage === 'tenant_ops');
  const concerns = useConcernsSummary((data?.rows ?? []).map((r) => r.id), stage === 'tenant_ops' || stage === 'landlord_ops');

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
      onOpen(row.id, drawerStartFor(row.decision), { itemsMissing: row.items_missing ?? null, waitSuggest: row.wait_suggest });
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

  /** The suggested transfer's review and move, with the agent the reviewer picked. Returns an error, or null. */
  const pickTransfer = async (row: BoardRow, agentId: string, note: string): Promise<string | null> => {
    if (!user) return 'Sign in again.';
    setNote(row.id, null);
    const out = await pushRow(row, stage, user.id, { targetAgentId: agentId, note });
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
    if (out.kind === 'moved') {
      clear(row.id);
      mark(row.id, { kind: 'moved', message: out.message });
      setNote(row.id, { kind: 'ok', text: out.message });
      return null;
    }
    if (out.kind === 'move_failed') {
      // The review is in; retry only the move, to the agent that was picked.
      failed({ ...row, push: row.push ? { ...row.push, decision: 'transfer', target_agent_id: agentId, note } : row.push }, 'move_failed', out.message);
      return null;
    }
    return out.message;
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

  if (q.isLoading) return <LoadingRows rows={4} height={40} label="Loading the board" />;
  if (q.error) return <ErrorLine>The board could not load: {readableError(q.error)}</ErrorLine>;

  const counts = data?.counts ?? {};
  const countOf = (d: BoardDecision) =>
    counts[d] ?? (data?.rows ?? []).filter((r) => r.decision === d).length;
  const pushable = (d: BoardDecision) => (data?.rows ?? []).filter((r) => r.decision === d && !!r.push);

  return (
    <section className={`${PANEL} space-y-3 p-4 sm:p-5`}>
      {scoped && (
        <div className="flex flex-wrap items-center gap-2">
          <ScopeSwitch scope={scope} counts={data?.scope_counts ?? null} onChange={setScope} />
          {q.isPlaceholderData && <span className={LABEL} role="status">Loading…</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
        <Segmented<BoardDecision>
          ariaLabel="Show only"
          deselectable
          options={groupsFor(stage).map((d) => ({ value: d, label: GROUP_LABEL[d], count: countOf(d), tone: rowTone(d) }))}
          value={only}
          onChange={setOnly}
        />
        {!canAct && <span className={`${LABEL} ${statusText.warn}`}>{NEEDS_ROLE} to act on this board.</span>}
      </div>

      <div className="flex flex-wrap gap-1.5" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {PUSHABLE.map((d) => {
          const list = pushable(d);
          if (list.length === 0) return null;
          return (
            <DecisionButton key={d} disabled={!canAct || q.isPlaceholderData} title={canAct ? undefined : NEEDS_ROLE} onClick={() => setPushAll(d)}>
              Push all {fmt('int', list.length)} · {GROUP_LABEL[d]}
            </DecisionButton>
          );
        })}
      </div>

      {rows.length === 0 ? (
        <EmptyState>{only ? `Nothing in ${GROUP_LABEL[only]}.` : 'Nothing is waiting at this desk.'}</EmptyState>
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
              onPick={stage === 'agent_ops' ? () => setPicker(r) : undefined}
              health={r.tenant_id ? health.data?.[r.tenant_id] : undefined}
              concerns={concerns.data?.[r.id]}
            />
          ))}
        </ul>
      )}
      {limitNote(stage, scope, data?.rows.length ?? 0, data?.scope_counts ?? null) && (
        <p className={LABEL}>{limitNote(stage, scope, data?.rows.length ?? 0, data?.scope_counts ?? null)}</p>
      )}

      {picker && (
        <TransferPicker
          requestId={picker.id}
          tenant={picker.tenant}
          defaultNote={picker.push?.note ?? picker.why ?? ''}
          onClose={() => setPicker(null)}
          onConfirm={(agentId, note) => pickTransfer(picker, agentId, note)}
        />
      )}

      {pushAll && (
        <PushAllSheet
          stage={stage}
          scope={scope}
          group={pushAll}
          rows={pushable(pushAll)}
          onClose={() => setPushAll(null)}
          onFailed={failed}
        />
      )}
    </section>
  );
}

