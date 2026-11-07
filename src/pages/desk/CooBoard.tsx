import { useMemo, useState } from 'react';
import { X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fmt } from './format';
import { CALM, FOCUS, LABEL, PANEL, statusGlass, statusText } from './deskTheme';
import { Chip, DecisionButton, EmptyState, ErrorLine, GradeBadge, LoadingRows, MenuItem, MoreMenu, rowLayout } from './ui';
import { readableError, rpc } from './reviewApi';
import { hoursUntil, ownerLabel, type BoardWaiting } from './boardApi';
import { timeLeftText } from './waitOn';
import type { OpenDrawer } from './ReadyBoard';
import { NOT_ASSIGNED, isNotAssigned } from './deskAccess';
import { ConcernsChip, useConcernsSummary, type ConcernSummary } from './concerns';

/**
 * The COO's "Ready for your push": approved requests graded A–D from the three
 * desks' ratings, in rank order. "Push top N to funders" sends the best N to
 * the funders' dashboard in one server call (`coo_push_to_funders`), which
 * replaced funding against a daily budget (retired 5 Nov).
 *
 * The board's `room`, `budget_set` and `fits_room` fields belong to the
 * retired budget and are not read.
 */

export type CooRatings = {
  agent_ops: number | null;
  tenant_ops: number | null;
  landlord_ops: number | null;
  average: number | null;
  grade: string | null;
  partly_rated: boolean;
};

export type CooRow = {
  id: string;
  req: string;
  tenant: string | null;
  agent: string | null;
  agent_grade: string | null;
  landlord: string | null;
  landlord_verified: boolean | null;
  rent: number | null;
  days_here: number | null;
  ratings: CooRatings | null;
  grade: string | null;
  avg: number | null;
  flags: { passes: number; total: number; failing: string[] } | null;
  auto_forwarded: boolean | null;
  waiting: BoardWaiting | null;
  rank: number | null;
  /** False when the server will not push this row (frozen, on hold, …). */
  pushable?: boolean | null;
  /** Frozen rows go back to Agent Ops on the given date; they are never pushed. */
  frozen?: { reason: string | null; since: string | null; returns_to_agent_ops_at: string | null } | null;
};

export type CooCounts = { A?: number; B?: number; C?: number; D?: number; unrated?: number; waiting?: number; pushable?: number; frozen?: number };

export type CooBoardData = { counts: CooCounts; can_push: boolean; rows: CooRow[] };

export type PushResult = {
  requested: number;
  picked: number;
  picked_list: { id: string; rank: number | null; grade: string | null; avg: number | null; rent: number | null }[];
  approved: { id: string; rent_amount: number | null }[];
  approved_total: number | null;
  skipped: { id: string; reason?: string | null; message?: string | null }[];
};

/** What `coo_push_selected` returns for a one-row push (no `picked_list`). */
export type PushSelectedResult = {
  requested: number;
  approved: { id: string; rent_amount: number | null }[];
  approved_total: number | null;
  skipped: { id: string; reason?: string | null; message?: string | null }[];
};

export const COO_PUSH_DEFAULT = 10;
const NEEDS_COO = 'Needs the COO role and a staff ID';

/**
 * "38 pushable · 75 frozen · A 20 · B 40 · C 30 · D 23" once the board counts
 * pushable and frozen rows; "113 waiting · A 20 · …" before it did. Unrated and
 * on hold are added when there are any.
 */
export function cooTopLine(c: CooCounts): string {
  const n = (k: keyof CooCounts) => Number(c[k] ?? 0);
  const total = n('A') + n('B') + n('C') + n('D') + n('unrated');
  const head =
    c.pushable !== undefined && c.pushable !== null
      ? [`${fmt('int', n('pushable'))} pushable`, `${fmt('int', n('frozen'))} frozen`]
      : [`${fmt('int', total)} waiting`];
  const parts = [...head, `A ${fmt('int', n('A'))}`, `B ${fmt('int', n('B'))}`, `C ${fmt('int', n('C'))}`, `D ${fmt('int', n('D'))}`];
  if (n('unrated') > 0) parts.push(`${fmt('int', n('unrated'))} unrated`);
  if (n('waiting') > 0) parts.push(`${fmt('int', n('waiting'))} on hold`);
  return parts.join(' · ');
}

