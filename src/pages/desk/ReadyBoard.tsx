import { useCallback, useEffect, useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { fmt } from './format';
import { CALM, FOCUS, LABEL, PANEL, statusText } from './deskTheme';
import {
  Chip,
  DecisionButton,
  EmptyState,
  ErrorLine,
  LoadingRows,
  MenuItem,
  MoreMenu,
  RowCard,
  Segmented,
  atLeast,
  daysShort,
  decisionVariant,
  moneyCard,
  moneyFull,
  stackLayout,
  useBreakpoint,
} from './ui';
import { PHONE_PAGE, groupHeading, groupRows, rowChips, rowMeta, rowReason, shortPrimary, type ChipModel } from './boardRowModel';
import { GradeBadge } from './agentGrade';
import { DeskCallButton } from './deskCall';
import { readableError, rpc } from './reviewApi';
import { RETRY_LABEL, useReviewStatus } from './reviewStatus';
import { SENT_BACK_TO_AGENT, passMovesOnServer, passSentTo, rejectMovesOnServer } from './deskActions';
import { toast } from 'sonner';
import { KindChip } from './KindChip';
import { MissingLine, SendBackIncompleteSheet, hasMissing, missingText } from './incomplete';
import { DeskSearchBox, SearchResults, searchReady, type SearchDesk } from './deskSearch';
import { asIs } from './deskActions';
import { DECISION_LABEL, visibleDecisions, type Decision, type Stage } from './reviewTypes';
import { timeLeftText } from './waitOn';
import { TransferPicker } from './TransferPicker';
import { SUGGESTED_OFFICE, SendBackSheet, isSendBackRow } from './sendBack';
import { LandlordOpsCard } from './LandlordOpsCard';
import { NOT_ASSIGNED, isNotAssigned } from './deskAccess';
import { useTenantHealthMany, type TenantHealth } from './paymentHealth';
import { useConcernsSummary, type ConcernSummary } from './concerns';
import {
  GROUP_LABEL,
  PUSHABLE,
  afterServerPass,
  removeFromBoard,
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
export type DrawerStart = Decision | 'wait' | 'call' | 'complete' | 'photos' | 'concern';

/** What the board already knows about the row, so the drawer need not ask again. */
export type DrawerContext = {
  /** E82: what the request still misses; Pass says so and the server refuses it. */
  incomplete?: string[] | null;
  itemsMissing?: string[] | null;
  waitSuggest?: WaitSuggest | null;
  /** The board's word: an answered call to this desk's subject is already on file. */
  callAnswered?: boolean;
};

export type OpenDrawer = (requestId: string, initial?: DrawerStart, ctx?: DrawerContext) => void;

const NEEDS_ROLE = 'Needs the employee role and a staff ID';
/** E73: the picker's note for assigning an agent (the server wants 10+ characters); the reviewer can change it. */
export const ASSIGN_NOTE = 'Applied without an agent: assigned the nearest eligible agent';

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

/**
 * One board row, two shapes from one model (boardRowModel.ts):
 *   below md  a RowCard — tenant, agent + grade, three chips, "UGX · days",
 *             a short main button with its target on the line under it
 *   md and up a compact grid row — tenant | agent | chips | UGX | days | action,
 *             the action never wrapping
 */
function BoardRowLine({
  row,
  stage,
  canAct,
  board,
  layout,
  note,
  busy,
  onPrimary,
  onRetry,
  onOpen,
  onSendBackAgentOps,
  onPick,
  health,
  concerns,
}: {
  row: BoardRow;
  stage: Stage;
  canAct: boolean;
  board: boolean;
  /** card below md; md: two-line grid row, chips on the second line; lg: one six-column row. */
  layout: RowLayout;
  note: RowNote | undefined;
  busy: boolean;
  onPrimary: () => void;
  onRetry: () => void;
  onOpen: OpenDrawer;
  /** E82 / E89: "Send back…" for a row that misses something (Tenant / Landlord Ops). */
  onSendBackAgentOps?: () => void;
  /** Agent Ops transfer rows: choose a different receiving agent. */
  onPick?: () => void;
  /** Tenant / Landlord Ops: how the tenant has paid before. */
  health?: TenantHealth;
  /** Tenant / Landlord Ops and COO: concerns any desk logged on this request. */
  concerns?: ConcernSummary;
}) {
  const chips = rowChips(row, stage, health, concerns);
  const short = shortPrimary(row, stage);
  // E82: a pass on a row that misses something is refused by the server; say why on the button.
  const missingBlocks = hasMissing(row.incomplete) && row.decision === 'pass';
  const reason = rowReason(row);
  const others = visibleDecisions(stage).filter((d) => d !== row.decision);
  const w = row.waiting;
  const waitUp = !!w && (w.expired || (hoursUntil(w.until_at) ?? 1) <= 0);
  const waitingLine = row.decision === 'waiting' ? `Waiting on ${ownerLabel(w?.owner_kind, stage)} · ${waitUp ? 'Time up' : timeLeftText(hoursUntil(w?.until_at))}` : null;

  const call = (subject: 'agent' | 'tenant' | 'landlord') => (
    <DeskCallButton
      disabled={!canAct}
      target={
        subject === 'agent'
          ? { requestId: row.id, desk: stage, subject, calleeId: row.agent_id, name: row.agent, phone: row.agent_phone }
          : subject === 'tenant'
            ? { requestId: row.id, desk: stage, subject, calleeId: row.tenant_id, name: row.tenant, phone: row.tenant_phone }
            : { requestId: row.id, desk: stage, subject, calleeId: null, name: row.landlord, phone: row.landlord_phone }
      }
    />
  );

  const menu = (close: () => void) => (
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
        <MenuItem key={d} disabled={!canAct} title={canAct ? 'Opens the review so you can give a reason' : NEEDS_ROLE} onClick={() => { close(); onOpen(row.id, d); }}>
          {DECISION_LABEL[d]}…
        </MenuItem>
      ))}
    </>
  );

  // The main button: retry the move only, the row's decision, or nothing (waiting).
  const primary =
    note?.kind === 'retry'
      ? { label: busy ? 'Retrying…' : 'Retry the move only', onClick: onRetry, variant: 'warn' as const, disabled: busy || !canAct, title: note.text, detail: null }
      : short
        ? {
            label: busy ? 'Working…' : short.label,
            onClick: onPrimary,
            variant: decisionVariant(row.decision),
            disabled: busy || !canAct || note?.kind === 'ok' || missingBlocks,
            title: missingBlocks ? (missingText(row.incomplete) as string) : canAct ? reason.title : NEEDS_ROLE,
            detail: short.detail,
          }
        : null;

  const statusLine = note && (
    <p className={`text-xs ${note.kind === 'ok' ? statusText.ok : note.kind === 'retry' ? statusText.warn : statusText.bad}`} role="status">
      {note.kind === 'retry' ? `${RETRY_LABEL}. ${note.text}` : note.text}
    </p>
  );
  // E82: the missing list (and the shortcut) under the row, above any status note.
  const missingEl = hasMissing(row.incomplete) ? <MissingLine list={row.incomplete} onSendBack={onSendBackAgentOps} /> : null;
  const noteLine =
    missingEl || statusLine ? (
      <>
        {missingEl}
        {statusLine}
      </>
    ) : null;
  const chipEls = (list: ChipModel[]) => [
    ...(row.kind ? [<KindChip key="kind" kind={row.kind} />] : []),
    ...list.map((c) => (
      <Chip key={c.key} tone={c.tone} title={c.title} strong={c.strong}>
        {c.text}
      </Chip>
    )),
  ];

  const tenant = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{ overflowWrap: 'anywhere' }}>{row.tenant ?? '—'}</span>
      {/* Landlord Ops calls the tenant from the row; Tenant Ops calls through "Call tenant". */}
      {stage === 'landlord_ops' && call('tenant')}
    </span>
  );
  const agent = (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {stage === 'landlord_ops' && (
        <>
          <span>Landlord {row.landlord ?? '—'}</span>
          {call('landlord')}
        </>
      )}
      <span style={{ overflowWrap: 'anywhere' }}>{row.agent ?? 'No agent'}</span>
      <GradeBadge agentId={row.agent_id} grade={row.agent_grade} weekAgo={row.agent_grade_week_ago} />
      {call('agent')}
    </span>
  );
  const why = (
    <>
      {waitingLine && <span className={waitUp ? statusText.bad : undefined}>{waitingLine}{w?.note ? ` — ${w.note}` : ''}</span>}
      {!waitingLine && reason.text && <span title={reason.title}>{reason.text}</span>}
    </>
  );

  if (layout === 'card' && stage === 'landlord_ops') {
    return (
      <LandlordOpsCard
        row={row}
        stage={stage}
        canAct={canAct}
        board={board}
        primary={primary ? { label: primary.label, onClick: primary.onClick, variant: primary.variant, disabled: primary.disabled, title: primary.title } : null}
        health={health}
        onOpen={onOpen}
        extraMenu={(close) =>
          others
            .filter((d) => d !== 'send_back')
            .map((d) => (
              <MenuItem key={d} disabled={!canAct} title={canAct ? 'Opens the review so you can give a reason' : NEEDS_ROLE} onClick={() => { close(); onOpen(row.id, d); }}>
                {DECISION_LABEL[d]}…
              </MenuItem>
            ))
        }
        waitingLine={waitingLine ? <span className={waitUp ? statusText.bad : undefined}>{waitingLine}{w?.note ? ` — ${w.note}` : ''}</span> : null}
        noteLine={noteLine}
        needsRoleTitle={NEEDS_ROLE}
      />
    );
  }

  if (layout === 'card') {
    return (
      <li data-row={row.id} style={{ ...stackLayout(4), listStyle: 'none' }}>
        <RowCard
          board={board}
          title={tenant}
          subtitle={agent}
          chips={chipEls(chips)}
          meta={<span>{rowMeta(row)}</span>}
          why={why}
          primary={primary ?? undefined}
          menu={menu}
          menuLabel={`More for ${row.tenant ?? 'this request'}`}
        />
        {noteLine}
      </li>
    );
  }

  return (
    <li
      data-row={row.id}
      data-gridrow
      className={`border-t border-[var(--desk-line-color)] first:border-t-0 ${board ? 'text-base' : 'text-sm'}`}
      data-layout={layout}
      style={{ display: 'grid', gridTemplateColumns: layout === 'lg' ? GRID_COLUMNS : GRID_COLUMNS_MD, columnGap: 12, rowGap: 4, alignItems: 'center', paddingTop: 10, paddingBottom: 10, listStyle: 'none' }}
    >
      {layout === 'lg' ? (
        <>
          <span className="font-medium text-foreground" style={{ minWidth: 0 }}>{tenant}</span>
          <span className="text-foreground" style={{ minWidth: 0 }}>{agent}</span>
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>{chipEls(chips)}</span>
        </>
      ) : (
        <span style={{ ...stackLayout(2), minWidth: 0 }}>
          <span className="font-medium text-foreground">{tenant}</span>
          <span className="text-muted-foreground">{agent}</span>
        </span>
      )}
      <span className="tabular-nums text-foreground" style={{ textAlign: 'right', whiteSpace: 'nowrap' }} title={moneyFull(row.rent)}>
        {moneyCard(row.rent)}
      </span>
      <span className="tabular-nums text-muted-foreground" style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>{daysShort(row.days_here)}</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, whiteSpace: 'nowrap' }}>
        {primary && (
          <DecisionButton variant={primary.variant} disabled={primary.disabled} onClick={primary.onClick} title={primary.title}>
            {primary.label}
          </DecisionButton>
        )}
        <MoreMenu label={`More for ${row.tenant ?? 'this request'}`}>{menu}</MoreMenu>
      </span>
      {layout === 'md' && <div style={{ gridColumn: '1 / -1', display: 'flex', flexWrap: 'wrap', gap: 6, minWidth: 0 }}>{chipEls(chips)}</div>}
      <div className={LABEL} style={{ gridColumn: '1 / -1', minWidth: 0 }}>
        {primary?.detail && <span className="text-foreground">{short && row.decision === 'transfer' ? 'To ' : ''}{primary.detail}. </span>}
        {why}
      </div>
      {noteLine && <div style={{ gridColumn: '1 / -1' }}>{noteLine}</div>}
    </li>
  );
}

