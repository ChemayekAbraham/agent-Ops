import { useEffect } from 'react';
import { fmt } from '../format';
import { statusText } from '../deskTheme';
import { Skeleton } from '../Skeleton';
import { ErrorLine } from '../ui';
import { MoneyFlowLines } from '../moneyFlow';
import { useIncompleteQueue } from '../incomplete';

/**
 * Under the Funders Dashboard's top tiles (desk `cfo`, also the boardroom
 * wall): the funders' money after release, the same lines as the Command
 * Centre (Op 5's MoneyFlowLines, funded_money_flow, every 30 s), and the
 * "Incomplete requests: N" line (pipeline_incomplete_queue). A skeleton while
 * loading and the server's words on a failure, never a zero it was not told.
 * On the wall view the lines are larger, to read across a room.
 */

export const INCOMPLETE_REFRESH_MS = 30_000;

const asIs = (e: unknown) => String((e as { message?: string } | null)?.message ?? e ?? 'Something went wrong.');
const notAuthorized = (e: unknown) => {
  const x = e as { code?: string; message?: string } | null;
  return x?.code === '42501' || /not authori[sz]ed|is for Agent Ops/i.test(String(x?.message ?? ''));
};

/** "Incomplete requests: 4", red while any is missing something. */
export function IncompleteLine({ board }: { board: boolean }) {
  const q = useIncompleteQueue();
  const { refetch } = q;
  // The hook polls every 60 s; this screen wants 30 s, as the money lines do.
  useEffect(() => {
    const t = window.setInterval(() => void refetch(), INCOMPLETE_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [refetch]);
  if (q.error && notAuthorized(q.error)) return null;
  const size = board ? 'text-xl' : 'text-xs';
  if (q.isLoading) {
    return (
      <div role="status" aria-label="Loading the incomplete requests" data-incomplete-line="loading">
        <Skeleton className={board ? 'h-6 w-72' : 'h-3.5 w-48'} />
      </div>
    );
  }
  if (q.error) return <ErrorLine>{asIs(q.error)}</ErrorLine>;
  if (!q.data) return null;
  const n = q.data.count;
  return (
    <span data-incomplete-line={n} data-tone={n > 0 ? 'bad' : 'ok'} className={`${size} ${n > 0 ? statusText.bad : statusText.ok}`} style={{ display: 'block' }}>
      Incomplete requests: {fmt('int', n)}
    </span>
  );
}

export function FundersMoneyLines({ board }: { board: boolean }) {
  return (
    <section
      aria-label="Funder money and incomplete requests"
      data-funders-money-lines
      // The wall view: every line at TV size, without touching Op 5's component. The desk kit pins
      // `.desk-root .text-sm` with !important, so this is important too and one element more specific.
      className={board ? 'space-y-2 [&_span[data-flow-line]]:!text-xl [&_span[data-flow-line]]:!leading-snug' : 'space-y-1'}
    >
      <IncompleteLine board={board} />
      <MoneyFlowLines board={board} />
    </section>
  );
}