/** "A 20 · B 40 · C 30 · D 23", plus unrated / on hold when there are any. */
export function cooGradeLine(c: CooCounts): string {
  const n = (k: keyof CooCounts) => Number(c[k] ?? 0);
  const parts = [`A ${fmt('int', n('A'))}`, `B ${fmt('int', n('B'))}`, `C ${fmt('int', n('C'))}`, `D ${fmt('int', n('D'))}`];
  if (n('unrated') > 0) parts.push(`${fmt('int', n('unrated'))} unrated`);
  if (n('waiting') > 0) parts.push(`${fmt('int', n('waiting'))} on hold`);
  return parts.join(' · ');
}

/**
 * The board's top line. Once the server counts pushable and frozen rows they
 * lead as chips; before that it reads "113 waiting · A 20 · …" as text.
 */
function CooTopLine({ counts, board }: { counts: CooCounts; board: boolean }) {
  const size = board ? 'text-lg' : 'text-base';
  if (counts.pushable === undefined || counts.pushable === null) {
    return <p className={`${size} font-medium text-foreground`}>{cooTopLine(counts)}</p>;
  }
  return (
    <div style={rowLayout(8)} aria-label={cooTopLine(counts)}>
      <Chip size="sm" tone="ok" strong>
        {fmt('int', counts.pushable)} pushable
      </Chip>
      <Chip size="sm" tone="idle">
        {fmt('int', counts.frozen ?? 0)} frozen
      </Chip>
      <span className={`${size} font-medium text-foreground`}>{cooGradeLine(counts)}</span>
    </div>
  );
}

/** Rank order, best first. */
export function byRank(rows: CooRow[]): CooRow[] {
  return [...rows].sort((a, b) => (a.rank ?? Number.POSITIVE_INFINITY) - (b.rank ?? Number.POSITIVE_INFINITY));
}

/** True when the server would push this row: not frozen, not on hold, not marked unpushable. */
export function isPushable(r: CooRow): boolean {
  return !r.waiting && !r.frozen && r.pushable !== false;
}

/** What "Push top N" would send, as the confirm sheet lists it: the best N pushable rows, and their total rent. */
export function pushPlan(rows: CooRow[], n: number): { rows: CooRow[]; totalUgx: number } {
  const picked = byRank(rows).filter(isPushable).slice(0, Math.max(0, Math.floor(n)));
  return { rows: picked, totalUgx: picked.reduce((t, r) => t + (Number(r.rent) || 0), 0) };
}

/** "Pushed n (UGX x) to the funders' dashboard; skipped m (reasons)". */
export function pushResultLine(r: PushResult): string {
  const pushed = r.approved?.length ?? 0;
  const total = r.approved_total ?? (r.approved ?? []).reduce((t, a) => t + (Number(a.rent_amount) || 0), 0);
  const skipped = r.skipped ?? [];
  const reasons = Array.from(new Set(skipped.map((s) => s.reason || s.message || 'no reason given')));
  const tail = skipped.length ? `; skipped ${fmt('int', skipped.length)} (${reasons.join(', ')})` : '; skipped 0';
  return `Pushed ${fmt('int', pushed)} (${fmt('ugx', total)}) to the funders' dashboard${tail}`;
}

const cooBoardKey = ['desk-feed', 'coo-board'];

export function useCooBoard(enabled = true) {
  return useQuery({
    queryKey: cooBoardKey,
    enabled,
    queryFn: async (): Promise<CooBoardData> => {
      const { data, error } = await rpc('pipeline_coo_board', {});
      if (error) throw error;
      const b = (data ?? {}) as Partial<CooBoardData>;
      return { counts: b.counts ?? {}, can_push: b.can_push === true, rows: Array.isArray(b.rows) ? b.rows : [] };
    },
    refetchInterval: 60_000,
    staleTime: 20_000,
    retry: 1,
  });
}

const rating = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(Math.round(Number(v))));