/** lg: tenant | agent | chips | UGX | days | action — the action column sizes to its button and never wraps. */
const GRID_COLUMNS = 'minmax(0, 1.2fr) minmax(0, 1.3fr) minmax(0, 2fr) 6.5rem 3.5rem max-content';
/** md: people | UGX | days | action, with the chips on a line of their own under it. */
const GRID_COLUMNS_MD = 'minmax(0, 1fr) 5.5rem 3rem max-content';

export type RowLayout = 'card' | 'md' | 'lg';

/** card below md (600), a two-line row from md, one row from lg (1024). */
export function rowLayoutFor(bp: import('./ui').Breakpoint): RowLayout {
  return !atLeast(bp, 'md') ? 'card' : atLeast(bp, 'lg') ? 'lg' : 'md';
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
    if (p.done > 0) {
      const where = group === 'pass' ? passSentTo(stage) : group === 'transfer' ? `Transferred. ${passSentTo('agent_ops')}` : SENT_BACK_TO_AGENT;
      toast.success(`${where}: ${p.done}`);
    }
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

/** Each stage board's own slug for desk_search: it searches only the requests at this desk. */
const STAGE_SEARCH: Partial<Record<Stage, SearchDesk>> = {
  service_centre: 'service-centre',
  agent_ops: 'agent-ops',
  tenant_ops: 'tenant-ops',
  landlord_ops: 'landlord-ops',
};

/**
 * The board, with its search box on top (E72). While a search is on, its
 * results replace the list (the list stays mounted, hidden, so its filters
 * and notes survive); a result opens the review drawer.
 */
export function ReadyBoard({ stage, board, onOpen }: { stage: Stage; board: boolean; onOpen: OpenDrawer }) {
  const slug = STAGE_SEARCH[stage];
  const [query, setQuery] = useState('');
  const searching = !!slug && query.trim().length > 0;
  if (!slug) return <BoardList stage={stage} board={board} onOpen={onOpen} />;
  return (
    <div style={stackLayout(12)}>
      <DeskSearchBox desk={slug} value={query} onChange={setQuery} />
      {searching && <SearchResults desk={slug} query={query} onOpen={(id) => onOpen(id)} />}
      <div hidden={searching}>
        <BoardList stage={stage} board={board} onOpen={onOpen} />
      </div>
    </div>
  );
}

function BoardList({ stage, board, onOpen }: { stage: Stage; board: boolean; onOpen: OpenDrawer }) {
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
  // The transfer picker: a suggested transfer's "Pick another agent…", or E73's "Assign agent".
  const [picker, setPicker] = useState<{ row: BoardRow; mode: 'transfer' | 'assign' } | null>(null);
  // E63: a suggested send-back opens the send-back sheet, prefilled with the server's suggestion.
  const [sendBack, setSendBack] = useState<{ row: BoardRow; to: 'suggested' } | null>(null);
  // E89: a row that misses something goes back to Agent Ops, the Service Centre or the agent.
  const [incompleteRow, setIncompleteRow] = useState<BoardRow | null>(null);
  const closeSendBack = useCallback(() => setSendBack(null), []);

  const data = q.data;
  // Every drawer opened from this board knows whether the row already has an answered call on file.
  const open: OpenDrawer = (id, start, ctx) => {
    const r = data?.rows.find((x) => x.id === id);
    onOpen(id, start, {
      ...(r?.call?.answered_since_stage ? { callAnswered: true } : {}),
      ...(hasMissing(r?.incomplete) ? { incomplete: r?.incomplete ?? null } : {}),
      ...ctx,
    });
  };
  const rows = useMemo(() => (data?.rows ?? []).filter((r) => !only || r.decision === only), [data, only]);
  const canAct = data?.can_act === true;
  // Below md each row is a card and the list pages 20 at a time.
  const bp = useBreakpoint();
  const layout = rowLayoutFor(bp);
  const card = layout === 'card';
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [only, scope]);
  const visible = card ? rows.slice(0, page * PHONE_PAGE) : rows;
  // One batch call each per board load, for the desks that show them.
  const health = useTenantHealthMany((data?.rows ?? []).map((r) => r.tenant_id), stage === 'tenant_ops' || stage === 'landlord_ops');
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
      // The server's own words, as-is.
      setNote(row.id, { kind: 'bad', text: message });
    }
  };

  const primary = async (row: BoardRow) => {
    if (!user) return;
    // Call first / finish the checks: the reviewer works in the drawer.
    if (opensDrawer(row.decision)) {
      open(row.id, drawerStartFor(row.decision), { itemsMissing: row.items_missing ?? null, waitSuggest: row.wait_suggest });
      return;
    }
    // E73: a tenant who applied alone: pick the agent from the nearby list, one transfer call.
    if (row.decision === 'assign_agent') {
      setPicker({ row, mode: 'assign' });
      return;
    }
    // Send back (E63), and the system's reject (E64): choose or confirm the office, reason and note, then one server call.
    if (isSendBackRow(row.decision, stage)) {
      setSendBack({ row, to: 'suggested' });
      return;
    }
    // No push values: the drawer asks for what is missing.
    if (row.decision !== 'wait' && !row.push) {
      open(row.id, row.decision === 'waiting' ? undefined : (row.decision as Decision));
      return;
    }
    setBusy(row.id);
    setNote(row.id, null);
    if (row.decision === 'wait') {
      const r = await setSuggestedWait(row, stage);
      setNote(row.id, { kind: r.ok ? 'ok' : 'bad', text: r.message });
      if (r.ok) toast.success(r.message);
    } else {
      const out = await pushRow(row, stage, user.id);
      // Moved by the server itself: a pass or reject at the middle desks, and a transfer (then pass).
      const d = row.push?.decision;
      const serverPass = !!d && (passMovesOnServer(stage, d) || rejectMovesOnServer(stage, d) || d === 'transfer');
      if (out.kind === 'moved' && serverPass) {
        // E64: the review moved it. The card goes; the toast says where.
        clear(row.id);
        mark(row.id, { kind: 'moved', message: out.message });
        afterServerPass(queryClient, stage, row.id, out.message);
        setBusy(null);
        return;
      }
      if (out.kind === 'moved') {
        clear(row.id);
        mark(row.id, { kind: 'moved', message: out.message });
        setNote(row.id, { kind: 'ok', text: out.message });
        toast.success(out.message);
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
    if (out.kind === 'moved') {
      clear(row.id);
      mark(row.id, { kind: 'moved', message: out.message });
      afterServerPass(queryClient, stage, row.id, out.message);
      return null;
    }
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
    if (out.kind === 'move_failed') {
      // The review is in; retry only the move, to the agent that was picked.
      failed({ ...row, push: row.push ? { ...row.push, decision: 'transfer', target_agent_id: agentId, note } : row.push }, 'move_failed', out.message);
      return null;
    }
    return out.message;
  };

  /**
   * E73: give a self-applied tenant an agent. One call, ops_transfer_pipeline_request_agent;
   * the row then comes back as an ordinary Agent Ops row. The server's refusal is shown as-is.
   */
  const assignAgent = async (row: BoardRow, agentId: string, note: string, name: string | null): Promise<string | null> => {
    const { error } = await rpc('ops_transfer_pipeline_request_agent', { p_request_id: row.id, p_to_agent_id: agentId, p_reason: note });
    if (error) return asIs(error);
    const message = `Agent assigned${name ? `: ${name}` : ''}`;
    setNote(row.id, { kind: 'ok', text: message });
    toast.success(message);
    void queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
    return null;
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
    toast.success(moved.message);
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
  };

  if (q.isLoading) return <LoadingRows rows={4} height={40} label="Loading the board" />;
  if (q.error)
    return isNotAssigned(q.error) ? (
      <ErrorLine>{NOT_ASSIGNED}</ErrorLine>
    ) : (
      <ErrorLine>The board could not load: {readableError(q.error)}</ErrorLine>
    );

  const counts = data?.counts ?? {};
  const countOf = (d: BoardDecision) =>
    counts[d] ?? (data?.rows ?? []).filter((r) => r.decision === d).length;
  // E82: a row that misses something is refused by the server, so "Push all" leaves it out.
  const pushable = (d: BoardDecision) => (data?.rows ?? []).filter((r) => r.decision === d && !!r.push && !hasMissing(r.incomplete));

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
        <div style={stackLayout(card ? 12 : 4)}>
          {groupRows(visible).map((g) => (
            <section key={g.decision} aria-label={`${groupHeading(g.decision, stage)} · ${g.rows.length}`}>
              {/* Sticky while its rows scroll past; below md it sits under the 56 px header bar. */}
              <h3
                data-group-head={g.decision}
                className="desk-sticky-head text-sm font-semibold text-foreground"
                style={{ position: 'sticky', top: card ? 56 : 0, zIndex: 5, margin: card ? '0 -6px 8px' : '0 0 4px', padding: card ? '8px 6px' : '6px 0' }}
              >
                {g.decision === 'assign_agent'
                  ? `${groupHeading(g.decision, stage)} (${fmt('int', rows.filter((r) => r.decision === g.decision).length)})`
                  : `${groupHeading(g.decision, stage)} · ${fmt('int', rows.filter((r) => r.decision === g.decision).length)}`}
              </h3>
              <ul style={{ ...stackLayout(card ? 12 : 0), margin: 0, padding: 0 }}>
                {g.rows.map((r) => (
                  <BoardRowLine
                    key={r.id}
                    row={r}
                    stage={stage}
                    canAct={canAct}
                    board={board}
                    layout={layout}
                    note={notes[r.id]}
                    busy={busy === r.id}
                    onPrimary={() => void primary(r)}
                    onRetry={() => void retry(r)}
                    onOpen={open}
                    onSendBackAgentOps={
                      (stage === 'tenant_ops' || stage === 'landlord_ops') && hasMissing(r.incomplete) ? () => setIncompleteRow(r) : undefined
                    }
                    onPick={stage === 'agent_ops' ? () => setPicker({ row: r, mode: 'transfer' }) : undefined}
                    health={r.tenant_id ? health.data?.[r.tenant_id] : undefined}
                    concerns={concerns.data?.[r.id]}
                  />
                ))}
              </ul>
            </section>
          ))}
          {card && visible.length < rows.length && (
            <div>
              <DecisionButton variant="quiet" size="md" onClick={() => setPage((n) => n + 1)} style={{ width: '100%' }}>
                Show {fmt('int', Math.min(PHONE_PAGE, rows.length - visible.length))} more
              </DecisionButton>
            </div>
          )}
        </div>
      )}
      {limitNote(stage, scope, data?.rows.length ?? 0, data?.scope_counts ?? null) && (
        <p className={LABEL}>{limitNote(stage, scope, data?.rows.length ?? 0, data?.scope_counts ?? null)}</p>
      )}

      {picker && (
        <TransferPicker
          requestId={picker.row.id}
          tenant={picker.row.tenant}
          mode={picker.mode}
          defaultNote={picker.mode === 'assign' ? ASSIGN_NOTE : picker.row.push?.note ?? picker.row.why ?? ''}
          onClose={() => setPicker(null)}
          onConfirm={(agentId, note, name) =>
            picker.mode === 'assign' ? assignAgent(picker.row, agentId, note, name) : pickTransfer(picker.row, agentId, note)
          }
        />
      )}

      {sendBack && (
        <SendBackSheet
          requestId={sendBack.row.id}
          stage={stage}
          tenant={sendBack.row.tenant}
          initial={{ to: SUGGESTED_OFFICE, reasonCode: sendBack.row.push?.reason_code ?? null, note: sendBack.row.push?.note ?? sendBack.row.why ?? null }}
          onDone={(message) => {
            clear(sendBack.row.id);
            mark(sendBack.row.id, { kind: 'moved', message });
            setNote(sendBack.row.id, { kind: 'ok', text: message });
          }}
          onClose={closeSendBack}
        />
      )}

      {incompleteRow && (
        <SendBackIncompleteSheet
          requestId={incompleteRow.id}
          tenant={incompleteRow.tenant}
          missing={incompleteRow.incomplete}
          onDone={(message) => {
            clear(incompleteRow.id);
            mark(incompleteRow.id, { kind: 'moved', message });
            removeFromBoard(queryClient, stage, incompleteRow.id);
          }}
          onClose={() => setIncompleteRow(null)}
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

