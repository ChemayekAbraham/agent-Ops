import { Fragment, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { CALM, FOCUS, LABEL, statusText } from '../deskTheme';
import { EmptyState, ErrorLine, Fold, LoadingRows, Segmented, stackLayout } from '../ui';
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

const HEAD: { label: string; right?: boolean }[] = [
  { label: 'Name' },
  { label: 'Staff ID' },
  { label: 'Passed', right: true },
  { label: 'Later found unfit', right: true },
  { label: 'Rate', right: true },
];

function PersonRow({ r }: { r: AccountabilityRow }) {
  const [open, setOpen] = useState(false);
  const items = r.items ?? [];
  const share = unfitShare(r);
  const tone = rateTone(share);
  const cell = 'px-2 py-1.5';
  return (
    <Fragment>
      <tr className="desk-row border-t border-[var(--desk-line-color)] align-top">
        <td className={cell}>
          {items.length > 0 ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className={`rounded text-left text-foreground ${CALM} ${FOCUS}`}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              <ChevronRight
                className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${open ? 'rotate-90' : ''}`}
                aria-hidden
              />
              {r.name ?? '—'}
            </button>
          ) : (
            <span className="text-foreground" style={{ paddingLeft: 18 }}>
              {r.name ?? '—'}
            </span>
          )}
        </td>
        <td className={`${cell} font-mono text-xs text-muted-foreground`}>{r.staff_ref ?? '—'}</td>
        <td className={`${cell} text-right tabular-nums text-foreground`}>{Number(r.passed ?? 0).toLocaleString('en')}</td>
        <td className={`${cell} text-right tabular-nums text-foreground`}>{Number(r.flagged ?? 0).toLocaleString('en')}</td>
        <td className={`${cell} text-right tabular-nums font-medium ${RATE_CLASS[tone]}`} data-tone={tone}>
          {rateText(share)}
        </td>
      </tr>
      {open && items.length > 0 && (
        <tr>
          <td colSpan={HEAD.length} className="px-2 pb-3">
            <ul style={{ ...stackLayout(4), margin: 0, paddingLeft: 18, listStyle: 'none' }} aria-label={`Requests ${r.name ?? ''} passed that were later found unfit`}>
              {items.map((it, i) => (
                <li key={`${it.id ?? it.req}-${i}`} className="text-sm leading-snug text-foreground">
                  <span className="font-mono text-xs">{it.req ?? (it.id ? it.id.slice(0, 8) : '—')}</span> · {it.label ?? 'No reason given'}
                  <span className="text-muted-foreground">
                    {' '}
                    · found by {stageName(it.found_on)}
                    {it.found_at ? ` · ${eatTime(it.found_at)}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </Fragment>
  );
}

export function AccountabilityTable({ rows, grouped = false }: { rows: AccountabilityRow[]; grouped?: boolean }) {
  if (rows.length === 0) return <EmptyState>{EMPTY_ACCOUNTABILITY}</EmptyState>;
  const groups = grouped ? groupByStage(rows) : [{ stage: '', rows: sortAccountability(rows) }];
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead className="desk-thead">
          <tr>
            {HEAD.map((h) => (
              <th key={h.label} className={`${LABEL} whitespace-nowrap px-2 py-1.5 font-medium ${h.right ? 'text-right' : ''}`}>
                {h.label}
              </th>
            ))}
          </tr>
        </thead>
        {groups.map((g) => (
          <tbody key={g.stage || 'all'}>
            {grouped && (
              <tr>
                <th colSpan={HEAD.length} scope="rowgroup" className="px-2 pb-1 pt-3 text-left text-sm font-semibold text-foreground">
                  {stageName(g.stage)}
                </th>
              </tr>
            )}
            {g.rows.map((r, i) => (
              <PersonRow key={`${r.person_id ?? r.name}-${i}`} r={r} />
            ))}
          </tbody>
        ))}
      </table>
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
        <AccountabilityTable rows={rows} grouped={deskId === null} />
      )}
    </Fold>
  );
}