/** "12 Nov", in Kampala time. */
const dayMonth = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Kampala' }) : 'a date not set';

/** "Frozen — <reason>; back to Agent Ops on 12 Nov". */
export function frozenText(f: NonNullable<CooRow['frozen']>): string {
  return `Frozen — ${f.reason ?? 'no reason given'}; back to Agent Ops on ${dayMonth(f.returns_to_agent_ops_at)}`;
}

function CooRowLine({
  row,
  board,
  onOpen,
  onPush,
  concerns,
}: {
  row: CooRow;
  board: boolean;
  onOpen: OpenDrawer;
  onPush: (row: CooRow) => void;
  /** Concerns any desk logged on this request. */
  concerns?: ConcernSummary;
}) {
  const r = row.ratings;
  const w = row.waiting;
  const frozen = row.frozen;
  return (
    <li
      data-frozen={frozen ? 'true' : undefined}
      className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-[var(--desk-line-color)] py-2 first:border-t-0 ${board ? 'text-base' : 'text-sm'} ${
        frozen ? 'opacity-60' : ''
      }`}
    >
      <span className={`${LABEL} w-7 text-right tabular-nums`}>{row.rank ?? '—'}</span>
      <GradeBadge grade={row.grade} />
      <span className="min-w-0 font-medium text-foreground">{row.tenant ?? '—'}</span>
      <span className={`${LABEL} font-mono`}>{row.req}</span>
      <ConcernsChip summary={concerns} />
      <span className="tabular-nums text-foreground" title="Agent Ops · Tenant Ops · Landlord Ops ratings">
        AO {rating(r?.agent_ops)} · TO {rating(r?.tenant_ops)} · LO {rating(r?.landlord_ops)}
      </span>
      {r?.partly_rated && <span className="text-xs text-muted-foreground">partly rated</span>}
      <span className="tabular-nums text-muted-foreground">{fmt('days', row.days_here)} d</span>
      <span className="tabular-nums text-foreground">UGX {fmt('ugxfull', row.rent)}</span>
      {frozen && <Chip tone="idle">{frozenText(frozen)}</Chip>}
      {w && (
        <span className={`${LABEL} inline-flex items-center gap-1`} title={w.note ?? undefined}>
          On hold for {ownerLabel(w.owner_kind, 'coo')} ·{' '}
          {w.expired || (hoursUntil(w.until_at) ?? 1) <= 0 ? <span className={statusText.bad}>Time up</span> : timeLeftText(hoursUntil(w.until_at))}
        </span>
      )}
      <span className="ml-auto inline-flex items-center gap-2">
        {isPushable(row) && (
          <DecisionButton variant="primary" onClick={() => onPush(row)}>
            Push to funders
          </DecisionButton>
        )}
        <MoreMenu label={`More for ${row.tenant ?? 'this request'}`}>
          {(close) => (
            <>
              <MenuItem onClick={() => { close(); onOpen(row.id); }}>Open the review</MenuItem>
              <MenuItem onClick={() => { close(); onOpen(row.id, 'wait'); }}>Hold (Wait on…)</MenuItem>
              <MenuItem onClick={() => { close(); onOpen(row.id, 'send_back'); }}>Send back…</MenuItem>
            </>
          )}
        </MoreMenu>
      </span>
    </li>
  );
}

/**
 * The one-row confirm: tenant, grade and rent, then `coo_push_selected` with
 * just that id. A skipped row shows the server's reason as-is; a pushed row
 * says so in one line. Either way the board refetches on close.
 */
function RowPushConfirm({ row, onClose }: { row: CooRow; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const push = async () => {
    setBusy(true);
    setError(null);
    const { data, error: e } = await rpc('coo_push_selected', { p_ids: [row.id], p_comment: null });
    setBusy(false);
    if (e) {
      setError(readableError(e));
      return;
    }
    const r = (data ?? {}) as Partial<PushSelectedResult>;
    const skipped = r.skipped ?? [];
    const pushed = r.approved?.length ?? 0;
    if (pushed > 0) {
      setResult({ ok: true, text: "Pushed to the funders' dashboard" });
    } else {
      const reasons = skipped.map((s) => s.message || s.reason || 'no reason given');
      setResult({ ok: false, text: reasons.join('; ') || 'The server skipped this request.' });
    }
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={`Push ${row.tenant ?? 'this request'} to funders`}>
      <button type="button" aria-label="Close" onClick={busy ? undefined : onClose} className="absolute inset-0 bg-black/60" />
      <div className="desk-root relative w-full max-w-md rounded-t-3xl border border-[var(--desk-line-color)] shadow-2xl sm:rounded-3xl">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--desk-line-color)] px-5 py-4">
          <h2 className="text-lg font-semibold text-foreground">Push to funders</h2>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className={`desk-pill border border-[var(--desk-line-color)] p-2 ${CALM} ${FOCUS} disabled:opacity-40`}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="space-y-2 px-5 py-4 text-sm">
          <p className="flex flex-wrap items-center gap-2 text-foreground">
            <GradeBadge grade={row.grade} />
            <span className="font-medium">{row.tenant ?? '—'}</span>
            <span className={`${LABEL} font-mono`}>{row.req}</span>
          </p>
          <p className="tabular-nums text-foreground">UGX {fmt('ugxfull', row.rent)}</p>
          {error && <ErrorLine>{error}</ErrorLine>}
          {result && (
            <p className={`text-sm ${result.ok ? statusText.ok : statusText.warn}`} role="status">
              {result.text}
            </p>
          )}
        </div>
        <footer className="flex flex-wrap gap-2 border-t border-[var(--desk-line-color)] px-5 py-4">
          {result ? (
            <DecisionButton size="md" onClick={onClose}>
              Done
            </DecisionButton>
          ) : (
            <>
              <DecisionButton size="md" variant="primary" disabled={busy} onClick={push}>
                {busy ? 'Pushing…' : 'Push to funders'}
              </DecisionButton>
              <DecisionButton size="md" disabled={busy} onClick={onClose}>
                Back
              </DecisionButton>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function PushSheet({ plan, n, onClose }: { plan: { rows: CooRow[]; totalUgx: number }; n: number; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const push = async () => {
    setBusy(true);
    setError(null);
    const { data, error: e } = await rpc('coo_push_to_funders', { p_n: n, p_comment: comment.trim() || null });
    setBusy(false);
    if (e) {
      setError(readableError(e));
      return;
    }
    setResult(pushResultLine((data ?? {}) as PushResult));
    queryClient.invalidateQueries({ queryKey: ['desk-feed'] });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="dialog" aria-modal="true" aria-label={`Push top ${n} to funders`}>
      <button type="button" aria-label="Close" onClick={busy ? undefined : onClose} className="absolute inset-0 bg-black/60" />
      <div className="desk-root relative flex max-h-[85dvh] w-full max-w-2xl flex-col overflow-hidden rounded-t-3xl border border-[var(--desk-line-color)] shadow-2xl sm:rounded-3xl">
        <header className="flex items-start justify-between gap-3 border-b border-[var(--desk-line-color)] px-5 py-4">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-foreground">Push top {fmt('int', n)} to funders</h2>
            <p className={LABEL}>
              {fmt('int', plan.rows.length)} requests · UGX {fmt('ugxfull', plan.totalUgx)}. The server picks again at the moment of the push, best first, and says what it skipped.
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className={`desk-pill border border-[var(--desk-line-color)] p-2 ${CALM} ${FOCUS} disabled:opacity-40`}>
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <ol className="min-h-0 flex-1 space-y-1 overflow-auto px-5 py-3 text-sm">
          {plan.rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-2 text-foreground">
                <span className={`${LABEL} w-6 text-right`}>{r.rank ?? '—'}</span>
                <GradeBadge grade={r.grade} />
                {r.tenant ?? '—'}
              </span>
              <span className="tabular-nums text-foreground">UGX {fmt('ugxfull', r.rent)}</span>
            </li>
          ))}
        </ol>
        <footer className="space-y-2 border-t border-[var(--desk-line-color)] px-5 py-4">
          {!result && (
            <label className="block space-y-1">
              <span className={LABEL}>Comment (optional)</span>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                className={`w-full rounded-xl border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-3 py-2 text-sm text-foreground ${FOCUS}`}
              />
            </label>
          )}
          {error && <ErrorLine>{error}</ErrorLine>}
          {result && <p className={`text-sm ${statusText.ok}`} role="status">{result}</p>}
          <div className="flex flex-wrap gap-2">
            {result ? (
              <DecisionButton size="md" onClick={onClose}>
                Done
              </DecisionButton>
            ) : (
              <DecisionButton size="md" variant="ok" disabled={busy || plan.rows.length === 0} onClick={push}>
                {busy ? 'Pushing…' : `Push ${fmt('int', n)} to funders`}
              </DecisionButton>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}

export function CooBoard({ board, onOpen }: { board: boolean; onOpen: OpenDrawer }) {
  const q = useCooBoard();
  const [n, setN] = useState(COO_PUSH_DEFAULT);
  const [confirm, setConfirm] = useState(false);
  const [pushRow, setPushRow] = useState<CooRow | null>(null);
  const rows = useMemo(() => byRank(q.data?.rows ?? []), [q.data]);
  const plan = useMemo(() => pushPlan(rows, n), [rows, n]);
  // One batch call per board load: the concerns logged on every row.
  const concerns = useConcernsSummary(rows.map((r) => r.id));

  if (q.isLoading) return <LoadingRows rows={4} height={40} label="Loading the COO board" />;
  if (q.error)
    return isNotAssigned(q.error) ? (
      <ErrorLine>{NOT_ASSIGNED}</ErrorLine>
    ) : (
      <ErrorLine>The COO board could not load: {readableError(q.error)}</ErrorLine>
    );

  const canPush = q.data?.can_push === true;
  const valid = Number.isFinite(n) && n >= 1;

  return (
    <section className={`${PANEL} space-y-3 p-4 sm:p-5`}>
      <CooTopLine counts={q.data?.counts ?? {}} board={board} />

      <div className="flex flex-wrap items-center gap-2">
        <label className="inline-flex items-center gap-1.5 text-sm text-foreground">
          Push top
          <input
            type="number"
            inputMode="numeric"
            min={1}
            max={Math.max(1, rows.filter(isPushable).length)}
            value={Number.isFinite(n) ? n : ''}
            onChange={(e) => setN(e.target.value === '' ? Number.NaN : Number(e.target.value))}
            className={`desk-pill h-8 w-16 border border-[var(--desk-line-color)] bg-[var(--desk-surface)] px-2 text-sm text-foreground ${FOCUS}`}
            aria-label="How many to push"
          />
          to funders
        </label>
        <DecisionButton
          variant="primary"
          size="md"
          disabled={!canPush || !valid || plan.rows.length === 0}
          title={canPush ? undefined : NEEDS_COO}
          onClick={() => setConfirm(true)}
        >
          Push top {valid ? fmt('int', n) : '…'} to funders
        </DecisionButton>
        {!canPush && <span className={`${LABEL} ${statusText.warn}`}>{NEEDS_COO}.</span>}
      </div>

      {rows.length === 0 ? (
        <EmptyState>Nothing is waiting for your push.</EmptyState>
      ) : (
        <ol>
          {rows.map((r) => (
            <CooRowLine key={r.id} row={r} board={board} onOpen={onOpen} onPush={setPushRow} concerns={concerns.data?.[r.id]} />
          ))}
        </ol>
      )}

      {confirm && valid && <PushSheet plan={plan} n={n} onClose={() => setConfirm(false)} />}
      {pushRow && <RowPushConfirm row={pushRow} onClose={() => setPushRow(null)} />}
    </section>
  );
}

/** Shown in Classic view where the old funding tab used to sit. */
export function RetiredFundNote() {
  return (
    <p className={`rounded-xl border px-3 py-2 text-sm ${statusGlass.idle}`}>
      <DecisionButton disabled className="mr-2" style={{ marginRight: 8 }} aria-disabled="true">
        Fund by score
      </DecisionButton>
      Retired 5 Nov — use Push top N.
    </p>
  );
}
