import { useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { CALM, FOCUS, statusText } from '../deskTheme';
import { DataList, EmptyState, ErrorLine, Fold, LoadingRows, Segmented, stackLayout, type DataColumn } from '../ui';
import { isMissingDbObject, logMissingOnce } from '../deskLive';
import { readableError } from '../reviewApi';
import { RULE_DESKS } from '../DeskRules';
import { eatTime, isCooOrCeo } from '../ontology/ontologyApi';
import {
  ACCOUNTABILITY_WINDOWS,
  EMPTY_ACCOUNTABILITY,
  groupByStage,
  isDenied,
  rateText,
  rateTone,
  sortAccountability,
  stageName,
  unfitShare,
  useAccountability,
  type AccountabilityRow,
  type AccountabilityWindow,
} from './accountabilityApi';

/**
 * "Accountability": who passed requests that a later desk found unfit.
 *
 * On a stage desk it sits below "Done today" for that desk's leads and for the
 * COO/CEO. Nobody can tell a lead apart on the page, so the server decides:
 * a caller `desk_accountability` refuses never sees the fold. On the command
 * centre (`deskId` null) it covers every desk, grouped by stage, and shows
 * only to the COO/CEO.
 */

export const RATE_CLASS = { bad: statusText.bad, plain: 'text-foreground', idle: 'text-muted-foreground' } as const;

const keyOf = (r: AccountabilityRow) => `${r.stage ?? ''}:${r.person_id ?? r.name ?? ''}`;
const int = (v: number | null | undefined) => Number(v ?? 0).toLocaleString('en');

/** The person's requests that a later desk found unfit: reason, request code, which desk, when. */
function PersonDetail({ r }: { r: AccountabilityRow }) {
  const items = r.items ?? [];
  return (
    <section
      className="desk-tile"
      style={{ ...stackLayout(6), padding: 12 }}
      aria-label={`Requests ${r.name ?? ''} passed that were later found unfit`}
    >
      <p className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
        {r.name ?? '—'}: {items.length.toLocaleString('en')} later found unfit
      </p>
      <ul style={{ ...stackLayout(4), margin: 0, padding: 0, listStyle: 'none' }}>
        {items.map((it, i) => (
          <li key={`${it.id ?? it.req}-${i}`} className="text-sm leading-snug text-foreground" style={{ overflowWrap: 'anywhere' }}>
            <span className="font-mono text-xs">{it.req ?? (it.id ? it.id.slice(0, 8) : '—')}</span> · {it.label ?? 'No reason given'}
            <span className="text-muted-foreground">
              {' '}
              · found by {stageName(it.found_on)}
              {it.found_at ? ` · ${eatTime(it.found_at)}` : ''}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Columns for the kit's DataList (a table from md up, cards below). On a card
 * the name is the title and the rate sits under it; staff ID and the two
 * counts go on the small line. The name opens the person's requests below the
 * list — DataList clamps cells to two lines, so they cannot open inside it.
 */
export function accountabilityColumns(open: string | null, toggle: (k: string) => void): DataColumn<AccountabilityRow>[] {
  return [
    {
      key: 'name',
      label: 'Name',
      priority: 1,
      text: (r) => r.name ?? '',
      render: (r) => {
        const k = keyOf(r);
        if (!(r.items ?? []).length) return r.name ?? '—';
        return (
          <button
            type="button"
            aria-expanded={open === k}
            onClick={() => toggle(k)}
            className={`rounded text-left text-foreground ${CALM} ${FOCUS}`}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minHeight: 32 }}
          >
            <ChevronRight
              className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open === k ? 'rotate-90' : ''}`}
              aria-hidden
            />
            {r.name ?? '—'}
          </button>
        );
      },
    },
    { key: 'staff', label: 'Staff ID', priority: 2, text: (r) => r.staff_ref ?? '', render: (r) => <span className="font-mono text-xs">{r.staff_ref ?? '—'}</span> },
    { key: 'passed', label: 'Passed', priority: 2, align: 'right', text: (r) => int(r.passed), render: (r) => int(r.passed) },
    { key: 'flagged', label: 'Later found unfit', priority: 2, align: 'right', text: (r) => int(r.flagged), render: (r) => int(r.flagged) },
    {
      key: 'rate',
      label: 'Rate',
      priority: 1,
      align: 'right',
      text: (r) => rateText(unfitShare(r)),
      render: (r) => {
        const share = unfitShare(r);
        const tone = rateTone(share);
        return (
          <span className={`font-medium tabular-nums ${RATE_CLASS[tone]}`} data-tone={tone} title="Share of passed requests later found unfit">
            {rateText(share)}
          </span>
        );
      },
    },
  ];
}

export function AccountabilityTable({
  rows,
  grouped = false,
  board = false,
  forceLayout,
}: {
  rows: AccountabilityRow[];
  grouped?: boolean;
  board?: boolean;
  /** Tests: pin the table or the cards regardless of width. */
  forceLayout?: 'table' | 'cards';
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (rows.length === 0) return <EmptyState board={board}>{EMPTY_ACCOUNTABILITY}</EmptyState>;
  const toggle = (k: string) => setOpen((cur) => (cur === k ? null : k));
  const columns = accountabilityColumns(open, toggle);
  const groups = grouped ? groupByStage(rows) : [{ stage: '', rows: sortAccountability(rows) }];
  return (
    <div style={stackLayout(16)}>
      {groups.map((g) => {
        const sel = g.rows.find((r) => keyOf(r) === open);
        return (
          <div key={g.stage || 'all'} style={stackLayout(8)}>
            {grouped && (
              <h3 className="text-sm font-semibold text-foreground" style={{ margin: 0 }}>
                {stageName(g.stage)}
              </h3>
            )}
            <DataList
              columns={columns}
              rows={g.rows}
              rowKey={keyOf}
              label={grouped ? `people at ${stageName(g.stage)}` : 'people'}
              emptyText={EMPTY_ACCOUNTABILITY}
              board={board}
              forceLayout={forceLayout}
            />
            {sel && <PersonDetail r={sel} />}
          </div>
        );
      })}
    </div>
  );
}

/** Mounted once per desk (below "Done today") and once on the command centre with `deskId` null. */
export function AccountabilityFold({ deskId, board }: { deskId: string | null; board: boolean }) {
  const { roles } = useAuth();
  const lead = isCooOrCeo(roles as readonly unknown[]);
  const [days, setDays] = useState<AccountabilityWindow>(30);
  const onDesk = deskId === null ? lead : RULE_DESKS.has(deskId);
  const q = useAccountability(deskId, days, onDesk);

  if (!onDesk) return null;
  if (q.error && isMissingDbObject(q.error)) {
    logMissingOnce('desk_accountability', q.error);
    return null;
  }
  // Not a lead on this desk and not COO/CEO: the server said no, so there is nothing to show.
  if (q.error && isDenied(q.error) && !lead) return null;
  // While the first answer is out, only the COO/CEO see the closed fold; a lead appears once the server says yes.
  if (!q.data && !q.error && !lead) return null;

  const rows = q.data?.rows ?? [];
  const red = rows.filter((r) => rateTone(unfitShare(r)) === 'bad').length;

  return (
    <Fold
      title={deskId === null ? 'Accountability — every desk' : 'Accountability'}
      count={q.data ? rows.filter((r) => Number(r.flagged ?? 0) > 0).length : undefined}
      countTone={red > 0 ? 'bad' : 'idle'}
      board={board}
      hint="Requests passed here that a later desk found unfit"
    >
      <Segmented
        options={ACCOUNTABILITY_WINDOWS.map((d) => ({ value: d, label: `${d} days` }))}
        value={days}
        onChange={(d) => d !== null && setDays(d)}
        ariaLabel="Accountability window"
      />
      {q.isLoading ? (
        <LoadingRows rows={3} height={28} label="Loading accountability" />
      ) : q.error ? (
        <ErrorLine>Accountability could not load: {readableError(q.error)}</ErrorLine>
      ) : (
        <AccountabilityTable rows={rows} grouped={deskId === null} board={board} />
      )}
    </Fold>
  );
}
