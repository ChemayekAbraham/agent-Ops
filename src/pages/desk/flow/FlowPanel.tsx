import { LABEL, TILE } from '../deskTheme';
import { Card, ErrorLine, LoadingRows, TILE_PAD, atLeast, moneyFull, stackLayout, useBreakpoint } from '../ui';
import { isMissingDbObject, logMissingOnce } from '../deskLive';
import { readableError } from '../reviewApi';
import { isDenied } from '../accountability/accountabilityApi';
import {
  FLOW_DESKS,
  FLOW_PERIODS,
  countText,
  flowColumns,
  flowHint,
  outBreakdown,
  ugxShort,
  useDeskFlow,
  type DeskFlow,
  type FlowPeriod,
} from './flowApi';

/**
 * The COO's IN / OUT sketch, directly under "Ready for your push":
 *
 *   Today (24 h)   7 days        90 days       All time
 *   ┌──────┬────┬─────┐  …
 *   │      │ IN │ OUT │
 *   │Count │ 12 │  9  │
 *   │UGX   │4.2M│3.1M │
 *   └──────┴────┴─────┘
 *
 * Phones 2×2, four across from md. Each period is a tile-style cell holding a
 * small table; UGX shows short with the full figure on hover.
 */

const cellText = { fontVariantNumeric: 'tabular-nums' as const, padding: '3px 2px', whiteSpace: 'nowrap' as const };
/** Row and column labels: a step smaller than the figures. */
const labelText = { ...cellText, fontSize: '0.85em' };

function PeriodCell({ label, p, deskId, board }: { label: string; p: FlowPeriod | null | undefined; deskId: string; board: boolean }) {
  const out = outBreakdown(p, deskId);
  return (
    <div
      className={TILE}
      data-period={label}
      style={{ ...stackLayout(6), padding: TILE_PAD, minWidth: 0, containerType: 'inline-size' }}
    >
      <div className={`${LABEL} font-medium`}>{label}</div>
      {/* Sized to the cell (a size container), so four figures fit a phone's quarter and grow on a desktop. */}
      <table
        className="w-full"
        style={{ borderCollapse: 'collapse', tableLayout: 'fixed', width: '100%', fontSize: board ? 'clamp(13px, 11cqi, 18px)' : 'clamp(11px, 10.5cqi, 15px)' }}
      >
        <caption className="sr-only">{`${label}: in and out`}</caption>
        <colgroup>
          <col style={{ width: '28%' }} />
          <col style={{ width: '36%' }} />
          <col style={{ width: '36%' }} />
        </colgroup>
        <thead>
          <tr>
            <td />
            <th scope="col" className="font-semibold text-muted-foreground" style={{ ...labelText, textAlign: 'right' }}>
              IN
            </th>
            <th scope="col" className="font-semibold text-muted-foreground" style={{ ...labelText, textAlign: 'right' }}>
              OUT
            </th>
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-[var(--desk-line-soft)]">
            <th scope="row" className="font-normal text-muted-foreground" style={{ ...labelText, textAlign: 'left' }}>
              Count
            </th>
            <td className="font-semibold text-foreground" style={{ ...cellText, textAlign: 'right' }} data-cell="in-count">
              {countText(p?.in_n)}
            </td>
            <td className="font-semibold text-foreground" style={{ ...cellText, textAlign: 'right' }} title={out ?? undefined} data-cell="out-count">
              {countText(p?.out_n)}
            </td>
          </tr>
          <tr className="border-t border-[var(--desk-line-soft)]">
            <th scope="row" className="font-normal text-muted-foreground" style={{ ...labelText, textAlign: 'left' }}>
              UGX
            </th>
            <td className="text-foreground" style={{ ...cellText, textAlign: 'right' }} title={moneyFull(p?.in_ugx)} aria-label={moneyFull(p?.in_ugx)} data-cell="in-ugx">
              {ugxShort(p?.in_ugx)}
            </td>
            <td className="text-foreground" style={{ ...cellText, textAlign: 'right' }} title={moneyFull(p?.out_ugx)} aria-label={moneyFull(p?.out_ugx)} data-cell="out-ugx">
              {ugxShort(p?.out_ugx)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** The four cells, from data already in hand. `mdUp` picks 4 across over 2×2. */
export function FlowGrid({ flow, deskId, board, mdUp }: { flow: DeskFlow | null | undefined; deskId: string; board: boolean; mdUp: boolean }) {
  const cols = flowColumns(mdUp);
  return (
    <div
      data-flow-columns={cols}
      style={{ display: 'grid', gap: 'var(--desk-space-3, 12px)', gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, minWidth: 0 }}
    >
      {FLOW_PERIODS.map((per) => (
        <PeriodCell key={per.key} label={per.label} p={flow?.periods?.[per.key]} deskId={deskId} board={board} />
      ))}
    </div>
  );
}

/** Mounted once per desk under "Ready for your push", and on the command centre with `deskId="command"`. */
export function FlowPanel({ deskId, board }: { deskId: string; board: boolean }) {
  const on = FLOW_DESKS.has(deskId);
  const q = useDeskFlow(on ? deskId : null);
  const mdUp = atLeast(useBreakpoint(), 'md');
  if (!on) return null;
  if (q.error && isMissingDbObject(q.error)) {
    logMissingOnce('desk_flow', q.error);
    return null;
  }
  // A viewer the server does not let read this desk's flow sees nothing, not an error.
  if (q.error && isDenied(q.error)) return null;

  return (
    <Card title="In and out" hint={flowHint(deskId)} board={board} ariaLabel="In and out" busy={q.isFetching}>
      {q.isLoading ? (
        <LoadingRows rows={1} height={mdUp ? 96 : 200} label="Loading in and out" />
      ) : q.error ? (
        <ErrorLine>In and out could not load: {readableError(q.error)}</ErrorLine>
      ) : (
        <FlowGrid flow={q.data} deskId={deskId} board={board} mdUp={mdUp} />
      )}
    </Card>
  );
}
